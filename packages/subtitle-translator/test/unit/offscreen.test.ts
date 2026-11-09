import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { systemTimers, type Fetch } from '@chrome-toolbox/extension-core';
import { readSegment, type Capture, type CaptureDeps } from '../../src/audio/capture.ts';
import type {
  LiveConfig,
  LivePipeline,
  LiveStats,
  createLivePipeline,
} from '../../src/audio/live-pipeline.ts';
import { startOffscreen, type OffscreenSender } from '../../src/offscreen.ts';
import type { LiveLine } from '../../src/protocol.ts';

type PipelineDeps = Parameters<typeof createLivePipeline>[0];
type Listener = (
  message: unknown,
  sender: OffscreenSender,
  sendResponse: (response: unknown) => void,
) => true | undefined;

const CONFIG: LiveConfig = {
  display: 'both',
  sourceLang: 'auto',
  context: 'Title: Fixture Quest day 3\nChannel: Fixture Ch',
  glossary: [],
  translator: 'gemma',
};
const SETTINGS = {
  baseUrl: 'http://127.0.0.1:18083',
  models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'asr-fixture' },
};
const START = {
  type: 'audio/start',
  target: 'offscreen',
  payload: { tabId: 7, streamId: 'stream-1', settings: SETTINGS, config: CONFIG },
};
const STATS: LiveStats = {
  segments: 0,
  silent: 0,
  dropped: 0,
  expired: 0,
  skipped: 0,
  failed: 0,
};
const LINE: LiveLine = {
  sentenceId: 'live:1',
  lang: 'en',
  source: 'Okay chat.',
  state: 'pending',
  endedAt: 5,
  final: true,
};
const to = (type: string, payload: unknown = {}) => ({ type, target: 'offscreen', payload });
const front = (state: string) => to('audio/front', { front: { state } });
/** What `deliver` gives back when the listener did not take the message. */
const IGNORED = Symbol('ignored');

type Sent = { type: string; payload: unknown; target: unknown };
const isSent = (message: unknown): message is Sent =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string' &&
  'payload' in message &&
  'target' in message;

/**
 * The offscreen document with a fake capture and a fake pipeline that log their calls; the LLM
 * client and the line translator are real, over `fetch`.
 */
function setup({
  started,
  fetch = vi.fn<Fetch>(async () => new Response('', { status: 503 })),
}: { started?: Result<never>; fetch?: Fetch } = {}) {
  const calls: string[] = [];
  const sent: Sent[] = [];
  let listener: Listener | undefined;
  let pipelineDeps: PipelineDeps | undefined;
  let captureDeps: CaptureDeps | undefined;
  const capture: Capture = {
    input: (on) => calls.push(on ? 'input:on' : 'input:off'),
    flush: () => calls.push('flush'),
    discard: () => calls.push('discard'),
    stop: () => calls.push('stop'),
  };
  const pipeline: LivePipeline = {
    push: (segment) => calls.push(`push:${segment.durationMs}`),
    mode: (kind) => calls.push(`mode:${kind}`),
    reset: () => calls.push('reset'),
    stats: () => STATS,
    dispose: () => calls.push('dispose'),
  };
  const stop = startOffscreen({
    runtime: {
      id: fakeBrowser.runtime.id,
      getURL: (path) => fakeBrowser.runtime.getURL(path),
      onMessage: {
        addListener: (added) => {
          listener = added;
        },
        removeListener: (removed) => {
          if (listener === removed) listener = undefined;
        },
      },
      sendMessage: async (message) => {
        if (isSent(message)) sent.push(message);
        return Ok({});
      },
    },
    startCapture: async (deps) => {
      captureDeps = deps;
      calls.push('capture');
      return started ?? Ok(capture);
    },
    createPipeline: (deps) => {
      pipelineDeps = deps;
      return pipeline;
    },
    fetch,
    timers: systemTimers,
    now: () => 1_000,
  });
  const background: OffscreenSender = {
    id: fakeBrowser.runtime.id,
    url: fakeBrowser.runtime.getURL('/background.js'),
  };
  return {
    calls,
    sent,
    stop,
    listening: () => listener !== undefined,
    /** Delivers a message as `sender` does; IGNORED when the listener does not take it. */
    deliver: (message: unknown, sender: OffscreenSender = background): Promise<unknown> =>
      new Promise((resolve) => {
        if (listener?.(message, sender, resolve) !== true) resolve(IGNORED);
      }),
    /** The payloads of the messages of `type` sent to the background. */
    toBackground: (type: string) =>
      sent.filter((message) => message.type === type).map(({ payload }) => payload),
    pipeline: (): PipelineDeps => {
      if (pipelineDeps === undefined) throw new Error('no pipeline made');
      return pipelineDeps;
    },
    capture: (): CaptureDeps => {
      if (captureDeps === undefined) throw new Error('no capture started');
      return captureDeps;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  fakeBrowser.reset();
});

describe('offscreen document', () => {
  it('starts away, with the capture of the stream id, and ignores a front it already follows', async () => {
    const h = setup();
    expect(await h.deliver(START)).toEqual(Ok({}));
    expect(h.calls).toEqual(['mode:away', 'capture']);
    expect(h.capture()).toMatchObject({
      streamId: 'stream-1',
      workletUrl: fakeBrowser.runtime.getURL('/pcm-worklet.js'),
    });
    expect(await h.deliver(front('away'))).toEqual(Ok({}));
    expect(h.calls).toEqual(['mode:away', 'capture']);
    expect(h.toBackground('audio/status')).toEqual([]);
  });

  it.each([
    { front: 'active', before: [], calls: ['discard', 'mode:active', 'input:on'] },
    { front: 'pause', before: [], calls: ['mode:pause', 'flush', 'input:off'] },
    { front: 'away', before: ['active'], calls: ['input:off', 'discard', 'mode:away'] },
    { front: 'active', before: ['pause'], calls: ['discard', 'mode:active', 'input:on'] },
    { front: 'pause', before: ['active'], calls: ['mode:pause', 'flush', 'input:off'] },
  ])('applies front $front after $before', async ({ front: state, before, calls }) => {
    const h = setup();
    await h.deliver(START);
    for (const earlier of before) await h.deliver(front(earlier));
    h.calls.length = 0;
    expect(await h.deliver(front(state))).toEqual(Ok({}));
    expect(h.calls).toEqual(calls);
    expect(h.toBackground('audio/status').at(-1)).toEqual({ tabId: 7, status: { state } });
  });

  it('pushes the segments of the capture into the pipeline and sends its lines to the background', async () => {
    const h = setup();
    await h.deliver(START);
    const segment = {
      pcm: new Int16Array(4_800),
      durationMs: 300,
      trailingSilenceMs: 300,
      carriedMs: 0,
      gapBeforeMs: 0,
      endedAt: 700,
    };
    h.capture().onSegment(segment);
    expect(h.calls.at(-1)).toBe('push:300');
    h.pipeline().emit(LINE);
    await vi.waitFor(() => {
      expect(h.sent).toEqual([
        { type: 'audio/lines', target: 'background', payload: { tabId: 7, lines: [LINE] } },
      ]);
    });
    expect(h.pipeline().now()).toBe(1_000);
    // The pipeline reads the config of the last audio/config.
    expect(h.pipeline().config()).toEqual(CONFIG);
    const next = { ...CONFIG, display: 'ja', context: 'Title: Fixture Quest day 4' };
    expect(await h.deliver(to('audio/config', { config: next }))).toEqual(Ok({}));
    expect(h.pipeline().config()).toEqual(next);
  });

  it('resets the pipeline and the VAD for a new video', async () => {
    const h = setup();
    await h.deliver(START);
    h.calls.length = 0;
    expect(await h.deliver(to('audio/reset'))).toEqual(Ok({}));
    expect(h.calls).toEqual(['reset', 'discard']);
  });

  it('releases the capture and the pipeline on audio/stop, and starts a second capture after the first', async () => {
    const h = setup();
    await h.deliver(START);
    h.calls.length = 0;
    expect(await h.deliver(START)).toEqual(Ok({}));
    expect(h.calls).toEqual(['dispose', 'stop', 'mode:away', 'capture']);
    h.calls.length = 0;
    expect(await h.deliver(to('audio/stop'))).toEqual(Ok({}));
    expect(h.calls).toEqual(['dispose', 'stop']);
    for (const message of [to('audio/state'), front('active'), to('audio/reset')])
      expect(await h.deliver(message)).toMatchObject({
        ok: false,
        error: { internalCode: 'state_unavailable' },
      });
    expect(await h.deliver(to('audio/stop'))).toEqual(Ok({}));
    expect(h.calls).toEqual(['dispose', 'stop']);
  });

  it('answers capture_failed and keeps nothing when the stream cannot be captured', async () => {
    const h = setup({ started: Err(failure('capture_failed')) });
    expect(await h.deliver(START)).toMatchObject({
      ok: false,
      error: { internalCode: 'capture_failed' },
    });
    expect(h.calls).toEqual(['mode:away', 'capture', 'dispose']);
    expect(await h.deliver(to('audio/state'))).toMatchObject({ ok: false });
  });

  it('reports idle after 10 minutes without being active', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.deliver(START);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await h.deliver(front('active'))).toEqual(Ok({}));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.toBackground('audio/idle')).toEqual([]);
    await h.deliver(front('pause'));
    await vi.advanceTimersByTimeAsync(599_999);
    expect(h.toBackground('audio/idle')).toEqual([]);
    // Away after pause is still not active: the same ten minutes go on.
    await h.deliver(front('away'));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.toBackground('audio/idle')).toEqual([{ tabId: 7 }]);
    // A capture that stopped reports nothing more.
    await h.deliver(to('audio/stop'));
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(h.toBackground('audio/idle')).toHaveLength(1);
  });

  it('stops the capture when the server loses the audio projector mid-capture', async () => {
    const h = setup();
    await h.deliver(START);
    const { onFailure } = h.pipeline();
    onFailure?.(failure('response_invalid'));
    onFailure?.(failure('audio_unsupported'));
    onFailure?.(failure('audio_unsupported'));
    await vi.waitFor(() => {
      expect(h.toBackground('audio/failed')).toEqual([{ tabId: 7, code: 'audio_unsupported' }]);
    });
    await settle();
    expect(h.toBackground('audio/failed')).toHaveLength(1);
  });

  it('ignores messages that are not addressed to the offscreen document', async () => {
    const h = setup();
    for (const target of ['panel', 'background', 'content', undefined])
      expect(await h.deliver({ ...START, target })).toBe(IGNORED);
    for (const sender of [
      { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL('/sidepanel.html') },
      { id: fakeBrowser.runtime.id, url: 'https://www.youtube.com/watch', tab: { id: 3 } },
      { id: 'another-extension', url: 'chrome-extension://another-extension/background.js' },
    ])
      expect(await h.deliver(START, sender)).toBe(IGNORED);
    expect(h.calls).toEqual([]);
    // Addressed to it but malformed: refused, not acted on.
    expect(await h.deliver(to('audio/start', { tabId: -1 }))).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    expect(h.calls).toEqual([]);
    h.stop();
    expect(h.listening()).toBe(false);
  });

  it('translates live lines with the line translator chosen in the config and reports its status', async () => {
    const bodies: { model?: unknown; id_slot?: unknown }[] = [];
    const fetch = vi.fn<Fetch>(async (input, init) => {
      if (input.endsWith('/v1/models')) return Response.json({ data: [{ id: 'gemma4-e4b' }] });
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      // A made-up translation.
      return Response.json({
        choices: [{ message: { content: '訳:一行\n' }, finish_reason: 'stop' }],
      });
    });
    const h = setup({ fetch });
    const plamo = { ...CONFIG, translator: 'plamo' };
    expect(await h.deliver({ ...START, payload: { ...START.payload, config: plamo } })).toEqual(
      Ok({}),
    );
    const { signal } = new AbortController();
    expect(
      await h.pipeline().translate({
        source: 'Okay chat.',
        sourceLang: 'en',
        previous: [],
        context: '',
        glossary: [],
        signal,
      }),
    ).toEqual(Ok('訳:一行'));
    // PLaMo is not listed: Gemma (models.translate) translated the line on slot 0.
    expect(bodies).toEqual([expect.objectContaining({ model: 'gemma4-e4b', id_slot: 0 })]);
    expect(await h.deliver(to('audio/state'))).toEqual(
      Ok({
        tabId: 7,
        startedAt: 1_000,
        front: { state: 'away' },
        stats: STATS,
        translator: {
          chosen: 'plamo',
          fallback: { latest: 'not_listed', lines: { not_listed: 1, refused: 0, language: 0 } },
        },
      }),
    );
    // Recognition uses models.asr of the start settings.
    await h.pipeline().asr.transcribe(new Int16Array(1_600), {
      sourceLang: 'auto',
      context: '',
      glossary: [],
      signal,
    });
    expect(bodies.at(-1)).toMatchObject({ model: 'asr-fixture', id_slot: 0 });
  });
});

describe('worklet segments', () => {
  const segment = {
    type: 'segment',
    pcm: new Int16Array(3),
    durationMs: 300,
    trailingSilenceMs: 300,
    carriedMs: 0,
    gapBeforeMs: 700,
  };
  it.each([
    { name: 'closed by silence', data: segment, endedAt: 9_700 },
    {
      name: 'cut for length',
      data: { ...segment, trailingSilenceMs: 0, carriedMs: 200 },
      endedAt: 9_800,
    },
  ])('dates the end of the speech of a segment $name', ({ data, endedAt }) => {
    expect(readSegment(data, 10_000)).toEqual({
      pcm: data.pcm,
      durationMs: data.durationMs,
      trailingSilenceMs: data.trailingSilenceMs,
      carriedMs: data.carriedMs,
      gapBeforeMs: data.gapBeforeMs,
      endedAt,
    });
  });

  it.each([
    { name: 'another type', data: { ...segment, type: 'flush' } },
    { name: 'samples that are not PCM16', data: { ...segment, pcm: new Float32Array(3) } },
    { name: 'a negative duration', data: { ...segment, durationMs: -1 } },
    { name: 'a missing field', data: { type: 'segment', pcm: new Int16Array(3) } },
    { name: 'no object', data: 'segment' },
  ])('reads nothing from $name', ({ data }) => {
    expect(readSegment(data, 10_000)).toBeUndefined();
  });
});
