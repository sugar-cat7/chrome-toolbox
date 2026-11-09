import { Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  ASR_TIMEOUT_MS,
  createAsrClient,
  createLlamaClient,
  createQueue,
  type Fetch,
  type Timers,
} from '@chrome-toolbox/extension-core';
import type { Capture, CaptureDeps } from './audio/capture.ts';
import { createLivePipeline, type LiveConfig, type LivePipeline } from './audio/live-pipeline.ts';
import type { FrontState } from './front.ts';
import { createLineTranslator, type LineTranslator } from './line-translator.ts';
import {
  addressed,
  AUDIO_FAILURES,
  isFor,
  offscreenProtocol,
  subtitleProtocol,
  type AudioFailure,
  type OffscreenProtocolHandlers,
} from './protocol.ts';

/** Ten minutes without processing release the capture (user decision 2026-11-05). */
export const IDLE_RELEASE_MS = 600_000;

/** The part of `runtime.MessageSender` the offscreen document checks. */
export type OffscreenSender = Readonly<{
  id?: string | undefined;
  url?: string | undefined;
  tab?: Readonly<{ id?: number | undefined }> | undefined;
}>;
type MessageListener = (
  message: unknown,
  sender: OffscreenSender,
  sendResponse: (response: unknown) => void,
) => true | undefined;

/** `chrome.runtime`, the only extension API an offscreen document has (Task 13 Step 0). */
export type OffscreenRuntime = {
  readonly id: string;
  getURL(this: void, path: string): string;
  onMessage: {
    addListener(listener: MessageListener): void;
    removeListener(listener: MessageListener): void;
  };
  sendMessage(this: void, message: unknown): Promise<unknown>;
};

type PipelineDeps = Parameters<typeof createLivePipeline>[0];

/** One capture: the tab, its audio and live pipeline, and what they follow. */
type Session = {
  readonly tabId: number;
  readonly startedAt: number;
  readonly capture: Capture;
  readonly pipeline: LivePipeline;
  readonly translator: LineTranslator;
  /** Read by the pipeline and the line translator on each request. */
  readonly live: { config: LiveConfig };
  front: FrontState;
  /** Set while the capture is not active, until the release is reported. */
  idle: number | undefined;
};

const AWAY: FrontState = { state: 'away' };
const isAudioFailure = (code: string): code is AudioFailure =>
  AUDIO_FAILURES.some((known) => known === code);
const unavailable = (): Promise<Result<never>> =>
  Promise.resolve(Err(failure('state_unavailable')));

/**
 * The offscreen document: it captures one tab's audio (`audio/start`, with the stream id the
 * service worker took) and runs the live pipeline on it. It answers only messages addressed to it
 * (`offscreen`) by this extension's service worker, and reports to the service worker the lines
 * (`audio/lines`), its state on each front change (`audio/status`), ten minutes without being
 * active (`audio/idle`) and a server that lost its audio projector (`audio/failed`).
 *
 * The capture starts `away` and follows `audio/front`, calling `pipeline.mode` on every change of
 * state:
 * - `active`: the VAD is reset (its floor filled with silence meanwhile), then the input connects;
 * - `pause`: the pipeline pauses before the flush, so the segment the flush closes still runs,
 *   then the input disconnects;
 * - `away`: the input disconnects and the VAD drops its open segment, then the pipeline drops what
 *   waits.
 *
 * The LLM client is its own (8 s timeout, one request at a time); translations go through the line
 * translator of the config's `translator` (Task 8). Returns the cleanup of the listener and the
 * capture.
 */
export function startOffscreen({
  runtime,
  startCapture,
  createPipeline = createLivePipeline,
  fetch,
  timers,
  now,
}: {
  runtime: OffscreenRuntime;
  startCapture: (deps: CaptureDeps) => Promise<Result<Capture>>;
  createPipeline?: (deps: PipelineDeps) => LivePipeline;
  fetch: Fetch;
  timers: Timers;
  /** The clock of the segments' `endedAt` (`performance.timeOrigin + performance.now()`). */
  now: () => number;
}): () => void {
  const backgroundUrl = runtime.getURL('/background.js');
  let session: Session | undefined;

  const fromBackground = (sender: OffscreenSender): boolean =>
    sender.id === runtime.id && sender.tab === undefined && sender.url === backgroundUrl;
  const deliver = (message: unknown): Promise<unknown> =>
    runtime.sendMessage(addressed('background', message));
  /** A report the service worker may not take: the next one tells it again. */
  function notify(sending: () => Promise<unknown>): void {
    launch(
      async () => {
        await sending();
      },
      () => undefined,
    );
  }

  function armIdle(at: Session): void {
    if (at.idle !== undefined) return;
    at.idle = timers.set(() => {
      at.idle = undefined;
      if (session === at)
        notify(() => subtitleProtocol.send(deliver, 'audio/idle', { tabId: at.tabId }));
    }, IDLE_RELEASE_MS);
  }
  function clearIdle(at: Session): void {
    if (at.idle !== undefined) timers.clear(at.idle);
    at.idle = undefined;
  }

  function release(): void {
    const ending = session;
    if (ending === undefined) return;
    session = undefined;
    clearIdle(ending);
    ending.pipeline.dispose();
    ending.capture.stop();
  }

  function follow(at: Session, front: FrontState): void {
    const before = at.front.state;
    at.front = front;
    if (front.state === before) return;
    switch (front.state) {
      case 'active':
        at.capture.discard();
        at.pipeline.mode('active');
        at.capture.input(true);
        clearIdle(at);
        break;
      case 'pause':
        at.pipeline.mode('pause');
        at.capture.flush();
        at.capture.input(false);
        armIdle(at);
        break;
      case 'away':
        at.capture.input(false);
        at.capture.discard();
        at.pipeline.mode('away');
        armIdle(at);
        break;
    }
    notify(() =>
      subtitleProtocol.send(deliver, 'audio/status', {
        tabId: at.tabId,
        status: { state: front.state },
      }),
    );
  }

  const handlers: OffscreenProtocolHandlers = {
    'audio/start': async ({
      tabId,
      streamId,
      settings,
      config,
    }): Promise<Result<Record<string, never>>> => {
      release();
      const client = createLlamaClient({
        baseUrl: settings.baseUrl,
        fetch,
        queue: createQueue({ concurrency: 1, maxPending: 4 }),
        timeoutMs: ASR_TIMEOUT_MS,
      });
      const live = { config };
      const translator = createLineTranslator({
        client,
        config: () => ({ translator: live.config.translator, model: settings.models.translate }),
      });
      let failed = false;
      const pipeline = createPipeline({
        asr: createAsrClient({ client, model: () => settings.models.asr }),
        translate: async (input): Promise<Result<string>> => {
          const line = await translator.translate(input);
          return line.ok ? Ok(line.value.ja) : line;
        },
        config: () => live.config,
        emit: (line) =>
          notify(() => subtitleProtocol.send(deliver, 'audio/lines', { tabId, lines: [line] })),
        now,
        timers,
        // Only a server that lost its projector ends the capture; other failures are counted.
        onFailure: (error) => {
          const code = error.internalCode;
          if (failed || !isAudioFailure(code)) return;
          failed = true;
          notify(() => subtitleProtocol.send(deliver, 'audio/failed', { tabId, code }));
        },
      });
      pipeline.mode('away');
      // The stream id expires within seconds: it is used before anything else waits.
      const started = await startCapture({
        streamId,
        workletUrl: runtime.getURL('/pcm-worklet.js'),
        onSegment: (segment) => pipeline.push(segment),
      });
      if (!started.ok) {
        pipeline.dispose();
        return started;
      }
      const at: Session = {
        tabId,
        startedAt: now(),
        capture: started.value,
        pipeline,
        translator,
        live,
        front: AWAY,
        idle: undefined,
      };
      session = at;
      armIdle(at);
      return Ok({});
    },
    'audio/config': ({ config }) => {
      if (session === undefined) return unavailable();
      session.live.config = config;
      return Promise.resolve(Ok({}));
    },
    'audio/front': ({ front }) => {
      if (session === undefined) return unavailable();
      follow(session, front);
      return Promise.resolve(Ok({}));
    },
    'audio/reset': () => {
      if (session === undefined) return unavailable();
      session.pipeline.reset();
      session.capture.discard();
      return Promise.resolve(Ok({}));
    },
    'audio/stop': () => {
      release();
      return Promise.resolve(Ok({}));
    },
    'audio/state': () =>
      session === undefined
        ? unavailable()
        : Promise.resolve(
            Ok({
              tabId: session.tabId,
              startedAt: session.startedAt,
              front: session.front,
              stats: session.pipeline.stats(),
              translator: session.translator.status(),
            }),
          ),
  };
  const route = offscreenProtocol.route(handlers);

  /** Takes only what the service worker addressed to the offscreen document; others answer. */
  function onMessage(
    message: unknown,
    sender: OffscreenSender,
    sendResponse: (response: unknown) => void,
  ): true | undefined {
    if (!isFor('offscreen', message) || !fromBackground(sender)) return undefined;
    launch(
      async () => {
        sendResponse(await route(message));
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }
  runtime.onMessage.addListener(onMessage);
  return () => {
    runtime.onMessage.removeListener(onMessage);
    release();
  };
}
