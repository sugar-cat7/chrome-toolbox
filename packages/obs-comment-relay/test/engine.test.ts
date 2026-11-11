import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Ok, type RelayComment, type Result } from '@chrome-toolbox/contracts';
import type { RelayOptions, RelayPipeline } from '@chrome-toolbox/extension-core/relay';
import { createEngine } from '../src/engine';
import { nativeResultFetch } from '../src/native-transport';

const mocks = vi.hoisted(() => ({
  channels: [] as { onmessage?: (message: unknown) => void }[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn<typeof invoke>(),
  Channel: class {
    onmessage?: (message: unknown) => void;
    constructor() {
      mocks.channels.push(this);
    }
  },
}));

const SESSION = '5a78ed3a-a355-4bef-8fc6-238505f23858';
const BATCH = 'ce65017d-1c12-4ca4-af5c-1b9713580485';
const TOKEN = '9b2f0d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const STATUS = {
  v: 1,
  sessionId: SESSION,
  source: 'stopped',
  inference: 'idle',
  counters: { accepted: 0, dropped: 0, published: 0, filtered: 0, failed: 0 },
};
const SETTINGS = {
  schemaVersion: 1,
  mode: 'external',
  baseUrl: 'http://127.0.0.1:8080',
  models: { clef: null, plamo: null },
  filterStrength: 'normal',
  translate: true,
  sourceLanguage: 'auto',
  targetLanguage: 'ja',
  display: 'both',
  maxItems: 20,
  overlayPort: 8787,
  overlayToken: TOKEN,
};
const ATTACHMENT = { status: STATUS, generation: 7, sourceSessionId: null };

function fakePipeline() {
  const ingest = vi.fn<RelayPipeline['ingest']>(async (input) =>
    Ok({ batchId: input.batchId, accepted: input.comments.length, dropped: 0 }),
  );
  const reset = vi.fn<RelayPipeline['reset']>();
  const dispose = vi.fn<RelayPipeline['dispose']>();
  let publish: RelayOptions['publish'] | undefined;
  const pipeline: RelayPipeline = {
    ingest,
    status: () => ({ accepted: 0, dropped: 0, published: 0, filtered: 0, failed: 0 }),
    reset,
    dispose,
  };
  const factory = vi.fn<(options: RelayOptions) => RelayPipeline>((options) => {
    publish = options.publish;
    return pipeline;
  });
  return {
    pipeline,
    factory,
    ingest,
    reset,
    dispose,
    publish: (c: readonly RelayComment[]) => publish?.([...c]),
  };
}

function mockCommands(extra: Record<string, unknown> = {}) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    const replies: Record<string, unknown> = {
      attach_engine: ATTACHMENT,
      get_settings: SETTINGS,
      get_status: STATUS,
      ack_chat_batch: undefined,
      publish_comments: undefined,
      ...extra,
    };
    return replies[command];
  });
}

describe('engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channels.length = 0;
  });

  it('attaches the channel, builds the pipeline from settings and acks batches', async () => {
    mockCommands();
    const fake = fakePipeline();
    const engine = createEngine({ createPipeline: fake.factory });
    const attached = await engine.attach();
    expect(attached).toMatchObject({ ok: true, value: { generation: 7 } });
    expect(fake.factory).toHaveBeenCalledTimes(1);

    const channel = mocks.channels[0];
    expect(channel?.onmessage).toBeTypeOf('function');
    channel?.onmessage?.({
      kind: 'chat-batch',
      sessionId: SESSION,
      generation: 7,
      batchId: BATCH,
      site: 'youtube',
      channel: 'video-id',
      comments: [
        { comment: { id: 'c1', author: 'a', text: 'hello', at: 1 }, receivedAt: 2, seq: 1 },
      ],
    });
    await vi.waitFor(() => {
      expect(fake.ingest).toHaveBeenCalledWith({
        sessionId: SESSION,
        batchId: BATCH,
        site: 'youtube',
        channel: 'video-id',
        comments: [{ id: 'c1', author: 'a', text: 'hello', at: 1 }],
      });
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('ack_chat_batch', {
        input: { sessionId: SESSION, generation: 7, batchId: BATCH },
      });
    });
  });

  it('maps settings-changed onto pipeline reset with the strength threshold', async () => {
    mockCommands();
    const fake = fakePipeline();
    const engine = createEngine({ createPipeline: fake.factory });
    await engine.attach();
    mocks.channels[0]?.onmessage?.({
      kind: 'settings-changed',
      sessionId: SESSION,
      generation: 8,
      settings: {
        mode: 'external',
        baseUrl: 'http://127.0.0.1:8080',
        filterStrength: 'strict',
        translate: false,
        sourceLanguage: 'en',
        targetLanguage: 'ja',
      },
    });
    expect(fake.reset).toHaveBeenCalledWith({
      sessionId: SESSION,
      threshold: 0.7,
      translate: false,
      sourceLang: 'en',
    });
  });

  it('resets the pipeline session on source-reset and disposes on stop', async () => {
    mockCommands();
    const fake = fakePipeline();
    const engine = createEngine({ createPipeline: fake.factory });
    await engine.attach();
    const channel = mocks.channels[0];
    channel?.onmessage?.({
      kind: 'source-reset',
      sessionId: SESSION,
      generation: 9,
      sourceSessionId: null,
      site: null,
      channel: null,
    });
    expect(fake.reset).toHaveBeenCalledWith({ sessionId: SESSION });
    channel?.onmessage?.({ kind: 'stop', sessionId: SESSION, generation: 10 });
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards published comments through publish_comments with the live generation', async () => {
    mockCommands();
    const fake = fakePipeline();
    const engine = createEngine({ createPipeline: fake.factory });
    await engine.attach();
    const comment: RelayComment = {
      v: 1,
      sessionId: SESSION,
      id: 'c1',
      seq: 1,
      site: 'youtube',
      channel: 'video-id',
      author: 'a',
      original: 'hi',
      translation: 'こんにちは',
      translationState: 'translated',
      at: 1,
      receivedAt: 2,
      publishedAt: 3,
      filter: { verdict: 'allowed', probability: 0.1 },
      translator: 'plamo-3-translate-2b',
    };
    fake.publish([comment]);
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('publish_comments', {
        input: { sessionId: SESSION, generation: 7, comments: [comment] },
      });
    });
  });
});

describe('nativeResultFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps chat completions onto the plamo operation and rebuilds the response', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"choices":[]}',
    });
    const result: Result<Response> = await nativeResultFetch(
      'http://127.0.0.1:1/v1/chat/completions',
      {
        method: 'POST',
        body: '{"model":"plamo-3-translate-2b"}',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a response');
    expect(result.value.status).toBe(200);
    await expect(result.value.json()).resolves.toEqual({ choices: [] });
    expect(invoke).toHaveBeenCalledWith(
      'llama_request',
      expect.objectContaining({
        input: expect.objectContaining({
          operation: 'plamo',
          body: { model: 'plamo-3-translate-2b' },
        }),
      }),
    );
  });

  it('maps systemone onto clef and rejects unmapped paths without invoking', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ status: 200, headers: {}, body: '{}' });
    const clef = await nativeResultFetch('http://127.0.0.1:1/v1/systemone', { method: 'POST' });
    expect(clef.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'llama_request',
      expect.objectContaining({
        input: expect.objectContaining({ operation: 'clef', body: null }),
      }),
    );

    const denied = await nativeResultFetch('http://127.0.0.1:1/props', {});
    expect(denied.ok).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('returns operation_cancelled for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await nativeResultFetch('http://127.0.0.1:1/health', {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, error: { internalCode: 'operation_cancelled' } });
    expect(invoke).not.toHaveBeenCalled();
  });
});
