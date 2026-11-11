import { Channel, invoke } from '@tauri-apps/api/core';
import {
  capture,
  capturePublic,
  decode,
  launch,
  publicFailure,
  type PublicError,
  type RawChatComment,
  type RelayComment,
  type Result,
} from '@chrome-toolbox/contracts';
import {
  createClefJudge,
  createLlamaClient,
  createQueue,
  type ResultFetch,
} from '@chrome-toolbox/extension-core';
import {
  createRelayPipeline,
  RELAY_THRESHOLDS,
  type RelayOptions,
  type RelayPipeline,
} from '@chrome-toolbox/extension-core/relay';
import {
  engineAttachmentSchema,
  settingsSchema,
  type EngineAttachment,
  type Settings,
} from './native';
import { nativeResultFetch } from './native-transport';

export type EngineSettings = Readonly<{
  mode: 'managed' | 'external';
  baseUrl: string;
  filterStrength: 'mild' | 'normal' | 'strict';
  translate: boolean;
  sourceLanguage: string;
  targetLanguage: string;
}>;

type EngineInput =
  | Readonly<{
      kind: 'chat-batch';
      sessionId: string;
      generation: number;
      batchId: string;
      site: 'youtube' | 'twitch';
      channel: string;
      comments: readonly Readonly<{ comment: RawChatComment; receivedAt: number; seq: number }>[];
    }>
  | Readonly<{
      kind: 'source-reset';
      sessionId: string;
      generation: number;
      sourceSessionId: string | null;
      site: 'youtube' | 'twitch' | null;
      channel: string | null;
    }>
  | Readonly<{
      kind: 'settings-changed';
      sessionId: string;
      generation: number;
      settings: EngineSettings;
    }>
  | Readonly<{ kind: 'stop'; sessionId: string; generation: number }>;

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type EngineDeps = Readonly<{
  invoke?: Invoke;
  resultFetch?: ResultFetch;
  createPipeline?: (options: RelayOptions) => RelayPipeline;
}>;

export type Engine = Readonly<{
  attach(this: void): Promise<Result<EngineAttachment, PublicError>>;
  dispose(this: void): void;
}>;

/** Base URL is a placeholder: nativeResultFetch maps the path onto the proxy's operation allowlist. */
const TRANSPORT_BASE = 'http://127.0.0.1:1';

function engineSettingsOf(settings: Settings): EngineSettings {
  return {
    mode: settings.mode,
    baseUrl: settings.baseUrl,
    filterStrength: settings.filterStrength,
    translate: settings.translate,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
  };
}

export function createEngine(deps: EngineDeps = {}): Engine {
  const call: Invoke = deps.invoke ?? ((command, args) => invoke<unknown>(command, args ?? {}));
  const resultFetch = deps.resultFetch ?? nativeResultFetch;
  const pipelineFactory = deps.createPipeline ?? createRelayPipeline;

  let disposed = false;
  let pipeline: RelayPipeline | undefined;
  let settings: EngineSettings | undefined;
  let sessionId = '';
  let generation = 0;
  let lastAttachment: EngineAttachment | undefined;

  function buildPipeline(next: EngineSettings): void {
    pipeline?.dispose();
    const queue = createQueue();
    const judge = createClefJudge({
      baseUrl: TRANSPORT_BASE,
      model: 'clef-flash',
      queue,
      resultFetch,
    });
    const plamo = createLlamaClient({ baseUrl: TRANSPORT_BASE, resultFetch });
    const revision = `${next.mode}:${next.baseUrl}`;
    pipeline = pipelineFactory({
      sessionId,
      judge,
      plamo,
      threshold: RELAY_THRESHOLDS[next.filterStrength],
      translate: next.translate,
      sourceLang: next.sourceLanguage,
      clefRevision: revision,
      plamoRevision: revision,
      ...(next.mode === 'managed' ? { plamoSlot: 0 } : {}),
      publish(comments: RelayComment[]) {
        launch(
          async () => {
            await call('publish_comments', {
              input: { sessionId, generation, comments },
            });
          },
          () => undefined,
        );
      },
      now: () => Date.now(),
    });
  }

  async function ingestBatch(
    input: Extract<EngineInput, { kind: 'chat-batch' }>,
  ): Promise<Result<unknown, PublicError>> {
    if (!pipeline && settings) buildPipeline(settings);
    const active = pipeline;
    if (active) {
      const captured = await capture(
        () =>
          active.ingest({
            sessionId: input.sessionId,
            batchId: input.batchId,
            site: input.site,
            channel: input.channel,
            comments: input.comments.map((entry) => entry.comment),
          }),
        'ipc_failed',
      );
      if (!captured.ok) return { ok: false, error: publicFailure(captured.error) };
      if (!captured.value.ok) {
        return { ok: false, error: publicFailure(captured.value.error) };
      }
    }
    return capturePublic(
      () =>
        call('ack_chat_batch', {
          input: {
            sessionId: input.sessionId,
            generation: input.generation,
            batchId: input.batchId,
          },
        }),
      'ipc_failed',
    );
  }

  function route(input: EngineInput): void {
    if (disposed) return;
    sessionId = input.sessionId;
    generation = input.generation;
    switch (input.kind) {
      case 'chat-batch':
        launch(
          async () => {
            const result = await ingestBatch(input);
            // A refused ingest is counted by the Rust side once the ack never arrives.
            if (!result.ok) return;
          },
          () => undefined,
        );
        return;
      case 'source-reset':
        pipeline?.reset({ sessionId: input.sessionId });
        return;
      case 'settings-changed': {
        const previous = settings;
        settings = input.settings;
        if (!pipeline) return;
        if (
          previous &&
          (previous.mode !== input.settings.mode || previous.baseUrl !== input.settings.baseUrl)
        ) {
          buildPipeline(input.settings);
        } else {
          pipeline.reset({
            sessionId: input.sessionId,
            threshold: RELAY_THRESHOLDS[input.settings.filterStrength],
            translate: input.settings.translate,
            sourceLang: input.settings.sourceLanguage,
          });
        }
        return;
      }
      case 'stop':
        pipeline?.dispose();
        pipeline = undefined;
        return;
    }
  }

  async function attach(): Promise<Result<EngineAttachment, PublicError>> {
    if (lastAttachment) return { ok: true, value: lastAttachment };
    const channel = new Channel<EngineInput>();
    channel.onmessage = (input: EngineInput) => route(input);
    const attachedResult = await capturePublic(
      () => call('attach_engine', { channel }),
      'ipc_failed',
    );
    if (!attachedResult.ok) return { ok: false, error: attachedResult.error };
    const parsed = decode(engineAttachmentSchema, attachedResult.value);
    if (!parsed.ok) return { ok: false, error: publicFailure(parsed.error) };
    lastAttachment = parsed.value;
    sessionId = parsed.value.status.sessionId;
    generation = parsed.value.generation;
    const loadedResult = await capturePublic(() => call('get_settings'), 'ipc_failed');
    if (loadedResult.ok) {
      const loaded = decode(settingsSchema, loadedResult.value);
      if (loaded.ok) {
        settings = engineSettingsOf(loaded.value);
        buildPipeline(settings);
      }
    }
    return { ok: true, value: parsed.value };
  }

  return {
    attach,
    dispose() {
      disposed = true;
      pipeline?.dispose();
      pipeline = undefined;
      lastAttachment = undefined;
    },
  };
}
