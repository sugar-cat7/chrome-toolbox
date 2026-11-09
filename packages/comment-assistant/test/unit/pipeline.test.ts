import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  COMMENT_CATEGORY_CODES,
  commentBatchMaxTokens,
  commentCategorySchema,
  GENRE_MAX_TOKENS,
  genrePrompt,
  createClefJudge,
  createLanguageDetector,
  createLlamaClient,
  createQueue,
  llmCategoryJudge,
  type Fetch,
  type LlamaClient,
  type ToxicityJudge,
} from '@chrome-toolbox/extension-core';
import { createFeedbackStore, type FeedbackStore } from '../../src/feedback.ts';
import { fakeClock as createFakeClock, type FakeClock } from './fake-clock.ts';
import {
  batchOrder,
  commentConcurrencyFor,
  createCommentPipeline,
  holdWindowMs,
  type Target,
  type WaitingComment,
} from '../../src/pipeline.ts';
import type { Annotation, RawComment } from '../../src/protocol.ts';
import type { StreamContext } from '../../src/stream-context.ts';

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const target: Target = { tabId: 7, frameId: 3 };
const channel = { site: 'youtube', channel: 'UC-test' } as const;

const fakeClock = (): FakeClock => createFakeClock(START);

type PromptComment = { id: number; lang: string; translate: boolean; text: string };
type ChatBody = {
  model: string;
  id_slot: number;
  max_tokens: number;
  grammar: string;
  messages: { role: string; content: string }[];
};
type Item = { id: number; ja?: string; category: string };

/** The comments of a commentBatchPrompt request: one JSON object per line of the user turn. */
const promptComments = (body: ChatBody): PromptComment[] =>
  (body.messages[1]?.content ?? '')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as PromptComment);
/** The compact reply the grammar asks for: `<id>\t<code>[\t<ja>]\n` per item. */
const replyLines = (items: readonly Item[]): string =>
  items
    .map((item) => {
      const category = commentCategorySchema.parse(item.category);
      const ja = item.ja === undefined ? '' : `\t${item.ja}`;
      return `${item.id}\t${COMMENT_CATEGORY_CODES[category]}${ja}\n`;
    })
    .join('');

/** Fake llama-server chat endpoint at the HTTP boundary; `answer` builds the model's reply. */
const fakeLlama = (answer: (comments: PromptComment[]) => Item[]) => {
  const state = { down: false, bodies: [] as ChatBody[] };
  const fetch: Fetch = async (input, init) => {
    expect(new URL(input).pathname).toBe('/v1/chat/completions');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as ChatBody;
    state.bodies.push(body);
    if (state.down) throw new TypeError('Failed to fetch');
    const content = replyLines(answer(promptComments(body)));
    return Response.json({ choices: [{ message: { content } }] });
  };
  return { state, fetch };
};
/** Translates every translatable comment as `訳:<text>`; categories come from `categories`. */
const echo =
  (categories: Record<string, string> = {}) =>
  (comments: PromptComment[]): Item[] =>
    comments.map((c) => ({
      id: c.id,
      category: categories[c.text] ?? 'chatter',
      ...(c.translate ? { ja: `訳:${c.text}` } : {}),
    }));
/** A server that never answers until the request is aborted. */
const hangingLlama = () => {
  const state = { requests: 0, aborted: 0 };
  const fetch: Fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      state.requests += 1;
      const abort = (): void => {
        state.aborted += 1;
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort);
    });
  return { state, fetch };
};
/** A door that holds requests until opened. */
/** Lets everything already queued on microtasks run, to check that something did not happen. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};
/** `fetch` that holds every request until the gate opens. */
const gated = (fetch: Fetch, door: { opened: Promise<void> }): Fetch => {
  const held: Fetch = async (input, init) => {
    await door.opened;
    return fetch(input, init);
  };
  return held;
};
const fakeJudge = (
  answer: (texts: readonly string[]) => Result<number[]>,
): { mode: 'clef'; judge: Mock<ToxicityJudge['judge']> } => ({
  mode: 'clef',
  judge: vi.fn<ToxicityJudge['judge']>(async (texts) => answer(texts)),
});

const comment = (id: string, text: string, at = START): RawComment => ({
  id,
  author: 'viewer',
  text,
  at,
});

/** Every stream is titled after its partition; none has a known streamer. */
const titled = (site: StreamContext['site'], partition: string): StreamContext => ({
  site,
  partition,
  title: `${site}/${partition}: Elden Ring DLC`,
});

const setup = ({
  fetch,
  judge = llmCategoryJudge,
  commentConcurrency,
  feedback,
  context = titled,
  client = (llama) => llama,
  onHiddenChange,
  subtitleSlotBusy,
}: {
  fetch: Fetch;
  judge?: ToxicityJudge;
  commentConcurrency?: number;
  feedback?: FeedbackStore;
  onHiddenChange?: (site: StreamContext['site'], channel: string, count: number) => void;
  context?: (site: StreamContext['site'], partition: string) => StreamContext;
  /** Wraps the llama.cpp client built on `fetch`. */
  client?: (llama: LlamaClient) => LlamaClient;
  /** Whether the subtitles' slot 0 is processing; without it comments never give way. */
  subtitleSlotBusy?: (signal: AbortSignal) => Promise<Result<boolean>>;
}) => {
  const clock = fakeClock();
  const emitted: { target: Target; annotations: Annotation[] }[] = [];
  const pipeline = createCommentPipeline({
    client: client(
      createLlamaClient({
        baseUrl: 'http://127.0.0.1:18083',
        fetch,
        queue: createQueue({ concurrency: 4, maxPending: 16 }),
      }),
    ),
    ...(commentConcurrency === undefined ? {} : { commentConcurrency }),
    ...(feedback === undefined ? {} : { feedback }),
    ...(onHiddenChange === undefined ? {} : { onHiddenChange }),
    ...(subtitleSlotBusy === undefined ? {} : { subtitleSlotBusy }),
    model: 'gemma4-e4b',
    judge,
    detector: createLanguageDetector(undefined),
    context,
    emit: (to, annotations) => emitted.push({ target: to, annotations }),
    now: clock.now,
    timers: clock.timers,
  });
  const annotations = (): Annotation[] => emitted.flatMap((event) => event.annotations);
  return { clock, emitted, pipeline, annotations };
};

describe('comment pipeline', () => {
  it('translates non-Japanese comments and only classifies Japanese ones in one call per batch', async () => {
    const llama = fakeLlama((comments) =>
      comments.map((c) =>
        c.translate
          ? { id: c.id, ja: '第2形態ってどのくらい?', category: 'question' }
          : { id: c.id, category: 'chatter' },
      ),
    );
    const { clock, emitted, pipeline } = setup({ fetch: llama.fetch });
    const accepted = pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'how long is phase 2?'), comment('2', 'がんばれ')],
    });
    expect(accepted).toEqual({ accepted: 2, dropped: 0 });
    clock.advance(500);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(llama.state.bodies).toHaveLength(1);
    const [body] = llama.state.bodies;
    expect(body).toMatchObject({ model: 'gemma4-e4b', id_slot: 1, temperature: 0 });
    expect(promptComments(body as ChatBody)).toEqual([
      { id: 1, lang: 'und-Latn', translate: true, text: 'how long is phase 2?' },
      { id: 2, lang: 'ja', translate: false, text: 'がんばれ' },
    ]);
    // The compact line format: a grammar instead of a JSON schema, and a budget per line.
    expect(body).not.toHaveProperty('response_format');
    expect(body?.grammar.split('\n')[0]).toBe(
      String.raw`root ::= "1\t" code "\t" ja1 "\n" "2\t" code "\n"`,
    );
    expect(body?.max_tokens).toBe(
      commentBatchMaxTokens([
        { text: 'how long is phase 2?', lang: 'und-Latn', translate: true },
        { text: 'がんばれ', lang: 'ja', translate: false },
      ]),
    );
    expect(body?.messages[1]?.content).toContain('youtube/UC-test: Elden Ring DLC');
    expect(emitted).toEqual([
      {
        target,
        annotations: [
          {
            id: '1',
            translation: '第2形態ってどのくらい?',
            category: 'question',
            state: 'done',
          },
          { id: '2', category: 'chatter', state: 'done' },
        ],
      },
    ]);
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => [record.id, record.lang, record.state])).toEqual([
      ['1', 'und-Latn', 'done'],
      ['2', 'ja', 'done'],
    ]);
  });

  it('sends only classification when the whole batch is Japanese', async () => {
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('a', 'がんばれ'), comment('b', 'きたー')],
    });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    const body = llama.state.bodies[0] as ChatBody;
    expect(promptComments(body).map((c) => c.translate)).toEqual([false, false]);
    expect(body.grammar).not.toMatch(/\bja\d/u);
    expect(annotations().map((a) => a.translation)).toEqual([undefined, undefined]);
  });

  it('asks the model for short batch-local ids instead of echoing long platform ids', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    const ids = [
      'ChwKGkNKdUt4YkM1aFlrREZaYkR3Z1FkWDhJRFJR',
      'ChwKGkNMbjU0YlM1aFlrREZaYkR3Z1FkWDhJRFJS',
    ];
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment(ids[0] ?? '', 'hello'),
        comment(ids[1] ?? '', 'good game'),
        comment('3', 'wow'),
      ],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(promptComments(llama.state.bodies[0] as ChatBody).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(annotations().map((a) => [a.id, a.translation])).toEqual([
      [ids[0], '訳:hello'],
      [ids[1], '訳:good game'],
      ['3', '訳:wow'],
    ]);
  });

  it('marks a comment failed when the reply does not match its id', async () => {
    const llama = fakeLlama((comments) =>
      echo()(comments).map((item, i) => (i === 1 ? { ...item, id: 9 } : item)),
    );
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('x', 'hi'), comment('y', 'yo')] });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations()).toEqual([
      { id: 'x', translation: '訳:hi', category: 'chatter', state: 'done' },
      { id: 'y', category: 'chatter', state: 'failed' },
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      failed: 1,
      lastError: 'response_invalid',
    });
  });

  it('skips empty-text comments without calling the LLM', () => {
    const fetch = vi.fn<Fetch>();
    const { emitted, pipeline } = setup({ fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('e', '🔥🔥'), comment('f', ' !! ')] });
    expect(emitted).toEqual([
      {
        target,
        annotations: [
          { id: 'e', category: 'chatter', state: 'skipped' },
          { id: 'f', category: 'chatter', state: 'skipped' },
        ],
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ records: 2, pending: 0 });
  });

  it('marks a failed batch and records lastError while llama.cpp is down, then recovers', async () => {
    const llama = fakeLlama(echo());
    llama.state.down = true;
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello')] });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]).toEqual({ id: '1', category: 'chatter', state: 'failed' });
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      failed: 1,
      pending: 0,
      lastError: 'network_failed',
    });

    llama.state.down = false;
    // The ingest reply carries it too: the frame then lets its lines in without waiting (R52).
    expect(
      pipeline.ingest(target, { ...channel, comments: [comment('2', 'hello again')] }),
    ).toEqual({ accepted: 1, dropped: 0, lastError: 'network_failed' });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations()[1]).toEqual({
      id: '2',
      translation: '訳:hello again',
      category: 'chatter',
      state: 'done',
    });
    expect(pipeline.stats(channel.site, channel.channel).lastError).toBeUndefined();
    expect(pipeline.ingest(target, { ...channel, comments: [comment('3', 'and again')] })).toEqual({
      accepted: 1,
      dropped: 0,
    });
  });

  it('reports dropped comments under a flood instead of growing', async () => {
    const llama = hangingLlama();
    const { clock, annotations, emitted, pipeline } = setup({ fetch: llama.fetch });
    let dropped = 0;
    let maxPending = 0;
    let maxTimers = 0;
    // 100 comments per second for 10 seconds while llama.cpp is stuck on the first batch.
    for (let i = 0; i < 1000; i += 1) {
      dropped += pipeline.ingest(target, {
        ...channel,
        comments: [comment(`m${i}`, `msg ${i}`)],
      }).dropped;
      clock.advance(10);
      maxPending = Math.max(maxPending, pipeline.stats(channel.site, channel.channel).pending);
      maxTimers = Math.max(maxTimers, clock.active());
    }
    const stats = pipeline.stats(channel.site, channel.channel);
    expect(dropped).toBeGreaterThan(0);
    expect(stats.dropped).toBe(dropped);
    expect(stats.pending + stats.dropped).toBe(1000);
    expect(maxPending).toBeLessThanOrEqual(200);
    expect(maxTimers).toBeLessThanOrEqual(1);
    // Dropped comments are shown in the original; the oldest go first and the newest are kept.
    const skipped = annotations().filter((a) => a.state === 'skipped');
    expect(skipped).toHaveLength(dropped);
    // m0 started alone at once (idle); the backlog's oldest, m1, is dropped first.
    expect(skipped[0]?.id).toBe('m1');
    expect(skipped.map((a) => a.id)).not.toContain('m999');
    await vi.waitFor(() => expect(llama.state.requests).toBe(1));

    const before = emitted.length;
    pipeline.dispose();
    expect(clock.active()).toBe(0);
    await vi.waitFor(() => expect(llama.state.aborted).toBe(1));
    expect(emitted).toHaveLength(before);
  });

  it('processes the newest backlog first once llama.cpp catches up', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    for (let i = 0; i < 9; i += 1)
      pipeline.ingest(target, { ...channel, comments: [comment(`n${i}`, `msg ${i}`)] });
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(9));
    // n0 starts alone at once; n1-n6 wait in the backlog and n7-n8 in the batcher window.
    expect(
      llama.state.bodies.map((body) => promptComments(body).map((c) => c.text.slice(4))),
    ).toEqual([['0'], ['6', '7', '8'], ['3', '4', '5'], ['1', '2']]);
  });

  it('starts an idle comment at once and opens the batch window only while a batch runs', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello')] });
    expect(clock.active()).toBe(0);
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'again')] });
    expect(clock.active()).toBe(1);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    // The second comment did not wait for its 500 ms window once the first batch ended.
    expect(clock.active()).toBe(0);
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['hello'],
      ['again'],
    ]);
  });

  it('runs Clef and the translate call at the same time', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const arrived = { chat: 0 };
    const fetch: Fetch = async (input, init) => {
      arrived.chat += 1;
      await door.opened;
      return llama.fetch(input, init);
    };
    const judge = {
      mode: 'clef' as const,
      judge: vi.fn<ToxicityJudge['judge']>(async (texts) => {
        await door.opened;
        return Ok(texts.map(() => 0.1));
      }),
    };
    const { annotations, pipeline } = setup({ fetch, judge });
    // A text with an abuse cue: Clef judges it while the model runs (R43).
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there clown')] });
    await vi.waitFor(() => expect([judge.judge.mock.calls.length, arrived.chat]).toEqual([1, 1]));
    expect(annotations()).toEqual([]);
    door.open();
    await vi.waitFor(() => expect(annotations()[0]?.state).toBe('done'));
  });

  it('sends a comment that two frames show to both of them', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { emitted, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const popout: Target = { tabId: 8, frameId: 0 };
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello')] });
    pipeline.ingest(popout, { ...channel, comments: [comment('1', 'hello')] });
    door.open();
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    const done = {
      id: '1',
      translation: '訳:hello',
      category: 'chatter',
      state: 'done',
    };
    expect(emitted).toEqual([
      { target, annotations: [done] },
      { target: popout, annotations: [done] },
    ]);
    expect(llama.state.bodies).toHaveLength(1);
  });

  it('remembers at most the four most recent frames of a pending comment', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { emitted, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    for (let frameId = 0; frameId < 6; frameId += 1)
      pipeline.ingest({ tabId: 7, frameId }, { ...channel, comments: [comment('1', 'hello')] });
    door.open();
    await vi.waitFor(() => expect(emitted).toHaveLength(4));
    expect(emitted.map((event) => event.target.frameId)).toEqual([2, 3, 4, 5]);
  });

  it('builds each batch from one channel so stream context never mixes', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const a = { site: 'youtube', channel: 'A' } as const;
    const b = { site: 'twitch', channel: 'B' } as const;
    pipeline.ingest(target, { ...a, comments: [comment('a0', 'a 0')] });
    for (let i = 1; i <= 3; i += 1) {
      pipeline.ingest(target, { ...a, comments: [comment(`a${i}`, `a ${i}`)] });
      pipeline.ingest(target, { ...b, comments: [comment(`b${i}`, `b ${i}`)] });
    }
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(7));
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['a 0'],
      ['b 1', 'b 2', 'b 3'],
      ['a 1', 'a 2', 'a 3'],
    ]);
    expect(llama.state.bodies.map((body) => body.messages[1]?.content.split('\n')[0])).toEqual([
      'Stream context: "Title: youtube/A: Elden Ring DLC"',
      'Stream context: "Title: twitch/B: Elden Ring DLC"',
      'Stream context: "Title: youtube/A: Elden Ring DLC"',
    ]);
  });

  it('lets Clef override the LLM category when the score reaches 0.8', async () => {
    const llama = fakeLlama(echo());
    const judge = fakeJudge((texts) =>
      Ok(texts.map((text) => (text === 'you are trash' ? 0.8 : 0.1))),
    );
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment('1', 'you are trash'),
        comment('2', 'nice play'),
        comment('3', 'lol nice'),
      ],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    // Only the comment with an abuse cue goes to Clef (R43).
    expect(judge.judge).toHaveBeenCalledWith(['you are trash'], expect.anything());
    expect(annotations().map((a) => a.category)).toEqual(['abusive', 'chatter', 'chatter']);
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => [record.category, record.abusive])).toEqual([
      ['abusive', 0.8],
      ['chatter', undefined],
      ['chatter', undefined],
    ]);
    expect(pipeline.stats(channel.site, channel.channel).judge).toBe('clef');
  });

  it.each([
    { score: 0.3, llm: 'abusive', expected: 'chatter' },
    { score: 0.79, llm: 'abusive', expected: 'chatter' },
    { score: 0.79, llm: 'important', expected: 'important' },
    { score: 0.8, llm: 'chatter', expected: 'abusive' },
    { score: 0.8, llm: 'abusive', expected: 'abusive' },
  ])(
    'treats Clef as the abuse authority: $score with LLM $llm -> $expected',
    async ({ score, llm, expected }) => {
      // A text with an abuse cue, so Clef judges it whatever the model says (R43).
      const llama = fakeLlama(echo({ 'take this loser': llm }));
      const judge = fakeJudge((texts) => Ok(texts.map(() => score)));
      const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'take this loser')] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(annotations()[0]?.category).toBe(expected);
    },
  );

  it('keeps a Clef verdict on a comment whose translation failed', async () => {
    const llama = fakeLlama(echo());
    llama.state.down = true;
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.9)));
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you idiot')] });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]).toEqual({
      id: '1',
      category: 'abusive',
      state: 'failed',
    });
  });

  it('switches to the LLM category judge for later batches once Clef is unavailable', async () => {
    const llama = fakeLlama(echo({ 'you idiot': 'abusive', 'you moron': 'abusive' }));
    const judge = fakeJudge(() => Err(failure('clef_unavailable')));
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you idiot')] });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'you moron')] });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(llama.state.bodies).toHaveLength(2);
    expect(annotations().map((a) => [a.category, a.state])).toEqual([
      ['abusive', 'done'],
      ['abusive', 'done'],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ judge: 'llm' });
  });

  it('reports a broken Clef reply and still annotates from the LLM', async () => {
    const llama = fakeLlama(echo());
    const judge = fakeJudge(() => Err(failure('response_invalid')));
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there clown')] });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]?.state).toBe('done');
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      judge: 'clef',
      judgeError: 'response_invalid',
    });
  });

  describe('a Clef error never fails the batch (R53)', () => {
    /** The real Clef judge against a `/v1/systemone` that answers with `respond`. */
    const clefAnswering = (respond: () => Promise<Response>) => {
      const fetch = vi.fn<Fetch>(async (input) => {
        expect(new URL(input).pathname).toBe('/v1/systemone');
        return respond();
      });
      return {
        fetch,
        judge: createClefJudge({
          baseUrl: 'http://127.0.0.1:18083',
          model: 'clef-flash',
          fetch,
          queue: createQueue({ concurrency: 1, maxPending: 16 }),
        }),
      };
    };
    const routerError = (status: number, message: string) => () =>
      Promise.resolve(Response.json({ error: { code: status, message, type: 'x' } }, { status }));

    it.each([
      {
        name: 'a 400 for this request',
        respond: routerError(400, 'the request exceeds the available context size'),
        judgeError: 'response_invalid',
        mode: 'clef',
      },
      {
        name: 'a router without the Clef model (400)',
        respond: routerError(400, "model 'clef-flash' not found"),
        judgeError: 'clef_unavailable',
        mode: 'llm',
      },
      {
        name: 'a 503 while the model loads',
        respond: routerError(503, 'Loading model'),
        judgeError: 'response_invalid',
        mode: 'clef',
      },
      {
        name: 'an unreachable server',
        respond: () => Promise.reject(new TypeError('Failed to fetch')),
        judgeError: 'network_failed',
        mode: 'clef',
      },
      {
        name: 'a timeout',
        respond: () => Promise.reject(new DOMException('signal timed out', 'TimeoutError')),
        judgeError: 'network_failed',
        mode: 'clef',
      },
    ])(
      "translates the batch with the model's categories after $name",
      async ({ respond, judgeError, mode }) => {
        const llama = fakeLlama(echo({ 'you are an idiot': 'abusive' }));
        const clef = clefAnswering(respond);
        const { annotations, pipeline } = setup({ fetch: llama.fetch, judge: clef.judge });
        pipeline.ingest(target, {
          ...channel,
          comments: [comment('a', 'you are an idiot'), comment('b', 'nice play there')],
        });
        await vi.waitFor(() => expect(annotations()).toHaveLength(2));
        expect(clef.fetch).toHaveBeenCalledOnce();
        expect(annotations()).toEqual([
          { id: 'a', translation: '訳:you are an idiot', category: 'abusive', state: 'done' },
          { id: 'b', translation: '訳:nice play there', category: 'chatter', state: 'done' },
        ]);
        const stats = pipeline.stats(channel.site, channel.channel);
        expect(stats).toMatchObject({ failed: 0, judge: mode, judgeError });
        expect(stats.lastError).toBeUndefined();
      },
    );

    it('judges with the model from then on when Clef answers 404', async () => {
      const llama = fakeLlama(echo({ 'you are an idiot': 'abusive' }));
      const clef = clefAnswering(() =>
        Promise.resolve(new Response('File Not Found', { status: 404 })),
      );
      const { annotations, pipeline } = setup({ fetch: llama.fetch, judge: clef.judge });
      pipeline.ingest(target, { ...channel, comments: [comment('a', 'you are an idiot')] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      pipeline.ingest(target, { ...channel, comments: [comment('b', 'what an idiot move')] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(2));
      expect(clef.fetch).toHaveBeenCalledOnce();
      expect(annotations().map((a) => [a.id, a.category, a.state])).toEqual([
        ['a', 'abusive', 'done'],
        ['b', 'chatter', 'done'],
      ]);
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
        judge: 'llm',
        judgeError: 'clef_unavailable',
      });
    });

    it('frees the slot when the early Clef call timed out, without a late call (R55)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => void vi.useRealTimers());
      // Clef is silent: each call ends after its 30 s timeout.
      const judge = {
        mode: 'clef' as const,
        judge: vi.fn<ToxicityJudge['judge']>(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(Err(failure('network_failed'))), 30_000);
            }),
        ),
      };
      // The model calls the comment without a cue abusive, which would ask Clef after the reply.
      const llama = fakeLlama(
        echo({ 'you are an idiot': 'abusive', 'nice play there': 'abusive' }),
      );
      const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
      const settled = async (): Promise<void> => {
        for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      };
      pipeline.ingest(target, {
        ...channel,
        comments: [comment('a', 'you are an idiot'), comment('b', 'nice play there')],
      });
      pipeline.ingest(target, { ...channel, comments: [comment('c', 'see you all later')] });
      await settled();
      expect(llama.state.bodies).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(29_000);
      await settled();
      expect(annotations()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await settled();
      // At 30 s the batch is shown with the model's categories and the next one had the slot.
      expect(annotations().map((a) => [a.id, a.category, a.state])).toEqual([
        ['a', 'abusive', 'done'],
        ['b', 'abusive', 'done'],
        ['c', 'chatter', 'done'],
      ]);
      expect(judge.judge).toHaveBeenCalledOnce();
      expect(llama.state.bodies).toHaveLength(2);
      pipeline.dispose();
    });

    it('lets the chat call finish when Clef cannot reach the server', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const requests: AbortSignal[] = [];
      const fetch: Fetch = (input, init) => {
        if (init?.signal) requests.push(init.signal);
        return gated(llama.fetch, door)(input, init);
      };
      const judge = fakeJudge(() => Err(failure('network_failed')));
      const { annotations, pipeline } = setup({ fetch, judge });
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there clown')] });
      await vi.waitFor(() => expect(judge.judge).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests.map((signal) => signal.aborted)).toEqual([false]);
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(annotations()[0]).toEqual({
        id: '1',
        translation: '訳:hello there clown',
        category: 'chatter',
        state: 'done',
      });
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
        failed: 0,
        judgeError: 'network_failed',
      });
      expect(pipeline.stats(channel.site, channel.channel).lastError).toBeUndefined();
    });
  });

  it('keeps a finished translation when Clef fails after it', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const judge = {
      mode: 'clef' as const,
      judge: vi.fn<ToxicityJudge['judge']>(async () => {
        await door.opened;
        return Err(failure('network_failed'));
      }),
    };
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello')] });
    await vi.waitFor(() => expect(llama.state.bodies).toHaveLength(1));
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]?.state).toBe('done');
  });

  it('infers each comment once and re-sends a known annotation to a reloaded frame', async () => {
    const llama = fakeLlama(echo());
    const { annotations, emitted, pipeline } = setup({ fetch: llama.fetch });
    const batch = [comment('1', 'hi'), comment('2', 'good game'), comment('3', '🔥')];
    expect(pipeline.ingest(target, { ...channel, comments: batch })).toEqual({
      accepted: 3,
      dropped: 0,
    });
    expect(pipeline.ingest(target, { ...channel, comments: batch })).toEqual({
      accepted: 0,
      dropped: 0,
    });
    pipeline.ingest(target, { ...channel, comments: [comment('4', 'wow')] });
    // '3' twice: a reloaded iframe keeps its frameId, so a known annotation is always re-sent.
    await vi.waitFor(() =>
      expect(annotations().map((a) => a.id)).toEqual(['3', '3', '1', '2', '4']),
    );
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['hi', 'good game'],
      ['wow'],
    ]);

    const reloaded: Target = { tabId: 7, frameId: 9 };
    emitted.length = 0;
    pipeline.ingest(reloaded, { ...channel, comments: [comment('1', 'hi'), comment('3', '🔥')] });
    expect(emitted).toEqual([
      {
        target: reloaded,
        annotations: [
          { id: '1', translation: '訳:hi', category: 'chatter', state: 'done' },
          { id: '3', category: 'chatter', state: 'skipped' },
        ],
      },
    ]);
    expect(llama.state.bodies).toHaveLength(2);
  });

  it('keeps at most four channel stores and clears the least recently used', () => {
    const { pipeline } = setup({ fetch: vi.fn<Fetch>() });
    const first = pipeline.store('youtube', 'ch0');
    pipeline.ingest(target, { site: 'youtube', channel: 'ch0', comments: [comment('a', '👍')] });
    const oldest = pipeline.store('youtube', 'ch0');
    expect(oldest.size()).toBe(1);
    expect(first.size()).toBe(0);
    for (let i = 1; i <= 4; i += 1)
      pipeline.ingest(target, {
        site: 'twitch',
        channel: `ch${i}`,
        comments: [comment('a', '👍')],
      });
    expect(oldest.size()).toBe(0);
    expect(pipeline.store('youtube', 'ch0').size()).toBe(0);
    expect([1, 2, 3, 4].map((i) => pipeline.store('twitch', `ch${i}`).size())).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('drops an evicted channel backlog and never stores its late results', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const old = { site: 'youtube', channel: 'old' } as const;
    pipeline.ingest(target, { ...old, comments: [comment('a1', 'one')] });
    pipeline.ingest(target, {
      ...old,
      comments: [comment('a2', 'two'), comment('a3', 'three'), comment('a4', 'four')],
    });
    const oldStore = pipeline.store(old.site, old.channel);
    let dropped = 0;
    for (let i = 1; i <= 4; i += 1)
      dropped += pipeline.ingest(target, {
        site: 'twitch',
        channel: `ch${i}`,
        comments: [comment('e', '👍')],
      }).dropped;
    expect(dropped).toBe(3);
    const fromOld = (): Annotation[] => annotations().filter((a) => a.id.startsWith('a'));
    expect(fromOld()).toEqual(
      ['a2', 'a3', 'a4'].map((id) => ({ id, category: 'chatter', state: 'skipped' })),
    );
    door.open();
    await vi.waitFor(() => expect(fromOld()).toHaveLength(4));
    expect(fromOld()[3]).toMatchObject({ id: 'a1', state: 'done' });
    expect(oldStore.size()).toBe(0);
    expect(llama.state.bodies).toHaveLength(1);
  });

  it('answers trivial reactions at once without the model or Clef', () => {
    const fetch = vi.fn<Fetch>();
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.9)));
    const { emitted, pipeline } = setup({ fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment('1', 'LOL'),
        comment('2', 'ｗｗｗｗｗ'),
        comment('3', '8888'),
        comment('4', 'gg ez'),
      ],
    });
    expect(emitted).toEqual([
      {
        target,
        annotations: [
          { id: '1', translation: '（笑）', category: 'chatter', state: 'done' },
          { id: '2', category: 'chatter', state: 'done' },
          { id: '3', category: 'chatter', state: 'done' },
          { id: '4', category: 'chatter', state: 'done' },
        ],
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      records: 4,
      pending: 0,
      trivial: 4,
      cached: 0,
    });
  });

  it('answers a repeated text from the cache without calling the model or Clef again', async () => {
    // A text with an abuse cue, so Clef is asked about it once (R43).
    const llama = fakeLlama(echo({ 'you clown': 'chatter' }));
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.1)));
    const { emitted, annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you clown')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    emitted.length = 0;
    // Another viewer writes the same text with other case, width and spacing.
    pipeline.ingest(target, { ...channel, comments: [comment('2', '  YOU   ｃｌｏｗｎ ')] });
    expect(emitted).toEqual([
      {
        target,
        annotations: [
          {
            id: '2',
            translation: '訳:you clown',
            category: 'chatter',
            state: 'done',
          },
        ],
      },
    ]);
    expect(llama.state.bodies).toHaveLength(1);
    expect(judge.judge).toHaveBeenCalledTimes(1);
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => [record.id, record.text, record.abusive])).toEqual([
      ['1', 'you clown', 0.1],
      ['2', '  YOU   ｃｌｏｗｎ ', 0.1],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ cached: 1, trivial: 0 });
  });

  it.each([
    { name: 'a failed reply', down: true, clef: () => Ok([0.1]) },
    {
      name: 'a reply without a Clef score',
      down: false,
      clef: () => Err(failure('response_invalid')),
    },
  ])('does not cache $name', async ({ down, clef }) => {
    const llama = fakeLlama(echo());
    llama.state.down = down;
    const judge = fakeJudge(clef);
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    // A text with an abuse cue: Clef is asked about it (R43).
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you clown')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    llama.state.down = false;
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'you clown')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(llama.state.bodies).toHaveLength(2);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ cached: 0 });
  });

  it('infers a copy-pasted text once and answers its waiting copies from the cache', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('0', 'first')] });
    pipeline.ingest(target, {
      ...channel,
      comments: ['a', 'b', 'c', 'd'].map((id) => comment(id, 'copy pasta')),
    });
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(5));
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['first'],
      ['copy pasta'],
    ]);
    expect(annotations().map((a) => [a.id, a.translation, a.state])).toEqual([
      ['0', '訳:first', 'done'],
      ['d', '訳:copy pasta', 'done'],
      ['a', '訳:copy pasta', 'done'],
      ['b', '訳:copy pasta', 'done'],
      ['c', '訳:copy pasta', 'done'],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ cached: 3, pending: 0 });
  });

  it('shows comments that waited over 8 s in the original without inferring them', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'running')] });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('2', 'old one'), comment('3', 'old two')],
    });
    // The batch window ends at exactly 8 s: that is not over 8 s yet.
    clock.advance(8_000);
    expect(annotations()).toEqual([]);
    pipeline.ingest(target, { ...channel, comments: [comment('4', 'young')] });
    clock.advance(500);
    expect(annotations()).toEqual([
      { id: '2', category: 'chatter', state: 'skipped' },
      { id: '3', category: 'chatter', state: 'skipped' },
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      expired: 2,
      dropped: 0,
      pending: 2,
    });
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['running'],
      ['young'],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ expired: 2, pending: 0 });
  });

  it('expires waiting comments when a long batch ends instead of inferring them', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'slow batch')] });
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'waiting')] });
    // The batch window ends while the comment is young; nothing else happens until 9 s.
    clock.advance(500);
    clock.advance(8_500);
    expect(annotations()).toEqual([]);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations().map((a) => [a.id, a.state])).toEqual([
      ['1', 'done'],
      ['2', 'skipped'],
    ]);
    expect(llama.state.bodies).toHaveLength(1);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ expired: 1 });
  });

  it('runs two batches at once on slots 1 and 2 with commentConcurrency 2', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const arrived: ChatBody[] = [];
    const fetch: Fetch = async (input, init) => {
      arrived.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as ChatBody);
      await door.opened;
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch, commentConcurrency: 2 });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('2', 'second'), comment('3', 'third')],
    });
    pipeline.ingest(target, { ...channel, comments: [comment('4', 'fourth')] });
    // Both batches are in flight before either answers; the third waits for a free slot.
    await vi.waitFor(() => expect(arrived).toHaveLength(2));
    expect(arrived.map((body) => [body.id_slot, promptComments(body).map((c) => c.text)])).toEqual([
      [1, ['first']],
      [2, ['second', 'third']],
    ]);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
    expect(arrived).toHaveLength(3);
    expect(arrived[2]?.id_slot).toBe(1);
  });

  /** `fetch` that records each chat's slot and holds it until the door opens. */
  const slotRecorder = (door: { opened: Promise<void> }, llama: { fetch: Fetch }) => {
    const slots: number[] = [];
    const fetch: Fetch = async (input, init) => {
      slots.push((JSON.parse(typeof init?.body === 'string' ? init.body : '') as ChatBody).id_slot);
      await door.opened;
      return llama.fetch(input, init);
    };
    return { slots, fetch };
  };

  it('starts a waiting batch once the server reports a spare slot', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const recorder = slotRecorder(door, llama);
    const { annotations, pipeline } = setup({ fetch: recorder.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'second')] });
    await vi.waitFor(() => expect(recorder.slots).toEqual([1]));
    pipeline.setServerSlots(3);
    await vi.waitFor(() => expect(recorder.slots).toEqual([1, 2]));
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
  });

  it.each([
    // Serial: the first comment runs alone, the other two wait and form one batch on slot 1.
    { requested: 3, totalSlots: 2, slots: [1, 1] },
    { requested: 3, totalSlots: 3, slots: [1, 2, 1] },
    { requested: 1, totalSlots: 4, slots: [1, 1] },
  ])(
    'caps commentConcurrency $requested at the spare slots of a $totalSlots-slot server',
    async ({ requested, totalSlots, slots }) => {
      const door = gate();
      const llama = fakeLlama(echo());
      const recorder = slotRecorder(door, llama);
      const { annotations, pipeline } = setup({
        fetch: recorder.fetch,
        commentConcurrency: requested,
      });
      pipeline.setServerSlots(totalSlots);
      for (const [id, text] of [
        ['1', 'first'],
        ['2', 'second'],
        ['3', 'third'],
      ] as const)
        pipeline.ingest(target, { ...channel, comments: [comment(id, text)] });
      await vi.waitFor(() =>
        expect(recorder.slots).toHaveLength(Math.min(requested, Math.max(1, totalSlots - 1))),
      );
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(3));
      // Every slot used exists on the server (0 is the subtitles').
      expect(recorder.slots).toEqual(slots);
    },
  );

  describe('giving way to subtitles on slot 0', () => {
    type SlotProbe = (signal: AbortSignal) => Promise<Result<boolean>>;
    it.each([
      { name: '枠 0 が処理中', answer: Ok(true), held: [1], slots: [1, 1] },
      { name: '枠 0 が空き', answer: Ok(false), held: [1, 2], slots: [1, 2] },
      {
        name: '問い合わせの失敗',
        answer: Err(failure('network_failed')),
        held: [1, 2],
        slots: [1, 2],
      },
    ])('gives way to subtitles on a 3-slot server: $name', async ({ answer, held, slots }) => {
      const door = gate();
      const llama = fakeLlama(echo());
      const recorder = slotRecorder(door, llama);
      const subtitleSlotBusy = vi.fn<SlotProbe>(async () => answer);
      const { annotations, pipeline } = setup({ fetch: recorder.fetch, subtitleSlotBusy });
      pipeline.setServerSlots(3);
      for (const [id, text] of [
        ['1', 'first'],
        ['2', 'second'],
        ['3', 'third'],
      ] as const)
        pipeline.ingest(target, { ...channel, comments: [comment(id, text)] });
      await vi.waitFor(() => expect(subtitleSlotBusy).toHaveBeenCalledTimes(1));
      // What runs before the first batch answers: only it while subtitles use slot 0.
      await vi.waitFor(() => expect(recorder.slots).toEqual(held));
      await flushMicrotasks();
      expect(recorder.slots).toEqual(held);
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(3));
      expect(recorder.slots).toEqual(slots);
      expect(subtitleSlotBusy).toHaveBeenCalledTimes(1);
    });

    it('does not ask about slot 0 while one batch at a time is enough', async () => {
      const llama = fakeLlama(echo());
      const subtitleSlotBusy = vi.fn<SlotProbe>(async () => Ok(true));
      const { annotations, pipeline } = setup({ fetch: llama.fetch, subtitleSlotBusy });
      pipeline.setServerSlots(3);
      for (const [n, text] of ['first', 'second', 'third'].entries()) {
        pipeline.ingest(target, { ...channel, comments: [comment(String(n), text)] });
        await vi.waitFor(() => expect(annotations()).toHaveLength(n + 1));
      }
      expect(llama.state.bodies).toHaveLength(3);
      expect(subtitleSlotBusy).not.toHaveBeenCalled();
    });

    it('holds a summary back while a batch runs and subtitles use slot 0', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const recorder = slotRecorder(door, llama);
      const subtitleSlotBusy = vi.fn<SlotProbe>(async () => Ok(true));
      const { annotations, pipeline } = setup({ fetch: recorder.fetch, subtitleSlotBusy });
      pipeline.setServerSlots(3);
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
      await vi.waitFor(() => expect(recorder.slots).toEqual([1]));
      const fn = vi.fn<(slot: number) => Promise<Result<number>>>(async (slot) => Ok(slot));
      const summary = pipeline.exclusive(fn);
      await vi.waitFor(() => expect(subtitleSlotBusy).toHaveBeenCalledTimes(1));
      await flushMicrotasks();
      expect(fn).not.toHaveBeenCalled();
      door.open();
      // The batch ends first; then the summary takes slot 1.
      expect(await summary).toEqual(Ok(1));
      expect(annotations()).toHaveLength(1);
    });

    it('holds the genre guess back while a batch runs and subtitles use slot 0', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const recorder = slotRecorder(door, llama);
      const subtitleSlotBusy = vi.fn<SlotProbe>(async () => Ok(true));
      const { annotations, pipeline } = setup({ fetch: recorder.fetch, subtitleSlotBusy });
      pipeline.setServerSlots(3);
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
      await vi.waitFor(() => expect(recorder.slots).toEqual([1]));
      const fn = vi.fn<(slot: number) => Promise<Result<number>>>(async (slot) => Ok(slot));
      const guess = pipeline.exclusive(fn, 'guess', { spare: true });
      await vi.waitFor(() => expect(subtitleSlotBusy).toHaveBeenCalledTimes(1));
      await flushMicrotasks();
      expect(fn).not.toHaveBeenCalled();
      door.open();
      // The batch ends first; then the guess takes the highest free comment slot.
      expect(await guess).toEqual(Ok(2));
      expect(annotations()).toHaveLength(1);
    });

    it('lets a summary start beside a batch when slot 0 is idle', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const recorder = slotRecorder(door, llama);
      const subtitleSlotBusy = vi.fn<SlotProbe>(async () => Ok(false));
      const { pipeline } = setup({ fetch: recorder.fetch, subtitleSlotBusy });
      pipeline.setServerSlots(3);
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
      await vi.waitFor(() => expect(recorder.slots).toEqual([1]));
      expect(await pipeline.exclusive(async (slot): Promise<Result<number>> => Ok(slot))).toEqual(
        Ok(2),
      );
      door.open();
    });

    it('aborts the running probe on dispose', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const recorder = slotRecorder(door, llama);
      const signals: AbortSignal[] = [];
      const subtitleSlotBusy = vi.fn<SlotProbe>(
        (signal) =>
          new Promise<Result<boolean>>(() => {
            signals.push(signal);
          }),
      );
      const { pipeline } = setup({ fetch: recorder.fetch, subtitleSlotBusy });
      pipeline.setServerSlots(3);
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
      pipeline.ingest(target, { ...channel, comments: [comment('2', 'second')] });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      pipeline.dispose();
      expect(signals[0]?.aborted).toBe(true);
      door.open();
    });
  });

  it('answers a copy whose text was in flight from the cache, even after 8 s', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('a', 'copy pasta')] });
    pipeline.ingest(target, { ...channel, comments: [comment('b', 'copy pasta')] });
    // The copy reaches the backlog while young, then nothing happens until 9 s.
    clock.advance(500);
    clock.advance(8_500);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations().map((a) => [a.id, a.state, a.translation])).toEqual([
      ['a', 'done', '訳:copy pasta'],
      ['b', 'done', '訳:copy pasta'],
    ]);
    expect(llama.state.bodies).toHaveLength(1);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ cached: 1, expired: 0 });
  });

  it('holds a copy of a text another running batch is inferring (commentConcurrency 2)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const arrived: string[][] = [];
    const fetch: Fetch = async (input, init) => {
      arrived.push(
        promptComments(JSON.parse(typeof init?.body === 'string' ? init.body : '') as ChatBody).map(
          (c) => c.text,
        ),
      );
      await door.opened;
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch, commentConcurrency: 2 });
    pipeline.ingest(target, { ...channel, comments: [comment('a', 'copy pasta')] });
    pipeline.ingest(target, { ...channel, comments: [comment('b', 'COPY  pasta')] });
    pipeline.ingest(target, { ...channel, comments: [comment('c', 'other')] });
    // The free slot goes to the next distinct text, not to the copy.
    await vi.waitFor(() => expect(arrived).toEqual([['copy pasta'], ['other']]));
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(arrived).toHaveLength(2);
    expect(annotations().find((a) => a.id === 'b')).toEqual({
      id: 'b',
      translation: '訳:copy pasta',
      category: 'chatter',
      state: 'done',
    });
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ cached: 1 });
  });

  it.each([
    { finishReason: 'stop', state: 'done' },
    { finishReason: 'length', state: 'failed' },
  ])(
    'reads a last line without its newline as $state when finish_reason is $finishReason',
    async ({ finishReason, state }) => {
      const fetch: Fetch = async () =>
        Response.json({
          choices: [
            { message: { content: '1\tc\t訳:a\n2\tq\t訳:b' }, finish_reason: finishReason },
          ],
        });
      const { annotations, pipeline } = setup({ fetch });
      pipeline.ingest(target, {
        ...channel,
        comments: [comment('1', 'one a'), comment('2', 'two b')],
      });
      await vi.waitFor(() => expect(annotations()).toHaveLength(2));
      expect(annotations().map((a) => a.state)).toEqual(['done', state]);
    },
  );

  it.each([
    { totalSlots: 0, expected: 1 },
    { totalSlots: 1, expected: 1 },
    { totalSlots: 2, expected: 1 },
    { totalSlots: 3, expected: 2 },
    { totalSlots: 4, expected: 3 },
    { totalSlots: 16, expected: 4 },
  ])(
    'runs $expected batches at once on a server with $totalSlots slots',
    ({ totalSlots, expected }) => {
      expect(commentConcurrencyFor(totalSlots)).toBe(expected);
    },
  );

  it.each([
    { windowMinutes: 5, ago: [1, 4, 6] },
    { windowMinutes: 15, ago: [1, 14, 16] },
  ])('summary uses only records within $windowMinutes min', async ({ windowMinutes, ago }) => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: ago.map((minutes) => comment(`t${minutes}`, 'hi', START - minutes * MINUTE)),
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    const recent = pipeline.store(channel.site, channel.channel).since(windowMinutes * MINUTE);
    expect(recent.map((record) => record.id)).toEqual([`t${ago[0]}`, `t${ago[1]}`]);
  });

  /** A feedback store where the viewer already restored `texts` in channel UC-test. */
  const restored = async (texts: readonly string[], abusive = 0.85): Promise<FeedbackStore> => {
    const feedback = createFeedbackStore();
    for (const text of texts)
      await feedback.record({
        ...channel,
        text,
        category: 'abusive',
        abusive,
        verdict: 'ok',
        at: START,
      });
    return feedback;
  };

  it('records abusive, spam and spoiler comments of a channel for review', async () => {
    // The model calls the first one abusive, so Clef is asked about it after the reply (R43).
    const llama = fakeLlama(
      echo({
        'you are a menace': 'abusive',
        'buy coins at https://example.com/fixture': 'spam',
        'the boss falls at the end': 'spoiler',
        'when?': 'question',
      }),
    );
    const judge = fakeJudge((texts) =>
      Ok(texts.map((text) => (text === 'you are a menace' ? 0.9 : 0.1))),
    );
    const { annotations, pipeline } = setup({
      fetch: llama.fetch,
      judge,
      context: (site, partition) => ({ ...titled(site, partition), spoilerNote: 'the final boss' }),
    });
    // One at a time: the first runs alone, the rest wait and form the next batch, in order.
    for (const [id, text] of [
      ['1', 'you are a menace'],
      ['2', 'buy coins at https://example.com/fixture'],
      ['3', 'the boss falls at the end'],
      ['4', 'when?'],
      ['5', 'lol'],
    ] as const)
      pipeline.ingest(target, { ...channel, comments: [comment(id, text, START + Number(id))] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(5));
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
      {
        id: '1',
        ...channel,
        text: 'you are a menace',
        translation: '訳:you are a menace',
        category: 'abusive',
        abusive: 0.9,
        source: 'clef',
        at: START + 1,
      },
      {
        id: '2',
        ...channel,
        text: 'buy coins at https://example.com/fixture',
        translation: '訳:buy coins at https://example.com/fixture',
        category: 'spam',
        source: 'model',
        at: START + 2,
      },
      {
        id: '3',
        ...channel,
        text: 'the boss falls at the end',
        translation: '訳:the boss falls at the end',
        category: 'spoiler',
        source: 'model',
        at: START + 3,
      },
    ]);
    expect(pipeline.hidden('twitch', 'other')).toEqual([]);
  });

  describe('fast chat classification (R31)', () => {
    const noted = (note: string) => (site: StreamContext['site'], partition: string) => ({
      ...titled(site, partition),
      spoilerNote: note,
    });

    it.each(['S', 'A+', 'ＳＳ', '10点', '#PR', '＃pr'])(
      'answers the vote or meme %s by rule without the model',
      (text) => {
        const fetch = vi.fn<Fetch>();
        const { annotations, pipeline } = setup({ fetch });
        pipeline.ingest(target, { ...channel, comments: [comment('1', text)] });
        expect(annotations()).toEqual([{ id: '1', category: 'chatter', state: 'done' }]);
        expect(fetch).not.toHaveBeenCalled();
        expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
      },
    );

    it('answers copypasta as spam by rule, without the model or Clef, and lists it as a rule verdict', () => {
      const fetch = vi.fn<Fetch>();
      const judge = fakeJudge(() => Ok([]));
      const { annotations, pipeline } = setup({ fetch, judge });
      const text = 'buy my merch buy my merch buy my merch';
      pipeline.ingest(target, { ...channel, comments: [comment('1', text, START + 1)] });
      expect(annotations()).toEqual([{ id: '1', category: 'spam', state: 'done' }]);
      expect(fetch).not.toHaveBeenCalled();
      expect(judge.judge).not.toHaveBeenCalled();
      expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
        { id: '1', ...channel, text, category: 'spam', source: 'rule', at: START + 1 },
      ]);
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ trivial: 1 });
    });

    it('shows copypasta the viewer marked as fine as chatter', async () => {
      const feedback = createFeedbackStore();
      const { annotations, pipeline } = setup({ fetch: vi.fn<Fetch>(), feedback });
      const text = 'buy my merch buy my merch buy my merch';
      pipeline.ingest(target, { ...channel, comments: [comment('1', text)] });
      await pipeline.review(channel.site, channel.channel, '1', 'ok');
      pipeline.ingest(target, { ...channel, comments: [comment('2', text.toUpperCase())] });
      expect(annotations().at(-1)).toEqual({
        id: '2',
        category: 'chatter',
        state: 'done',
      });
    });

    it('marks what only the model found as model verdicts, and Clef abuse as Clef verdicts', async () => {
      // An abuse cue sends the second one to Clef, which finds abuse the model did not (R43).
      const llama = fakeLlama(
        echo({ 'buy coins at https://example.com/fixture': 'spam', 'you are a clown': 'chatter' }),
      );
      const judge = fakeJudge((texts) =>
        Ok(texts.map((text) => (text === 'you are a clown' ? 0.9 : 0.1))),
      );
      const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
      pipeline.ingest(target, {
        ...channel,
        comments: [
          comment('1', 'buy coins at https://example.com/fixture'),
          comment('2', 'you are a clown'),
        ],
      });
      await vi.waitFor(() => expect(annotations()).toHaveLength(2));
      expect(annotations().map((a) => [a.id, a.category])).toEqual([
        ['1', 'spam'],
        ['2', 'abusive'],
      ]);
      expect(annotations().every((a) => !('source' in a))).toBe(true);
      expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.source)).toEqual([
        'model',
        'clef',
      ]);
    });

    it('makes a spoiler verdict chatter when the stream has no spoiler targets', async () => {
      const llama = fakeLlama(echo({ 'my tier list guess': 'spoiler' }));
      const { annotations, pipeline } = setup({ fetch: llama.fetch });
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'my tier list guess')] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(annotations()[0]).toMatchObject({ category: 'chatter' });
      expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
      // The model's own verdict is cached: a copy is chatter too.
      pipeline.ingest(target, { ...channel, comments: [comment('2', 'my tier list guess')] });
      expect(annotations().at(-1)).toMatchObject({ category: 'chatter' });
    });

    it('keeps a spoiler verdict when the stream has spoiler targets', async () => {
      const llama = fakeLlama(echo({ 'the boss dies': 'spoiler' }));
      const { annotations, pipeline } = setup({
        fetch: llama.fetch,
        context: noted('the final boss'),
      });
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'the boss dies')] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(annotations()[0]).toMatchObject({ category: 'spoiler' });
    });

    it('defines the spoiler category in the user turn only when the stream has spoiler targets', async () => {
      const bodies = async (context: ReturnType<typeof noted> | undefined): Promise<ChatBody> => {
        const llama = fakeLlama(echo());
        const { annotations, pipeline } = setup({
          fetch: llama.fetch,
          ...(context === undefined ? {} : { context }),
        });
        pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there')] });
        await vi.waitFor(() => expect(annotations()).toHaveLength(1));
        const [body] = llama.state.bodies;
        if (body === undefined) throw new Error('no request');
        return body;
      };
      const plain = await bodies(undefined);
      const withNote = await bodies(noted('the final boss'));
      expect(plain.messages[1]?.content).not.toContain('- p = spoiler: ');
      expect(withNote.messages[1]?.content).toContain('- p = spoiler: ');
      expect(withNote.messages[0]).toEqual(plain.messages[0]);
      // The grammar allows the spoiler code only where it is defined (R62).
      expect(plain.grammar.split('\n')[1]).toBe('code ::= [asqicrve]');
      expect(withNote.grammar.split('\n')[1]).toBe('code ::= [aspqicrve]');
    });
  });

  it('keeps the newest 200 hidden comments of a channel', async () => {
    const llama = fakeLlama(echo({ 'buy coins at https://example.com/fixture': 'spam' }));
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('s0', 'buy coins at https://example.com/fixture')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // Copies are answered from the text cache, and every one of them is hidden too.
    for (let i = 1; i <= 204; i += 1)
      pipeline.ingest(target, {
        ...channel,
        comments: [comment(`s${i}`, 'buy coins at https://example.com/fixture')],
      });
    const hidden = pipeline.hidden(channel.site, channel.channel);
    expect(hidden).toHaveLength(200);
    expect([hidden[0]?.id, hidden.at(-1)?.id]).toEqual(['s5', 's204']);
  });

  it('judges abuse with the threshold the channel feedback raised', async () => {
    const llama = fakeLlama(echo());
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.85)));
    const feedback = await restored(['fine one', 'fine two', 'fine three']);
    expect(feedback.threshold(channel.site, channel.channel)).toBe(0.9);
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge, feedback });
    // A text with an abuse cue, so Clef is asked about it (R43).
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'what a garbage play')] });
    pipeline.ingest(target, {
      site: 'twitch',
      channel: 'other',
      comments: [comment('2', 'what a garbage play')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations().map((a) => [a.id, a.category])).toEqual([
      ['1', 'chatter'],
      ['2', 'abusive'],
    ]);
  });

  it('shows an allowlisted text as chatter whatever the model, Clef or the text cache say', async () => {
    const llama = fakeLlama(echo({ 'stuff that boss': 'abusive' }));
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.99)));
    const feedback = await restored(['Stuff  that BOSS']);
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge, feedback });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'stuff that boss')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // Back here the cached verdict is judged by the channel's feedback: chatter, no model call.
    pipeline.ingest(target, { ...channel, comments: [comment('3', 'stuff that boss')] });
    expect(llama.state.bodies).toHaveLength(1);
    // Another streamer has its own text cache and its own feedback.
    pipeline.ingest(target, {
      site: 'twitch',
      channel: 'other',
      comments: [comment('2', 'stuff that boss')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(annotations().map((a) => [a.id, a.category, a.state])).toEqual([
      ['1', 'chatter', 'done'],
      ['3', 'chatter', 'done'],
      ['2', 'abusive', 'done'],
    ]);
    expect(llama.state.bodies).toHaveLength(2);
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
    expect(
      pipeline
        .store(channel.site, channel.channel)
        .since(MINUTE)
        .map((r) => r.category),
    ).toEqual(['chatter', 'chatter']);
  });

  it('never asks Clef about an allowlisted text, early or late, and reuses its reply (R53)', async () => {
    const llama = fakeLlama(echo({ 'stuff that boss': 'abusive' }));
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.99)));
    const feedback = await restored(['Stuff  that BOSS', 'what an idiot move']);
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge, feedback });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'stuff that boss'), comment('2', 'what an idiot move')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(judge.judge).not.toHaveBeenCalled();
    expect(annotations().map((a) => a.category)).toEqual(['chatter', 'chatter']);
    // Every copy under this streamer's feedback is allowlisted too: answered from the cache.
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('3', 'stuff that boss'), comment('4', 'what an idiot move')],
    });
    expect(annotations().map((a) => a.category)).toEqual([
      'chatter',
      'chatter',
      'chatter',
      'chatter',
    ]);
    expect([llama.state.bodies.length, judge.judge.mock.calls.length]).toEqual([1, 0]);
  });

  const menaceJudge = () =>
    fakeJudge((texts) => Ok(texts.map((text) => (/menace/iu.test(text) ? 0.9 : 0.1))));
  /** The model calls a menace abusive, so Clef is asked about it after the reply (R43). */
  const menaceLlama = () =>
    fakeLlama((comments) =>
      echo()(comments).map((item, i) =>
        /menace/iu.test(comments[i]?.text ?? '') ? { ...item, category: 'abusive' } : item,
      ),
    );
  const saved = Ok({ persisted: true });

  it('restores a comment marked ok in every frame that shows it and learns the text', async () => {
    const llama = menaceLlama();
    const feedback = createFeedbackStore();
    const { annotations, emitted, pipeline } = setup({
      fetch: llama.fetch,
      judge: menaceJudge(),
      feedback,
    });
    const popout: Target = { tabId: 8, frameId: 0 };
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you are a menace')] });
    pipeline.ingest(popout, { ...channel, comments: [comment('1', 'you are a menace')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations()[0]?.category).toBe('abusive');
    emitted.length = 0;

    expect(await pipeline.review(channel.site, channel.channel, '1', 'ok')).toEqual(saved);
    const shown: Annotation = {
      id: '1',
      translation: '訳:you are a menace',
      category: 'chatter',
      state: 'done',
      override: 'show',
    };
    expect(emitted).toEqual([
      { target, annotations: [shown] },
      { target: popout, annotations: [shown] },
    ]);
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
    expect(pipeline.store(channel.site, channel.channel).since(MINUTE)[0]?.category).toBe(
      'chatter',
    );
    expect([...feedback.allowlist(channel.site, channel.channel)]).toEqual(['you are a menace']);
    // A reloaded frame gets the restored annotation.
    emitted.length = 0;
    pipeline.ingest(
      { tabId: 9, frameId: 0 },
      { ...channel, comments: [comment('1', 'you are a menace')] },
    );
    expect(emitted[0]?.annotations).toEqual([shown]);
    // The streamer's corrections changed, so the next copy is asked again with them in the
    // prompt (R53); the allowlist shows it as chatter, without Clef.
    emitted.length = 0;
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'You are a MENACE')] });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.annotations).toEqual([
      {
        id: '2',
        translation: '訳:You are a MENACE',
        category: 'chatter',
        state: 'done',
      },
    ]);
    expect(llama.state.bodies).toHaveLength(2);
  });

  it('restores a comment marked ok in a frame that only stored it after it was answered (R50, R53)', async () => {
    const llama = menaceLlama();
    const { annotations, emitted, pipeline } = setup({ fetch: llama.fetch, judge: menaceJudge() });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you are a menace')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // Background tabs that only store it get the answer that exists (R50), at most four of them.
    const stores = [8, 9, 10, 11, 12].map((tabId): Target => ({ tabId, frameId: 0 }));
    for (const frame of stores)
      pipeline.ingest(frame, {
        ...channel,
        process: false,
        comments: [comment('1', 'you are a menace')],
      });
    expect(emitted.map((event) => event.target.tabId)).toEqual([7, 8, 9, 10, 11, 12]);
    emitted.length = 0;
    expect(await pipeline.review(channel.site, channel.channel, '1', 'ok')).toEqual(saved);
    // The frame it was processed for, and the four latest that only got its answer.
    expect(emitted.map((event) => [event.target.tabId, event.annotations[0]?.override])).toEqual([
      [7, 'show'],
      [9, 'show'],
      [10, 'show'],
      [11, 'show'],
      [12, 'show'],
    ]);
  });

  it('restores every hidden copy of the text in the channel with one ok', async () => {
    const llama = menaceLlama();
    const feedback = createFeedbackStore();
    const { annotations, emitted, pipeline } = setup({
      fetch: llama.fetch,
      judge: menaceJudge(),
      feedback,
    });
    const popout: Target = { tabId: 8, frameId: 0 };
    pipeline.ingest(target, { ...channel, comments: [comment('a', 'you are a menace')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // The copy is answered from the text cache and hidden too.
    pipeline.ingest(popout, { ...channel, comments: [comment('b', 'YOU ARE A  MENACE')] });
    // Another streamer's copy goes to the model (its own text cache) and is hidden there too.
    pipeline.ingest(target, {
      site: 'twitch',
      channel: 'other',
      comments: [comment('c', 'you are a menace')],
    });
    await vi.waitFor(() => expect(pipeline.hidden('twitch', 'other')).toHaveLength(1));
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.id)).toEqual(['a', 'b']);
    emitted.length = 0;

    expect(await pipeline.review(channel.site, channel.channel, 'a', 'ok')).toEqual(saved);
    expect(emitted.map((event) => [event.target, event.annotations.map((a) => a.id)])).toEqual([
      [target, ['a']],
      [popout, ['b']],
    ]);
    expect(emitted.flatMap((event) => event.annotations).map((a) => a.override)).toEqual([
      'show',
      'show',
    ]);
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
    // Another channel keeps its own copy hidden.
    expect(pipeline.hidden('twitch', 'other').map((h) => h.id)).toEqual(['c']);
    // One verdict was recorded, and the restored copy takes no second one.
    expect(await pipeline.review(channel.site, channel.channel, 'b', 'correct')).toEqual(saved);
    expect(feedback.export().trim().split('\n')).toHaveLength(1);
  });

  it('tells how many hidden comments of a channel wait for a verdict as it changes (R54)', async () => {
    const llama = menaceLlama();
    const counts: string[] = [];
    const { annotations, pipeline } = setup({
      fetch: llama.fetch,
      judge: menaceJudge(),
      feedback: createFeedbackStore(),
      onHiddenChange: (site, name, count) => counts.push(`${site}:${name}=${count}`),
    });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('a', 'you are a menace'), comment('b', 'hello there')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    pipeline.ingest(target, { ...channel, comments: [comment('c', 'such a menace you are')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    const key = `${channel.site}:${channel.channel}`;
    expect(counts).toEqual([`${key}=1`, `${key}=2`]);
    // A verdict, either way, takes the comment off the count.
    expect(await pipeline.review(channel.site, channel.channel, 'c', 'correct')).toEqual(saved);
    expect(counts.at(-1)).toBe(`${key}=1`);
    expect(await pipeline.review(channel.site, channel.channel, 'a', 'ok')).toEqual(saved);
    expect(counts.at(-1)).toBe(`${key}=0`);
    // Clearing the feedback lets the confirmed comment be judged again.
    pipeline.clearVerdicts();
    expect(counts.at(-1)).toBe(`${key}=1`);
    // A pipeline going away (new settings) leaves nothing to count.
    pipeline.dispose();
    expect(counts.at(-1)).toBe(`${key}=0`);
  });

  it.each([
    { first: 'ok', second: 'correct', listed: [] },
    { first: 'ok', second: 'ok', listed: [] },
    { first: 'correct', second: 'ok', listed: [['1', 'correct']] },
    { first: 'correct', second: 'correct', listed: [['1', 'correct']] },
  ] as const)(
    'keeps the first verdict ($first) when $second follows',
    async ({ first, second, listed }) => {
      const llama = menaceLlama();
      const feedback = createFeedbackStore();
      const { annotations, emitted, pipeline } = setup({
        fetch: llama.fetch,
        judge: menaceJudge(),
        feedback,
      });
      pipeline.ingest(target, { ...channel, comments: [comment('1', 'you are a menace')] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(await pipeline.review(channel.site, channel.channel, '1', first)).toEqual(saved);
      emitted.length = 0;
      expect(await pipeline.review(channel.site, channel.channel, '1', second)).toEqual(saved);
      expect(emitted).toEqual([]);
      expect(
        feedback
          .export()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual([expect.objectContaining({ verdict: first })]);
      expect(pipeline.hidden(channel.site, channel.channel).map((h) => [h.id, h.verdict])).toEqual(
        listed,
      );
    },
  );

  it('keeps an ok verdict in effect when its write fails and reports it as not saved yet', async () => {
    const llama = menaceLlama();
    const feedback = createFeedbackStore({
      area: { get: async () => ({}), set: async () => Promise.reject(new Error('quota')) },
    });
    expect((await feedback.load()).ok).toBe(true);
    const { annotations, emitted, pipeline } = setup({
      fetch: llama.fetch,
      judge: menaceJudge(),
      feedback,
    });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you are a menace')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    emitted.length = 0;
    expect(await pipeline.review(channel.site, channel.channel, '1', 'ok')).toEqual(
      Ok({ persisted: false }),
    );
    expect(emitted[0]?.annotations[0]).toMatchObject({ id: '1', override: 'show' });
    expect(feedback.allowlist(channel.site, channel.channel).has('you are a menace')).toBe(true);
  });

  it('records a comment confirmed as correct and keeps it hidden', async () => {
    const llama = fakeLlama(echo({ 'buy coins at https://example.com/fixture': 'spam' }));
    const feedback = createFeedbackStore();
    const { annotations, emitted, pipeline } = setup({ fetch: llama.fetch, feedback });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        {
          id: '1',
          author: 'Secret Viewer',
          text: 'buy coins at https://example.com/fixture',
          at: START,
        },
      ],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    emitted.length = 0;
    expect(await pipeline.review(channel.site, channel.channel, '1', 'correct')).toEqual(saved);
    expect(emitted).toEqual([]);
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
      expect.objectContaining({ id: '1', category: 'spam', verdict: 'correct' }),
    ]);
    expect(feedback.allowlist(channel.site, channel.channel).size).toBe(0);
    expect(JSON.parse(feedback.export())).toMatchObject({
      text: 'buy coins at https://example.com/fixture',
      category: 'spam',
      verdict: 'correct',
    });
    expect(feedback.export()).not.toContain('Secret Viewer');
  });

  it('answers resource_missing for a comment that is not in the hidden list', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    for (const [site, name, id] of [
      [channel.site, channel.channel, '1'],
      [channel.site, channel.channel, 'unknown'],
      ['twitch', 'unknown', '1'],
    ] as const)
      expect(await pipeline.review(site, name, id, 'ok')).toMatchObject({
        ok: false,
        error: { internalCode: 'resource_missing' },
      });
  });

  it("puts the channel's corrections into its batch prompts only", async () => {
    const llama = fakeLlama(echo());
    const feedback = await restored(['stuff that boss']);
    const { annotations, pipeline } = setup({ fetch: llama.fetch, feedback });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello')] });
    pipeline.ingest(target, {
      site: 'twitch',
      channel: 'other',
      comments: [comment('2', 'hello there')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    const corrections = llama.state.bodies.map((body) =>
      body.messages[1]?.content.split('\n').find((line) => line.startsWith('Viewer corrections')),
    );
    expect(corrections).toEqual([
      `Viewer corrections (JSON): ${JSON.stringify([{ text: 'stuff that boss', wrong: 'abusive' }])}`,
      undefined,
    ]);
  });

  /** Streams a1 and a2 of streamer @alpha (same title), a3 of @alpha (another title), b1 of @beta. */
  const streams = (site: StreamContext['site'], partition: string): StreamContext =>
    ({
      a1: { site, partition, streamer: '@alpha', title: 'Fixture Quest' },
      a2: { site, partition, streamer: '@alpha', title: 'Fixture Quest' },
      a3: { site, partition, streamer: '@alpha', title: 'Fixture Racing' },
      b1: { site, partition, streamer: '@beta', title: 'Fixture Quest' },
    })[partition] ?? titled(site, partition);

  it('keys the text cache by streamer and stream context', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch, context: streams });
    const say = (partition: string, id: string): void =>
      void pipeline.ingest(target, {
        site: 'youtube',
        channel: partition,
        comments: [comment(id, 'What a jump')],
      });
    say('a1', '1');
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // Same streamer, same context: answered from the cache at once.
    say('a2', '2');
    expect(annotations()).toHaveLength(2);
    expect(llama.state.bodies).toHaveLength(1);
    // Another title (context) or another streamer asks the model again.
    say('a3', '3');
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    say('b1', '4');
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
    expect(llama.state.bodies).toHaveLength(3);
    expect(llama.state.bodies.map((body) => body.messages[1]?.content.split('\n')[0])).toEqual([
      'Stream context: "Title: Fixture Quest"',
      'Stream context: "Title: Fixture Racing"',
      'Stream context: "Title: Fixture Quest"',
    ]);
  });

  it("asks the model again after the streamer's corrections changed (R53)", async () => {
    const llama = fakeLlama(echo({ 'buy coins at https://example.com/fixture': 'spam' }));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, context: streams });
    const say = (partition: string, id: string, text: string): void =>
      void pipeline.ingest(target, {
        site: 'youtube',
        channel: partition,
        comments: [comment(id, text)],
      });
    pipeline.ingest(target, {
      site: 'youtube',
      channel: 'a1',
      comments: [
        comment('1', 'What a jump'),
        comment('2', 'buy coins at https://example.com/fixture'),
      ],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(llama.state.bodies).toHaveLength(1);
    await pipeline.review('youtube', 'a1', '2', 'ok');
    // The batch prompts carry the new correction, so an answer cached before is not reused.
    say('a2', '3', 'What a jump');
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
    expect(llama.state.bodies).toHaveLength(2);
    expect(llama.state.bodies[1]?.messages[1]?.content).toContain(
      'buy coins at https://example.com/fixture',
    );
    // Under the same corrections the new answer is reused.
    say('a1', '4', 'What a jump');
    expect(annotations()).toHaveLength(5);
    expect(llama.state.bodies).toHaveLength(2);
  });

  it("learns a streamer's verdict in every stream of that streamer, and only there", async () => {
    const llama = menaceLlama();
    const feedback = createFeedbackStore();
    const { annotations, pipeline } = setup({
      fetch: llama.fetch,
      judge: menaceJudge(),
      feedback,
      context: streams,
    });
    const say = (partition: string, id: string, text: string): void =>
      void pipeline.ingest(target, {
        site: 'youtube',
        channel: partition,
        comments: [comment(id, text)],
      });
    const category = (id: string) => annotations().findLast((a) => a.id === id)?.category;
    say('a1', '1', 'you are a menace');
    await vi.waitFor(() => expect(category('1')).toBe('abusive'));
    expect(await pipeline.review('youtube', 'a1', '1', 'ok')).toEqual(saved);
    // The verdict belongs to the streamer, not to the one stream.
    expect(feedback.allowlist('youtube', '@alpha').has('you are a menace')).toBe(true);
    expect(feedback.allowlist('youtube', 'a1').size).toBe(0);

    // Another stream of @alpha: the text stays visible; @beta still has it judged by Clef.
    say('a2', '2', 'You are a MENACE');
    say('b1', '3', 'you are a menace');
    await vi.waitFor(() => expect(category('3')).toBe('abusive'));
    expect(category('2')).toBe('chatter');
    expect(pipeline.hidden('youtube', 'a2')).toEqual([]);
    // @alpha's corrections reach its other streams' prompts (the copy in a2 was asked again
    // with them, R53); @beta's prompt has none.
    say('a3', '4', 'hello there');
    await vi.waitFor(() => expect(category('4')).toBe('chatter'));
    const corrections = llama.state.bodies.map((body) =>
      body.messages[1]?.content.split('\n').some((line) => line.startsWith('Viewer corrections')),
    );
    expect(corrections).toEqual([false, true, false, true]);
  });

  it('forgets the confirmations when the feedback is cleared; restored comments stay shown', async () => {
    const llama = menaceLlama();
    const feedback = createFeedbackStore();
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge: menaceJudge(), feedback });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'you are a menace'), comment('2', 'such a menace')],
    });
    await vi.waitFor(() => expect(pipeline.hidden(channel.site, channel.channel)).toHaveLength(2));
    expect(await pipeline.review(channel.site, channel.channel, '1', 'correct')).toEqual(saved);
    expect(await pipeline.review(channel.site, channel.channel, '2', 'ok')).toEqual(saved);
    expect(pipeline.hidden(channel.site, channel.channel)).toMatchObject([
      { id: '1', verdict: 'correct' },
    ]);
    await feedback.clear();
    pipeline.clearVerdicts();
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
      expect.not.objectContaining({ verdict: expect.anything() }),
    ]);
    // It can be judged again, and that verdict is recorded.
    expect(await pipeline.review(channel.site, channel.channel, '1', 'correct')).toEqual(saved);
    expect(feedback.export().trim().split('\n')).toHaveLength(1);
    expect(
      annotations()
        .filter((a) => a.override === 'show')
        .map((a) => a.id),
    ).toEqual(['2']);
  });

  it('releases its timer, requests and stores on dispose', async () => {
    const llama = hangingLlama();
    const { clock, emitted, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment('1', 'alpha'),
        comment('2', 'bravo'),
        comment('3', 'charlie'),
        comment('4', 'delta'),
      ],
    });
    await vi.waitFor(() => expect(llama.state.requests).toBe(1));
    const store = pipeline.store(channel.site, channel.channel);
    pipeline.dispose();
    await vi.waitFor(() => expect(llama.state.aborted).toBe(1));
    expect([clock.active(), store.size(), emitted.length]).toEqual([0, 0, 0]);
    expect(pipeline.ingest(target, { ...channel, comments: [comment('5', 'echo')] })).toEqual({
      accepted: 0,
      dropped: 0,
    });
    expect(clock.active()).toBe(0);
  });
});

describe('live-stream accuracy (R38)', () => {
  const role = (id: string, text: string, author: RawComment['role'] | undefined): RawComment => ({
    ...comment(id, text),
    ...(author === undefined ? {} : { role: author }),
  });

  it.each([
    // A Latin comment needs a question mark or a question word for the model's question to stand.
    { text: 'play the next song please', expected: 'chatter' },
    { text: 'need more ammo', expected: 'chatter' },
    { text: '@Rin go left', expected: 'chatter' },
    { text: 'what level is this', expected: 'question' },
    { text: '@Rin how did you get there', expected: 'question' },
    { text: 'the boss has two phases?', expected: 'question' },
    { text: 'cómo se llama el juego', expected: 'question' },
    // Never applied to Japanese: the model's verdict stands.
    { text: '次の曲お願い', expected: 'question' },
    { text: 'このボスどうやって倒すの', expected: 'question' },
  ])("keeps the model's question on $text only as $expected", async ({ text, expected }) => {
    const llama = fakeLlama((comments) =>
      comments.map((c) => ({
        id: c.id,
        category: 'question',
        ...(c.translate ? { ja: `訳:${c.text}` } : {}),
      })),
    );
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', text)] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // A copy answered from the text cache is judged the same way.
    pipeline.ingest(target, { ...channel, comments: [comment('2', text)] });
    expect(annotations().map((a) => a.category)).toEqual([expected, expected]);
    expect(llama.state.bodies).toHaveLength(1);
  });

  it.each([
    // The streamer's own post with a link that the model took for spam.
    {
      author: 'owner',
      text: 'now playing → https://example.com/watch/fixture',
      llm: 'spam',
      score: 0.1,
      expected: 'important',
    },
    {
      author: 'moderator',
      text: 'new merch drop tonight',
      llm: 'spam',
      score: 0.1,
      expected: 'important',
    },
    {
      author: 'moderator',
      text: 'rules are at https://example.com/rules',
      llm: 'chatter',
      score: 0.1,
      expected: 'important',
    },
    // Clef and the model never make their posts abusive or a spoiler; anything else stands.
    {
      author: 'verified',
      text: 'you lost again',
      llm: 'abusive',
      score: 0.95,
      expected: 'chatter',
    },
    {
      author: 'owner',
      text: 'the boss dies at the end',
      llm: 'spoiler',
      score: 0.1,
      expected: 'chatter',
    },
    // An abuse cue, so Clef is asked and scores it high (R43): still the moderator's question.
    {
      author: 'moderator',
      text: 'who is ready for round two, losers?',
      llm: 'question',
      score: 0.9,
      expected: 'question',
    },
    {
      author: 'owner',
      text: 'thanks for coming everyone',
      llm: 'chatter',
      score: 0.1,
      expected: 'chatter',
    },
    // Everyone else: as before, but the model's spam needs a link (R60).
    {
      author: undefined,
      text: 'new merch at https://example.com/merch',
      llm: 'spam',
      score: 0.1,
      expected: 'spam',
    },
    {
      author: undefined,
      text: 'new merch drop tonight',
      llm: 'spam',
      score: 0.1,
      expected: 'chatter',
    },
    {
      author: undefined,
      text: 'rules are at https://example.com/rules',
      llm: 'chatter',
      score: 0.1,
      expected: 'chatter',
    },
    {
      author: undefined,
      text: 'you lost again loser',
      llm: 'chatter',
      score: 0.95,
      expected: 'abusive',
    },
  ] as const)(
    'shows a post by $author the model called $llm (Clef $score) as $expected',
    async ({ author, text, llm, score, expected }) => {
      const llama = fakeLlama(echo({ [text]: llm }));
      const judge = fakeJudge((texts) => Ok(texts.map(() => score)));
      const { annotations, pipeline } = setup({
        fetch: llama.fetch,
        judge,
        context: (site, partition) => ({
          ...titled(site, partition),
          spoilerNote: 'the final boss',
        }),
      });
      pipeline.ingest(target, { ...channel, comments: [role('1', text, author)] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      // A role never skips translation.
      expect(promptComments(llama.state.bodies[0] as ChatBody)).toEqual([
        { id: 1, lang: 'und-Latn', translate: true, text },
      ]);
      expect(annotations()).toEqual([
        { id: '1', translation: `訳:${text}`, category: expected, state: 'done' },
      ]);
      expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.category)).toEqual(
        ['abusive', 'spam', 'spoiler'].includes(expected) ? [expected] : [],
      );
    },
  );

  it("keeps a viewer's cached spam verdict from hiding a moderator's copy, and the other way round", async () => {
    const llama = fakeLlama(echo({ 'join my fan club tonight': 'spam' }));
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.1)));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    // A viewer first: the model's spam without a link is chat (R60), and the moderator's copy of
    // the cached verdict is important (R53 M1).
    pipeline.ingest(target, {
      ...channel,
      comments: [role('1', 'join my fan club tonight', undefined)],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    pipeline.ingest(target, {
      ...channel,
      comments: [role('2', 'join my fan club tonight', 'moderator')],
    });
    // A moderator first on another text: a viewer's later copy is chat again.
    const other = { site: 'twitch', channel: 'fixture-other' } as const;
    pipeline.ingest(target, {
      ...other,
      comments: [role('3', 'join my fan club tonight', 'moderator')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    pipeline.ingest(target, {
      ...other,
      comments: [role('4', 'join my fan club tonight', undefined)],
    });
    expect(annotations().map((a) => [a.id, a.category])).toEqual([
      ['1', 'chatter'],
      ['2', 'important'],
      ['3', 'important'],
      ['4', 'chatter'],
    ]);
    // One model call per channel scope; the copies came from the text cache.
    expect(llama.state.bodies).toHaveLength(2);
    // Nothing is hidden: link-less model spam is chat for viewers, and important for roles.
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
    expect(pipeline.hidden(other.site, other.channel)).toEqual([]);
  });

  it('never makes a role comment abusive when its line failed and Clef scored it high', async () => {
    const llama = fakeLlama(echo());
    llama.state.down = true;
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.95)));
    const { clock, annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        role('1', 'you lost again loser', 'moderator'),
        role('2', 'you lost again loser!', undefined),
      ],
    });
    clock.advance(500);
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations()).toEqual([
      { id: '1', category: 'chatter', state: 'failed' },
      { id: '2', category: 'abusive', state: 'failed' },
    ]);
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.id)).toEqual(['2']);
    // Only the viewer's comment went to Clef (R53).
    expect(judge.judge.mock.calls.map(([texts]) => texts)).toEqual([['you lost again loser!']]);
  });

  it('sends stretched letters to the model as two and keeps the original everywhere else (R40)', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment('1', 'VAMOOOOOS'),
        comment('2', 'LETSGOOOO team'),
        comment('3', 'すごいいいいい'),
      ],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(promptComments(llama.state.bodies[0] as ChatBody).map((c) => c.text)).toEqual([
      'VAMOOS',
      'LETSGOO team',
      'すごいい',
    ]);
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => record.text)).toEqual([
      'VAMOOOOOS',
      'LETSGOOOO team',
      'すごいいいいい',
    ]);
    // Another stretch of the same text has the same cache key: answered without the model.
    pipeline.ingest(target, { ...channel, comments: [comment('4', 'vamoooooooooos')] });
    expect(annotations().at(-1)).toEqual({
      id: '4',
      translation: '訳:VAMOOS',
      category: 'chatter',
      state: 'done',
    });
    expect(llama.state.bodies).toHaveLength(1);
  });

  it("shows a moderator's copypasta as chatter, one with a link as important, a viewer's as spam (R53)", () => {
    const fetch = vi.fn<Fetch>();
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.97)));
    const { annotations, pipeline } = setup({ fetch, judge });
    const text =
      'read the rules before posting read the rules before posting read the rules before posting';
    const link =
      'merch at https://example.com/shop merch at https://example.com/shop merch at https://example.com/shop';
    const abuse = '配信者は今すぐ死ね 配信者は今すぐ死ね 配信者は今すぐ死ね';
    pipeline.ingest(target, {
      ...channel,
      comments: [
        role('1', text, 'moderator'),
        role('2', text, undefined),
        role('3', link, 'owner'),
        role('4', abuse, 'verified'),
      ],
    });
    expect(annotations()).toEqual([
      { id: '1', category: 'chatter', state: 'done' },
      { id: '2', category: 'spam', state: 'done' },
      { id: '3', category: 'important', state: 'done' },
      { id: '4', category: 'chatter', state: 'done' },
    ]);
    // A role's copypasta, with an abuse cue or not, never goes to the model or Clef.
    expect(fetch).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.id)).toEqual(['2']);
  });

  it('never asks Clef about a role comment, early or late (R53)', async () => {
    const llama = fakeLlama(
      echo({ 'you lost again loser': 'abusive', 'get out of here now': 'abusive' }),
    );
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.95)));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        role('1', 'you lost again loser', 'moderator'),
        role('2', 'get out of here now', 'owner'),
      ],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(judge.judge).not.toHaveBeenCalled();
    expect(annotations().map((a) => a.category)).toEqual(['chatter', 'chatter']);
    // Not reused for a viewer's copy: that one needs Clef.
    pipeline.ingest(target, {
      ...channel,
      comments: [role('3', 'you lost again loser', undefined)],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(judge.judge.mock.calls.map(([texts]) => texts)).toEqual([['you lost again loser']]);
    expect(annotations().at(-1)).toMatchObject({ id: '3', category: 'abusive' });
  });

  it('shows a comment that expired ending in a question mark as a question by rule, untranslated', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'running')] });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment('2', 'is this the last stage?'),
        comment('3', 'まだ？'),
        comment('4', 'two phases? really'),
        comment('5', 'old one'),
      ],
    });
    clock.advance(8_000);
    pipeline.ingest(target, { ...channel, comments: [comment('6', 'young')] });
    clock.advance(500);
    expect(annotations()).toEqual([
      { id: '2', category: 'question', state: 'skipped' },
      { id: '3', category: 'question', state: 'skipped' },
      { id: '4', category: 'chatter', state: 'skipped' },
      { id: '5', category: 'chatter', state: 'skipped' },
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ expired: 4 });
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => [record.id, record.state, record.category])).toEqual([
      ['2', 'skipped', 'question'],
      ['3', 'skipped', 'question'],
      ['4', 'skipped', undefined],
      ['5', 'skipped', undefined],
    ]);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(6));
    // Never sent to the model, so never cached: a later copy goes to the model.
    pipeline.ingest(target, { ...channel, comments: [comment('7', 'is this the last stage?')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(7));
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['running'],
      ['young'],
      ['is this the last stage?'],
    ]);
  });
});

describe('live-stream accuracy, second test (R60)', () => {
  it("keeps the model's spam only on a comment with a link, fresh or from the text cache", async () => {
    const texts = [
      'so many ads today',
      'mute the tab during ads',
      'free skins at https://example.com/fixture',
      'cheap coins www.example.com',
    ];
    const llama = fakeLlama(echo(Object.fromEntries(texts.map((text) => [text, 'spam']))));
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: texts.slice(0, 3).map((text, i) => comment(`${i + 1}`, text)),
    });
    pipeline.ingest(target, { ...channel, comments: [comment('4', texts[3] ?? '')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
    // Copies answered from the text cache are judged the same way.
    pipeline.ingest(target, {
      ...channel,
      comments: texts.map((text, i) => comment(`copy-${i + 1}`, text)),
    });
    expect(annotations().map((a) => [a.id, a.category])).toEqual([
      ['1', 'chatter'],
      ['2', 'chatter'],
      ['3', 'spam'],
      ['4', 'spam'],
      ['copy-1', 'chatter'],
      ['copy-2', 'chatter'],
      ['copy-3', 'spam'],
      ['copy-4', 'spam'],
    ]);
    expect(llama.state.bodies).toHaveLength(2);
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => [h.id, h.source])).toEqual([
      ['3', 'model'],
      ['4', 'model'],
      ['copy-3', 'model'],
      ['copy-4', 'model'],
    ]);
  });

  it('keeps copypasta without a link spam by rule', () => {
    const fetch = vi.fn<Fetch>();
    const { annotations, pipeline } = setup({ fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'mute the ads mute the ads mute the ads mute the ads')],
    });
    expect(annotations()).toEqual([{ id: '1', category: 'spam', state: 'done' }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Comments of a batch as the model was asked about them: text, language and translation. */
  const asked = (body: ChatBody | undefined): [string, string, boolean][] =>
    body === undefined ? [] : promptComments(body).map((c) => [c.text, c.lang, c.translate]);

  it('reads kanji-only comments as Japanese in a mostly Japanese channel: classified, not translated', async () => {
    const llama = fakeLlama(echo({ 主人公: 'question' }));
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    const english = { site: 'twitch', channel: 'fixture-english' } as const;
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'こんにちは'), comment('2', 'がんばれ'), comment('3', '主人公')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    pipeline.ingest(target, {
      ...english,
      comments: [comment('4', 'nice play'), comment('5', 'what a run'), comment('6', '主人公?')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(6));
    // 3 Japanese of 6: still Japanese enough; a Chinese word stays Chinese.
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('7', 'すごい'), comment('8', '完璧'), comment('9', '加油')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(9));
    expect(llama.state.bodies.map(asked)).toEqual([
      [
        ['こんにちは', 'ja', false],
        ['がんばれ', 'ja', false],
        ['主人公', 'ja', false],
      ],
      [
        ['nice play', 'und-Latn', true],
        ['what a run', 'und-Latn', true],
        ['主人公?', 'zh', true],
      ],
      [
        ['すごい', 'ja', false],
        ['完璧', 'ja', false],
        ['加油', 'zh', true],
      ],
    ]);
    // The model still classifies it.
    expect(annotations().find((a) => a.id === '3')).toEqual({
      id: '3',
      category: 'question',
      state: 'done',
    });
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => [record.id, record.lang])).toEqual([
      ['1', 'ja'],
      ['2', 'ja'],
      ['3', 'ja'],
      ['7', 'ja'],
      ['8', 'ja'],
      ['9', 'zh'],
    ]);
  });

  it('counts the languages the detector found, not the ones the channel gave kanji-only text', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    // 1 Japanese of 3: kanji-only text stays Chinese.
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'がんばれ'), comment('2', 'nice'), comment('3', '主人公')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    // 3 Japanese of 6 (the kanji-only line counted as Chinese): now it is Japanese.
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('4', 'きたー'), comment('5', 'すごい'), comment('6', '神回')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(6));
    // 3 Japanese of 8, the line read as Japanese counted as Chinese: Chinese again (4 of 8
    // had it counted as Japanese).
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('7', 'gg wp all'), comment('8', '完璧')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(8));
    expect(llama.state.bodies.map((body) => asked(body).at(-1))).toEqual([
      ['主人公', 'zh', true],
      ['神回', 'ja', false],
      ['完璧', 'zh', true],
    ]);
  });

  it.each([
    { text: 'WHAT??', expected: 'chatter' },
    { text: 'UM????', expected: 'chatter' },
    { text: 'huhhh?!', expected: 'chatter' },
    { text: 'why?', expected: 'question' },
    { text: 'what is this?', expected: 'question' },
  ])(
    "keeps the model's question on the interjection $text only as $expected",
    async ({ text, expected }) => {
      const llama = fakeLlama((comments) =>
        comments.map((c) => ({
          id: c.id,
          category: 'question',
          ...(c.translate ? { ja: `訳:${c.text}` } : {}),
        })),
      );
      const { annotations, pipeline } = setup({ fetch: llama.fetch });
      pipeline.ingest(target, { ...channel, comments: [comment('1', text)] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      pipeline.ingest(target, { ...channel, comments: [comment('2', text)] });
      expect(annotations().map((a) => a.category)).toEqual([expected, expected]);
    },
  );

  it('shows an interjection that expired with a question mark as chat, not a question by rule', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'running')] });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('2', 'WHAT??'), comment('3', 'why?')],
    });
    clock.advance(8_000);
    pipeline.ingest(target, { ...channel, comments: [comment('4', 'young')] });
    clock.advance(500);
    expect(annotations()).toEqual([
      { id: '2', category: 'chatter', state: 'skipped' },
      { id: '3', category: 'question', state: 'skipped' },
    ]);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
  });
});

describe('fast English chat (R39)', () => {
  it('answers emote-only comments by rule, untranslated, without the model or Clef', () => {
    const fetch = vi.fn<Fetch>();
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.9)));
    const { emitted, pipeline } = setup({ fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [
        comment('1', 'PauseChamp'),
        comment('2', 'KEKW Sadge'),
        comment('3', 'PepeLaugh hahahaha'),
        comment('4', 'catJAM catJAM catJAM catJAM catJAM'),
        comment('5', 'HAHAHAHA'),
      ],
    });
    expect(emitted).toEqual([
      {
        target,
        annotations: ['1', '2', '3', '4', '5'].map((id) => ({
          id,
          category: 'chatter',
          state: 'done',
        })),
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      records: 5,
      pending: 0,
      trivial: 5,
      clefSkipped: 0,
    });
  });

  it('caches a lone word answered without Clef and answers its copies from the cache', async () => {
    const llama = fakeLlama(echo());
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.1)));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'HOLD')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'hold')] });
    expect(annotations().at(-1)).toEqual({
      id: '2',
      translation: '訳:HOLD',
      category: 'chatter',
      state: 'done',
    });
    expect(llama.state.bodies).toHaveLength(1);
    expect(judge.judge).not.toHaveBeenCalled();
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      cached: 1,
      clefSkipped: 1,
    });
  });

  it('counts no Clef skips while the model judges abuse for every comment', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge: llmCategoryJudge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'HOLD')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      judge: 'llm',
      clefSkipped: 0,
    });
  });
});

describe('Clef only where it matters (R43)', () => {
  it('asks Clef, while the model runs, only about the comments with an abuse cue', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const arrived = { chat: 0 };
    const fetch: Fetch = async (input, init) => {
      arrived.chat += 1;
      await door.opened;
      return llama.fetch(input, init);
    };
    const judge = {
      mode: 'clef' as const,
      judge: vi.fn<ToxicityJudge['judge']>(async (texts) => {
        await door.opened;
        return Ok(texts.map((text) => (text === 'IDIOT' ? 0.95 : 0.1)));
      }),
    };
    const { annotations, pipeline } = setup({ fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'IDIOT'), comment('2', 'HOLDDDD!!'), comment('3', 'nice play')],
    });
    await vi.waitFor(() => expect([judge.judge.mock.calls.length, arrived.chat]).toEqual([1, 1]));
    expect(judge.judge).toHaveBeenCalledWith(['IDIOT'], expect.anything());
    expect(annotations()).toEqual([]);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(annotations().map((a) => [a.id, a.category, a.translation])).toEqual([
      ['1', 'abusive', '訳:IDIOT'],
      ['2', 'chatter', '訳:HOLDD!!'],
      ['3', 'chatter', '訳:nice play'],
    ]);
    const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
    expect(stored.map((record) => [record.id, record.abusive])).toEqual([
      ['1', 0.95],
      ['2', undefined],
      ['3', undefined],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ clefSkipped: 2 });
  });

  it("settles a comment without a cue by the model's category alone and caches it", async () => {
    const llama = fakeLlama(echo({ 'is this the final boss?': 'question' }));
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.9)));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'is this the final boss?'), comment('2', 'nice play')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('3', 'is this the final boss?'), comment('4', 'nice play')],
    });
    expect(annotations().map((a) => [a.id, a.category])).toEqual([
      ['1', 'question'],
      ['2', 'chatter'],
      ['3', 'question'],
      ['4', 'chatter'],
    ]);
    expect(judge.judge).not.toHaveBeenCalled();
    expect(llama.state.bodies).toHaveLength(1);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      cached: 2,
      clefSkipped: 2,
    });
  });

  it.each([
    { score: 0.95, category: 'abusive', source: 'clef' },
    { score: 0.3, category: 'chatter', source: undefined },
  ])(
    'asks Clef after the reply about a comment without a cue the model called abusive, and shows it once Clef answers ($score)',
    async ({ score, category, source }) => {
      const door = gate();
      const events: string[] = [];
      const llama = fakeLlama(echo({ 'go away now': 'abusive' }));
      const fetch: Fetch = async (input, init) => {
        events.push('chat');
        const reply = await llama.fetch(input, init);
        events.push('reply');
        return reply;
      };
      const judge = {
        mode: 'clef' as const,
        judge: vi.fn<ToxicityJudge['judge']>(async (texts) => {
          events.push(`clef:${texts.join('|')}`);
          await door.opened;
          return Ok(texts.map(() => score));
        }),
      };
      const { annotations, pipeline } = setup({ fetch, judge });
      pipeline.ingest(target, {
        ...channel,
        comments: [comment('1', 'go away now'), comment('2', 'nice play')],
      });
      await vi.waitFor(() => expect(judge.judge).toHaveBeenCalledTimes(1));
      expect(events).toEqual(['chat', 'reply', 'clef:go away now']);
      // The model's abusive verdict is not shown before Clef answers.
      expect(annotations().map((a) => a.id)).not.toContain('1');
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(2));
      expect(annotations().find((a) => a.id === '1')?.category).toBe(category);
      expect(annotations().find((a) => a.id === '2')?.category).toBe('chatter');
      const stored = pipeline.store(channel.site, channel.channel).since(MINUTE);
      expect(stored.map((record) => [record.id, record.abusive])).toEqual([
        ['1', score],
        ['2', undefined],
      ]);
      expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.source)).toEqual(
        source === undefined ? [] : [source],
      );
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ clefSkipped: 1 });
    },
  );

  it('asks Clef once about a comment with a cue the model also called abusive', async () => {
    const llama = fakeLlama(echo({ 'you idiot': 'abusive' }));
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.2)));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'you idiot')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(annotations()[0]?.category).toBe('chatter');
  });

  it("keeps the model's abusive verdict when Clef fails after the reply, and asks again for a copy", async () => {
    const llama = fakeLlama(echo({ 'go away now': 'abusive' }));
    const judge = fakeJudge(() => Err(failure('response_invalid')));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'go away now')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]).toEqual({
      id: '1',
      category: 'abusive',
      state: 'done',
      translation: '訳:go away now',
    });
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.source)).toEqual(['model']);
    // Clef was asked and did not answer: the reply is not reused.
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'go away now')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(llama.state.bodies).toHaveLength(2);
    expect(judge.judge).toHaveBeenCalledTimes(2);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      cached: 0,
      judgeError: 'response_invalid',
    });
  });

  it('ends a batch waiting for Clef after the reply on dispose, showing and storing nothing', async () => {
    const llama = fakeLlama(echo({ 'go away now': 'abusive' }));
    const signals: AbortSignal[] = [];
    const judge = {
      mode: 'clef' as const,
      judge: vi.fn<ToxicityJudge['judge']>(
        (_texts, signal) =>
          new Promise((resolve) => {
            if (signal) signals.push(signal);
            signal?.addEventListener('abort', () => resolve(Err(failure('operation_cancelled'))), {
              once: true,
            });
          }),
      ),
    };
    const { clock, emitted, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'go away now')] });
    await vi.waitFor(() => expect(judge.judge).toHaveBeenCalledTimes(1));
    expect(llama.state.bodies).toHaveLength(1);
    const store = pipeline.store(channel.site, channel.channel);
    pipeline.dispose();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([emitted.length, store.size(), clock.active()]).toEqual([0, 0, 0]);
  });

  it('switches to the LLM category when Clef proves unavailable after the reply, and caches it', async () => {
    const llama = fakeLlama(echo({ 'go away now': 'abusive' }));
    const judge = fakeJudge(() => Err(failure('clef_unavailable')));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'go away now')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]?.category).toBe('abusive');
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.source)).toEqual(['model']);
    // The LLM category judges abuse from now on, so the reply is reused for a copy.
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'go away now')] });
    expect(annotations().at(-1)).toMatchObject({ id: '2', category: 'abusive', state: 'done' });
    expect(llama.state.bodies).toHaveLength(1);
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      judge: 'llm',
      cached: 1,
    });
  });

  it('caches the rest of a batch whose Clef call failed for its comment with a cue', async () => {
    const llama = fakeLlama(echo());
    const judge = fakeJudge(() => Err(failure('response_invalid')));
    const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'you idiot'), comment('2', 'nice play')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(annotations().map((a) => [a.id, a.category, a.state])).toEqual([
      ['1', 'chatter', 'done'],
      ['2', 'chatter', 'done'],
    ]);
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('3', 'you idiot'), comment('4', 'nice play')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
    // The copy of the cued comment goes to the model and Clef again; the other one is cached.
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['you idiot', 'nice play'],
      ['you idiot'],
    ]);
    expect(judge.judge.mock.calls.map(([texts]) => texts)).toEqual([['you idiot'], ['you idiot']]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ cached: 1 });
  });
});

describe('first-annotation latency (R53)', () => {
  it('reports the median time to the first annotation of the comments that waited for the model (R55)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    // Ten answers by rule and from the cache at once: none waited for the model.
    pipeline.ingest(target, {
      ...channel,
      comments: Array.from({ length: 10 }, (_v, i) => comment(`r${i}`, i % 2 === 0 ? 'lol' : '👍')),
    });
    expect(annotations()).toHaveLength(10);
    expect(pipeline.stats(channel.site, channel.channel).latencyP50Ms).toBeUndefined();
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'hello there'), comment('2', 'nice play'), comment('3', 'good luck')],
    });
    // Only stored: no annotation, no latency.
    pipeline.ingest(target, {
      ...channel,
      process: false,
      comments: [comment('4', 'stored line')],
    });
    clock.advance(500);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(13));
    expect(pipeline.stats(channel.site, channel.channel).latencyP50Ms).toBe(500);
  });

  it('counts a comment that expired while waiting for the model', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'running')] });
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'still waiting here')] });
    clock.advance(8_001);
    expect(annotations()).toEqual([{ id: '2', category: 'chatter', state: 'skipped' }]);
    expect(pipeline.stats(channel.site, channel.channel).latencyP50Ms).toBe(8_001);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
  });
});

describe('abusive copypasta (R53)', () => {
  const texts = [
    '配信者は今すぐ死ね 配信者は今すぐ死ね 配信者は今すぐ死ね',
    'you are a stupid idiot you are a stupid idiot you are a stupid idiot',
  ];

  it.each(texts)(
    'keeps %s the rule spam when it expires waiting for the model (R55)',
    async (text) => {
      const door = gate();
      const llama = fakeLlama(echo());
      const judge = fakeJudge((asked) => Ok(asked.map(() => 0.97)));
      const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door), judge });
      pipeline.ingest(target, { ...channel, comments: [comment('busy', 'hello there friend')] });
      pipeline.ingest(target, { ...channel, comments: [comment('x', text, START + 1)] });
      clock.advance(8_001);
      expect(annotations()).toEqual([{ id: 'x', category: 'spam', state: 'skipped' }]);
      expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
        { id: 'x', ...channel, text, category: 'spam', source: 'rule', at: START + 1 },
      ]);
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ expired: 1 });
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    },
  );

  it('keeps a cued copypasta the rule spam when it is dropped under a flood (R55)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const judge = fakeJudge((asked) => Ok(asked.map(() => 0.97)));
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door), judge });
    const text = texts[0] ?? '';
    pipeline.ingest(target, { ...channel, comments: [comment('busy', 'hello there friend')] });
    pipeline.ingest(target, { ...channel, comments: [comment('x', text, START + 1)] });
    pipeline.ingest(target, {
      ...channel,
      comments: Array.from({ length: 200 }, (_v, i) => comment(`n${i}`, `line number ${i}`)),
    });
    expect(annotations().find((a) => a.id === 'x')).toEqual({
      id: 'x',
      category: 'spam',
      state: 'skipped',
    });
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
      { id: 'x', ...channel, text, category: 'spam', source: 'rule', at: START + 1 },
    ]);
    expect(pipeline.stats(channel.site, channel.channel).dropped).toBeGreaterThan(0);
    door.open();
  });

  it.each(texts)(
    'asks Clef with the batch about %s and hides it as abusive at a high score',
    async (text) => {
      const llama = fakeLlama(echo());
      const judge = fakeJudge((asked) => Ok(asked.map(() => 0.97)));
      const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
      pipeline.ingest(target, { ...channel, comments: [comment('1', text, START + 1)] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(judge.judge).toHaveBeenCalledWith([text], expect.anything());
      expect(llama.state.bodies).toHaveLength(1);
      expect(annotations()[0]).toMatchObject({ id: '1', category: 'abusive', state: 'done' });
      expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
        expect.objectContaining({ id: '1', category: 'abusive', abusive: 0.97, source: 'clef' }),
      ]);
      // A copy is answered from the cache with Clef's score, without the model or Clef.
      pipeline.ingest(target, { ...channel, comments: [comment('2', text)] });
      expect(annotations().at(-1)).toMatchObject({ id: '2', category: 'abusive' });
      expect([llama.state.bodies.length, judge.judge.mock.calls.length]).toEqual([1, 1]);
    },
  );

  it.each([
    { text: texts[0], answer: Ok([0.2]), abusive: 0.2 },
    { text: texts[1], answer: Ok([0.2]), abusive: 0.2 },
    { text: texts[1], answer: Err(failure('response_invalid')), abusive: undefined },
  ])(
    'keeps $text the rule spam when Clef scores it low or fails, whatever the model says',
    async ({ text, answer, abusive }) => {
      const llama = fakeLlama(echo({ [text ?? '']: 'abusive' }));
      const judge = fakeJudge(() => answer);
      const { annotations, pipeline } = setup({ fetch: llama.fetch, judge });
      pipeline.ingest(target, { ...channel, comments: [comment('1', text ?? '', START + 1)] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      expect(judge.judge).toHaveBeenCalledOnce();
      expect(annotations()[0]).toMatchObject({ id: '1', category: 'spam', state: 'done' });
      expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
        {
          id: '1',
          ...channel,
          text,
          ...(text === texts[1] ? { translation: `訳:${text}` } : {}),
          category: 'spam',
          ...(abusive === undefined ? {} : { abusive }),
          source: 'rule',
          at: START + 1,
        },
      ]);
    },
  );
});

describe('failed lines (R46)', () => {
  it('shows a comment whose translation ran to its length bound untranslated, and caches it', async () => {
    // 40 different characters: the bound of a 12-character comment (2 × 12 + 16), no repeat.
    const overflow = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x3041 + i)).join(
      '',
    );
    const llama = fakeLlama((comments) =>
      comments.map((c) => ({ id: c.id, category: 'chatter', ja: overflow })),
    );
    const { annotations, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'go go go now')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'go go go now')] });
    expect(annotations()).toEqual([
      { id: '1', category: 'chatter', state: 'done' },
      { id: '2', category: 'chatter', state: 'done' },
    ]);
    expect(llama.state.bodies).toHaveLength(1);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ failed: 0, cached: 1 });
  });
});

describe('comment slots shared with the chat summary', () => {
  /** The llama-server slot and comment texts of a chat request, or `summary` for a summary request. */
  const requestOf = (init: RequestInit | undefined): string => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatBody;
    const what = body.grammar.startsWith('root ::= topic')
      ? 'summary'
      : promptComments(body)
          .map((c) => c.text)
          .join('+');
    return `${what}@${body.id_slot}`;
  };

  it('keeps the slot a summary holds from new batches until it ends', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const requests: string[] = [];
    const fetch: Fetch = async (input, init) => {
      requests.push(requestOf(init));
      await door.opened;
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch, commentConcurrency: 2 });
    const held = gate();
    const slots: number[] = [];
    const summary = pipeline.exclusive(async (slot): Promise<Result<number>> => {
      slots.push(slot);
      await held.opened;
      return Ok(slot);
    });
    expect(slots).toEqual([1]);
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'second')] });
    // Only slot 2 is free: the second comment waits for it instead of taking slot 1.
    await vi.waitFor(() => expect(requests).toEqual(['first@2']));
    door.open();
    await vi.waitFor(() => expect(requests).toEqual(['first@2', 'second@2']));
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    held.open();
    expect(await summary).toEqual(Ok(1));
    pipeline.ingest(target, { ...channel, comments: [comment('3', 'third')] });
    await vi.waitFor(() => expect(requests).toEqual(['first@2', 'second@2', 'third@1']));
  });

  it('waits for a busy slot and goes before the batches queued meanwhile', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const events: string[] = [];
    const fetch: Fetch = async (input, init) => {
      events.push(requestOf(init));
      await door.opened;
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    await vi.waitFor(() => expect(events).toEqual(['first@1']));
    const summary = pipeline.exclusive(async (slot): Promise<Result<number>> => {
      events.push(`exclusive@${slot}`);
      return Ok(slot);
    });
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'second')] });
    expect(events).toEqual(['first@1']);
    door.open();
    expect(await summary).toEqual(Ok(1));
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(events).toEqual(['first@1', 'exclusive@1', 'second@1']);
  });

  it('starts a spare exclusive only on a slot no waiting batch wants (the genre guess, R63)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const events: string[] = [];
    const fetch: Fetch = async (input, init) => {
      events.push(requestOf(init));
      await door.opened;
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    await vi.waitFor(() => expect(events).toEqual(['first@1']));
    const guess = pipeline.exclusive(
      async (slot): Promise<Result<number>> => {
        events.push(`spare@${slot}`);
        return Ok(slot);
      },
      'guess',
      { spare: true },
    );
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'second')] });
    door.open();
    // The batch queued meanwhile goes first; the guess takes the slot once nothing waits.
    expect(await guess).toEqual(Ok(1));
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(events).toEqual(['first@1', 'second@1', 'spare@1']);
    // On a free slot it starts at once.
    const now = pipeline.exclusive(async (slot): Promise<Result<number>> => Ok(slot), 'guess', {
      spare: true,
    });
    expect(await now).toEqual(Ok(1));
  });

  it('gives a spare exclusive the highest free comment slot, so slot 1 keeps the batch prefix', async () => {
    const { pipeline } = setup({ fetch: fakeLlama(echo()).fetch, commentConcurrency: 2 });
    const spare = (): Promise<Result<number>> =>
      pipeline.exclusive(async (slot): Promise<Result<number>> => Ok(slot), 'guess', {
        spare: true,
      });
    expect(await spare()).toEqual(Ok(2));
    // A summary still takes the lowest.
    expect(await pipeline.exclusive(async (slot): Promise<Result<number>> => Ok(slot))).toEqual(
      Ok(1),
    );
  });

  /** Answers summary requests with `answer()` (503 when undefined) and the rest as `fetch` does. */
  const withSummaries = (fetch: Fetch, answer: () => string | undefined) => {
    const state = { summaries: 0 };
    const wrapped: Fetch = async (input, init) => {
      if (!requestOf(init).startsWith('summary@')) return fetch(input, init);
      state.summaries += 1;
      const content = answer();
      return content === undefined
        ? new Response('loading', { status: 503 })
        : Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    };
    return { state, fetch: wrapped };
  };

  it('summarizes once for two requests at a time and not again until the records change', async () => {
    const server = withSummaries(fakeLlama(echo()).fetch, () => 'T 話題\n');
    const { annotations, pipeline } = setup({ fetch: server.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'hello there'), comment('2', 'nice play')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    const [first, second] = await Promise.all([
      pipeline.summary(channel.site, channel.channel, 15),
      pipeline.summary(channel.site, channel.channel, 15),
    ]);
    expect(first).toMatchObject({ ok: true, value: { total: 2, topics: ['話題'] } });
    expect(second).toEqual(first);
    expect(server.state.summaries).toBe(1);
    // No new record: the summary made before.
    expect(await pipeline.summary(channel.site, channel.channel, 15)).toEqual(first);
    expect(server.state.summaries).toBe(1);
    // Another window is another summary.
    await pipeline.summary(channel.site, channel.channel, 5);
    expect(server.state.summaries).toBe(2);
    pipeline.ingest(target, { ...channel, comments: [comment('3', 'good luck')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(await pipeline.summary(channel.site, channel.channel, 15)).toMatchObject({
      ok: true,
      value: { total: 3 },
    });
    expect(server.state.summaries).toBe(3);
  });

  it('asks the model again after a summary it could not make, without new records', async () => {
    let ready = false;
    const server = withSummaries(fakeLlama(echo()).fetch, () => (ready ? 'T 話題\n' : undefined));
    const { annotations, pipeline } = setup({ fetch: server.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // The counted parts still come back.
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: true,
      value: { total: 1, topics: [] },
    });
    ready = true;
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: true,
      value: { topics: ['話題'] },
    });
    expect(server.state.summaries).toBe(2);
  });

  it('ends a summary waiting for a slot on dispose and refuses new ones', async () => {
    const llama = hangingLlama();
    const { pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    await vi.waitFor(() => expect(llama.state.requests).toBe(1));
    const signals: AbortSignal[] = [];
    const waiting = pipeline.exclusive(async (slot, signal): Promise<Result<number>> => {
      signals.push(signal);
      return signal.aborted ? Err(failure('operation_cancelled')) : Ok(slot);
    });
    expect(signals).toEqual([]);
    pipeline.dispose();
    expect(await waiting).toMatchObject({
      ok: false,
      error: { internalCode: 'operation_cancelled' },
    });
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: false,
      error: { internalCode: 'operation_cancelled' },
    });
  });
  it('lets the batches that waited for a summary go before the next summary (R36)', async () => {
    const llama = fakeLlama(echo());
    const events: string[] = [];
    const fetch: Fetch = async (input, init) => {
      events.push(requestOf(init));
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch });
    const first = gate();
    const a = pipeline.exclusive(async (slot): Promise<Result<number>> => {
      events.push(`A@${slot}`);
      await first.opened;
      return Ok(slot);
    });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first')] });
    const b = pipeline.exclusive(async (slot): Promise<Result<number>> => {
      events.push(`B@${slot}`);
      return Ok(slot);
    });
    expect(events).toEqual(['A@1']);
    first.open();
    expect(await a).toEqual(Ok(1));
    expect(await b).toEqual(Ok(1));
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(events).toEqual(['A@1', 'first@1', 'B@1']);
  });

  it('gives a summary a slot under a continuous backlog, between two batches', async () => {
    const llama = fakeLlama(echo());
    const events: string[] = [];
    const held: (() => void)[] = [];
    const fetch: Fetch = async (input, init) => {
      events.push(requestOf(init));
      await new Promise<void>((resolve) => held.push(resolve));
      return llama.fetch(input, init);
    };
    const { annotations, pipeline } = setup({ fetch });
    const summaryAt = (name: string) =>
      pipeline.exclusive(async (slot): Promise<Result<number>> => {
        events.push(`${name}@${slot}`);
        return Ok(slot);
      });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'c1')] });
    await vi.waitFor(() => expect(events).toEqual(['c1@1']));
    const first = summaryAt('summary');
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'c2'), comment('3', 'c3')] });
    held.shift()?.();
    expect(await first).toEqual(Ok(1));
    await vi.waitFor(() => expect(events).toEqual(['c1@1', 'summary@1', 'c2+c3@1']));
    // The chat keeps coming while the next batch runs: the next summary still comes after it.
    pipeline.ingest(target, { ...channel, comments: [comment('4', 'c4')] });
    const second = summaryAt('again');
    held.shift()?.();
    expect(await second).toEqual(Ok(1));
    await vi.waitFor(() => expect(events.slice(3)).toEqual(['again@1', 'c4@1']));
    held.shift()?.();
    await vi.waitFor(() => expect(annotations()).toHaveLength(4));
  });

  it('replaces a waiting exclusive of the same key in its place; the replaced one runs aborted', async () => {
    const door = gate();
    const { pipeline } = setup({ fetch: gated(fakeLlama(echo()).fetch, door) });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'busy')] });
    const order: string[] = [];
    const enqueue = (name: string, key: string) =>
      pipeline.exclusive(async (_slot, signal): Promise<Result<string>> => {
        order.push(`${name}${signal.aborted ? ' aborted' : ''}`);
        return signal.aborted ? Err(failure('operation_cancelled')) : Ok(name);
      }, key);
    const x1 = enqueue('x1', 'x');
    const y = enqueue('y', 'y');
    const x2 = enqueue('x2', 'x');
    expect(order).toEqual(['x1 aborted']);
    expect(await x1).toMatchObject({ ok: false, error: { internalCode: 'operation_cancelled' } });
    door.open();
    expect([await x2, await y]).toEqual([Ok('x2'), Ok('y')]);
    expect(order).toEqual(['x1 aborted', 'x2', 'y']);
  });

  it('keeps one waiting summary per channel: earlier window clicks get the counted parts alone', async () => {
    let hold: Promise<void> | undefined;
    const inner: Fetch = async (input, init) => {
      if (hold !== undefined) await hold;
      return fakeLlama(echo()).fetch(input, init);
    };
    const server = withSummaries(inner, () => 'T 話題\n');
    const { annotations, pipeline } = setup({ fetch: server.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'hello there'), comment('2', 'nice play')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    const door = gate();
    hold = door.opened;
    pipeline.ingest(target, { ...channel, comments: [comment('3', 'still running')] });
    const clicks = ([5, 15, 30] as const).map((minutes) =>
      pipeline.summary(channel.site, channel.channel, minutes),
    );
    for (const [i, minutes] of ([5, 15] as const).entries()) {
      const counted = await clicks[i];
      expect(counted).toMatchObject({
        ok: true,
        value: { windowMinutes: minutes, total: 2, topics: [] },
      });
      expect(counted?.ok && counted.value.modelFailed).toBeUndefined();
    }
    expect(server.state.summaries).toBe(0);
    door.open();
    expect(await clicks[2]).toMatchObject({
      ok: true,
      value: { windowMinutes: 30, topics: ['話題'] },
    });
    expect(server.state.summaries).toBe(1);
    // A superseded summary is not kept: asking again asks the model.
    await vi.waitFor(() => expect(annotations()).toHaveLength(3));
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: true,
      value: { topics: ['話題'] },
    });
    expect(server.state.summaries).toBe(2);
  });

  it('makes the summary again after a stored comment changed in place (a verdict)', async () => {
    const server = withSummaries(
      fakeLlama(echo({ 'buy cheap coins www.example.com': 'spam' })).fetch,
      () => 'T 話題\n',
    );
    const { annotations, pipeline } = setup({ fetch: server.fetch });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'hello there'), comment('2', 'buy cheap coins www.example.com')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    await pipeline.summary(channel.site, channel.channel, 5);
    await pipeline.summary(channel.site, channel.channel, 5);
    expect(server.state.summaries).toBe(1);
    // Same count, same newest comment, but the spam is chat now.
    expect(await pipeline.review(channel.site, channel.channel, '2', 'ok')).toEqual(
      Ok({ persisted: true }),
    );
    await pipeline.summary(channel.site, channel.channel, 5);
    expect(server.state.summaries).toBe(2);
  });

  it('forgets a summary run that failed outright, so the next request runs again', async () => {
    let rejects = 1;
    const server = withSummaries(fakeLlama(echo()).fetch, () => 'T 話題\n');
    const { annotations, pipeline } = setup({
      fetch: server.fetch,
      client: (llama) => ({
        ...llama,
        chat: (request) =>
          request.grammar?.startsWith('root ::= topic') === true && (rejects -= 1) >= 0
            ? Promise.reject(new Error('client bug'))
            : llama.chat(request),
      }),
    });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    // The run is normalized into a Result; the slot and the key are free again.
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: false,
      error: { internalCode: 'unexpected_failure' },
    });
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: true,
      value: { topics: ['話題'] },
    });
  });

  it("drops an evicted channel's summaries: the same channel again is summarized again (R53)", async () => {
    let topic = 'T 古い話題\n';
    const server = withSummaries(fakeLlama(echo()).fetch, () => topic);
    const { annotations, pipeline } = setup({ fetch: server.fetch });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: true,
      value: { total: 1, topics: ['古い話題'] },
    });
    // Four other chats in front evict it; it comes back with as many records as before.
    for (let i = 1; i <= 4; i += 1)
      pipeline.ingest(target, {
        site: 'twitch',
        channel: `ch${i}`,
        comments: [comment('a', '👍')],
      });
    expect(pipeline.store(channel.site, channel.channel).size()).toBe(0);
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'hello there')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(6));
    topic = 'T 新しい話題\n';
    expect(await pipeline.summary(channel.site, channel.channel, 5)).toMatchObject({
      ok: true,
      value: { total: 1, topics: ['新しい話題'] },
    });
    expect(server.state.summaries).toBe(2);
  });
});

describe('channel eviction (R53)', () => {
  const front = { site: 'twitch', channel: 'front' } as const;
  /** `count` comments of `name` sent only to be stored, from a background tab of its own. */
  const background = (
    pipeline: ReturnType<typeof setup>['pipeline'],
    tabId: number,
    name: string,
    count = 1,
  ) =>
    pipeline.ingest(
      { tabId, frameId: 0 },
      {
        site: 'twitch',
        channel: name,
        process: false,
        comments: Array.from({ length: count }, (_v, i) =>
          comment(`${name}-${i}`, `stored line ${name} ${i}`),
        ),
      },
    );

  it('keeps the front channel with waiting comments through stored-only bursts of four background tabs', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const texts = [
      'hello there friend',
      'what game is this',
      'nice play there',
      'good luck today',
      'so cool to see',
    ];
    pipeline.ingest(target, {
      ...front,
      comments: [
        ...texts.map((text, i) => comment(`f${i}`, text)),
        comment('spam', 'buy my merch buy my merch buy my merch'),
      ],
    });
    const store = pipeline.store(front.site, front.channel);
    expect(pipeline.stats(front.site, front.channel)).toMatchObject({ pending: 5, records: 1 });
    // One aligned wake-up of four background tabs: each stores a line only (R44).
    for (const [tabId, name] of [
      [2, 'bg1'],
      [3, 'bg2'],
      [4, 'bg3'],
      [5, 'bg4'],
    ] as const)
      background(pipeline, tabId, name);
    expect(pipeline.stats(front.site, front.channel)).toMatchObject({
      pending: 5,
      dropped: 0,
      records: 1,
    });
    expect(pipeline.store(front.site, front.channel)).toBe(store);
    expect(pipeline.hidden(front.site, front.channel).map((h) => h.id)).toEqual(['spam']);
    expect(annotations().map((a) => [a.id, a.state])).toEqual([['spam', 'done']]);
    // The least recently processed one went: the first background channel.
    expect(pipeline.store('twitch', 'bg1').size()).toBe(0);
    expect(pipeline.store('twitch', 'bg4').size()).toBe(1);
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(6));
    expect(
      annotations()
        .filter((a) => a.id !== 'spam')
        .map((a) => a.state),
    ).toEqual(texts.map(() => 'done'));
    expect(store.size()).toBe(6);
  });

  it('evicts the least recently processed channel, not the one read or stored into last', () => {
    const { clock, pipeline } = setup({ fetch: vi.fn<Fetch>() });
    for (let i = 0; i < 4; i += 1) {
      pipeline.ingest(target, {
        site: 'twitch',
        channel: `ch${i}`,
        comments: [comment('a', '👍')],
      });
      clock.advance(1_000);
    }
    // ch0 was processed first; reading it and storing into it later does not count.
    pipeline.stats('twitch', 'ch0');
    pipeline.hidden('twitch', 'ch0');
    pipeline.ingest(target, {
      site: 'twitch',
      channel: 'ch0',
      process: false,
      comments: [comment('b', 'stored later')],
    });
    pipeline.ingest(target, { site: 'twitch', channel: 'ch4', comments: [comment('a', '👍')] });
    expect([0, 1, 2, 3, 4].map((i) => pipeline.store('twitch', `ch${i}`).size())).toEqual([
      0, 1, 1, 1, 1,
    ]);
  });

  it('stores nothing for a background tab while every kept channel was processed within 60 s, and counts it as unstored (R55)', () => {
    const { clock, pipeline } = setup({ fetch: vi.fn<Fetch>() });
    for (let i = 0; i < 4; i += 1)
      pipeline.ingest(target, {
        site: 'twitch',
        channel: `ch${i}`,
        comments: [comment('a', '👍')],
      });
    clock.advance(59_000);
    expect(background(pipeline, 9, 'late', 3)).toEqual({ accepted: 0, dropped: 3 });
    expect([0, 1, 2, 3].map((i) => pipeline.store('twitch', `ch${i}`).size())).toEqual([
      1, 1, 1, 1,
    ]);
    expect(pipeline.store('twitch', 'late').size()).toBe(0);
    expect(pipeline.stats('twitch', 'late')).toMatchObject({
      unstored: 3,
      dropped: 0,
      stored: 0,
      records: 0,
    });
    // A minute after the last processing the oldest processed one may go.
    clock.advance(1_000);
    expect(background(pipeline, 9, 'late', 1)).toEqual({ accepted: 1, dropped: 0 });
    expect(pipeline.store('twitch', 'ch0').size()).toBe(0);
    expect(pipeline.stats('twitch', 'late')).toMatchObject({
      unstored: 3,
      dropped: 0,
      stored: 1,
      records: 1,
    });
  });

  it('evicts, of channels never processed, the one that sent comments longest ago (R55)', () => {
    const { clock, pipeline } = setup({ fetch: vi.fn<Fetch>() });
    background(pipeline, 2, 'bg1');
    clock.advance(1_000);
    background(pipeline, 3, 'bg2');
    clock.advance(1_000);
    for (const name of ['f1', 'f2'])
      pipeline.ingest(target, { site: 'twitch', channel: name, comments: [comment('a', '👍')] });
    clock.advance(1_000);
    // bg1 was kept first but sent comments again since.
    background(pipeline, 2, 'bg1');
    clock.advance(1_000);
    expect(background(pipeline, 4, 'late')).toEqual({ accepted: 1, dropped: 0 });
    expect(
      ['bg1', 'bg2', 'f1', 'f2', 'late'].map((name) => pipeline.store('twitch', name).size()),
    ).toEqual([1, 0, 1, 1, 1]);
  });

  it('never evicts a channel with a comment still with the model for a stored-only ingest, however old', () => {
    const { clock, pipeline } = setup({ fetch: hangingLlama().fetch });
    pipeline.ingest(target, {
      site: 'twitch',
      channel: 'ch0',
      comments: [comment('a', 'a question about the boss')],
    });
    for (let i = 1; i < 4; i += 1)
      pipeline.ingest(target, {
        site: 'twitch',
        channel: `ch${i}`,
        comments: [comment('a', '👍')],
      });
    clock.advance(2 * MINUTE);
    expect(background(pipeline, 9, 'late')).toEqual({ accepted: 1, dropped: 0 });
    expect(pipeline.stats('twitch', 'ch0')).toMatchObject({ pending: 1 });
    expect([1, 2, 3].map((i) => pipeline.store('twitch', `ch${i}`).size())).toEqual([0, 1, 1]);
  });
});

describe('only the chat in front of the viewer (R44)', () => {
  /** The channel's records as [id, lang, state, translation, category]. */
  const recordsOf = (pipeline: ReturnType<typeof setup>['pipeline']) =>
    pipeline
      .store(channel.site, channel.channel)
      .since(MINUTE)
      .map((record) => [record.id, record.lang, record.state, record.translation, record.category]);

  it('stores comments sent with process false without the model, Clef, a rule or an annotation', async () => {
    const fetch = vi.fn<Fetch>();
    const judge = fakeJudge((texts) => Ok(texts.map(() => 0.9)));
    const { clock, emitted, pipeline } = setup({ fetch, judge });
    const comments = [
      comment('1', 'which boss is next?'),
      comment('2', 'LOL'),
      comment('3', 'you clown'),
      comment('4', '🎉'),
      comment('5', 'もう一回！'),
    ];
    expect(pipeline.ingest(target, { ...channel, process: false, comments })).toEqual({
      accepted: 5,
      dropped: 0,
    });
    // Sent again from a frame still in the background: nothing new.
    expect(pipeline.ingest(target, { ...channel, process: false, comments })).toEqual({
      accepted: 0,
      dropped: 0,
    });
    clock.advance(10_000);
    await vi.waitFor(() => expect(clock.active()).toBe(0));
    expect(fetch).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(recordsOf(pipeline)).toEqual([
      ['1', 'und-Latn', 'stored', undefined, undefined],
      ['2', 'und-Latn', 'stored', undefined, undefined],
      ['3', 'und-Latn', 'stored', undefined, undefined],
      ['4', 'und', 'stored', undefined, undefined],
      ['5', 'ja', 'stored', undefined, undefined],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      stored: 5,
      records: 5,
      pending: 0,
      trivial: 0,
      cached: 0,
      expired: 0,
      clefSkipped: 0,
    });
  });

  it("moves a channel's waiting comments to stored when its chat leaves the viewer; a running batch finishes", async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { clock, emitted, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const other = { site: 'twitch', channel: 'other' } as const;
    // The first comment goes to the model at once; four more wait (three flushed, one in the
    // batch window), as does a comment of another channel.
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'first line')] });
    pipeline.ingest(target, {
      ...channel,
      comments: ['second', 'third', 'fourth', 'fifth'].map((n, i) =>
        comment(`${i + 2}`, `${n} line`),
      ),
    });
    pipeline.ingest(target, { ...other, comments: [comment('o1', 'other line')] });
    expect(pipeline.stats(channel.site, channel.channel).pending).toBe(5);
    // The chat left the viewer (R49): its own message, without comments.
    expect(
      pipeline.ingest(target, { ...channel, process: false, left: true, comments: [] }),
    ).toEqual({ accepted: 0, dropped: 0 });
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ pending: 1, stored: 4 });
    expect(emitted).toEqual([]);
    door.open();
    await vi.waitFor(() => expect(annotations().map((a) => a.id)).toEqual(['1', 'o1']));
    clock.advance(10_000);
    // The running batch finished normally; the other channel's comment was not held back.
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['first line'],
      ['other line'],
    ]);
    expect(annotations().map((a) => [a.id, a.state])).toEqual([
      ['1', 'done'],
      ['o1', 'done'],
    ]);
    // In the order they were stored: the batch's comment was answered last.
    expect(recordsOf(pipeline)).toEqual([
      ['2', 'und-Latn', 'stored', undefined, undefined],
      ['3', 'und-Latn', 'stored', undefined, undefined],
      ['4', 'und-Latn', 'stored', undefined, undefined],
      ['5', 'und-Latn', 'stored', undefined, undefined],
      ['1', 'und-Latn', 'done', '訳:first line', 'chatter'],
    ]);
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      pending: 0,
      stored: 4,
      expired: 0,
      dropped: 0,
    });
  });

  it('keeps no channel for a frame that left the viewer without ever sending a comment', () => {
    const { pipeline } = setup({ fetch: vi.fn<Fetch>() });
    const kept = ['a', 'b', 'c', 'd'].map((name) => ({ site: 'twitch', channel: name }) as const);
    for (const one of kept)
      pipeline.ingest(target, { ...one, comments: [comment(one.channel, '🎉')] });
    // The watch page's own comments, never read: telling that they left the viewer evicts nothing.
    pipeline.ingest(target, {
      site: 'youtube',
      channel: 'v1#comments',
      process: false,
      left: true,
      comments: [],
    });
    expect(kept.map((one) => pipeline.stats(one.site, one.channel).records)).toEqual([1, 1, 1, 1]);
  });

  it('stores the comments of a process false message and leaves the waiting ones alone (R49)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    // A chat in front: the newest three with the model, two waiting.
    const names = ['one', 'two', 'three', 'four', 'five'];
    pipeline.ingest(target, {
      ...channel,
      comments: names.map((n) => comment(n, `on screen ${n}`)),
    });
    expect(pipeline.stats(channel.site, channel.channel).pending).toBe(5);
    // Its lines scrolled above the screen are only stored: nothing waiting is touched.
    pipeline.ingest(target, {
      ...channel,
      process: false,
      comments: [comment('old', 'scrolled away')],
    });
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ pending: 5, stored: 1 });
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(5));
    expect(recordsOf(pipeline).map(([id, , state]) => [id, state])).toEqual([
      ['old', 'stored'],
      ['three', 'done'],
      ['four', 'done'],
      ['five', 'done'],
      ['one', 'done'],
      ['two', 'done'],
    ]);
  });

  it('stores on leaving only the waiting comments that no other frame shows (R49)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const front: Target = { tabId: 1, frameId: 0 };
    const back: Target = { tabId: 2, frameId: 0 };
    // Both frames show the stream; the second also shows one line of its own.
    const shared = ['s1', 's2', 's3', 's4'].map((id) => comment(id, `shared ${id}`));
    pipeline.ingest(front, { ...channel, comments: shared });
    pipeline.ingest(back, { ...channel, comments: [...shared, comment('b1', 'only behind')] });
    expect(pipeline.stats(channel.site, channel.channel).pending).toBe(5);
    // The second frame goes to the background.
    pipeline.ingest(back, { ...channel, process: false, left: true, comments: [] });
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ pending: 4, stored: 1 });
    door.open();
    await vi.waitFor(() =>
      expect(annotations().filter((a) => a.id.startsWith('s'))).toHaveLength(8),
    );
    expect(annotations().map((a) => a.id)).not.toContain('b1');
    expect(recordsOf(pipeline).find(([id]) => id === 'b1')?.[2]).toBe('stored');
  });

  it('counts as stored only what is still stored after three short tab switches (R50)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const comments = Array.from({ length: 9 }, (_, i) => comment(`t${i}`, `switching line ${i}`));
    const storedNow = (): number =>
      recordsOf(pipeline).filter(([, , state]) => state === 'stored').length;
    pipeline.ingest(target, { ...channel, comments });
    for (let round = 0; round < 3; round += 1) {
      // Away for 10 ms: the six waiting comments are stored, then back on screen.
      pipeline.ingest(target, { ...channel, process: false, left: true, comments: [] });
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
        stored: 6,
        pending: 3,
      });
      expect(storedNow()).toBe(6);
      pipeline.ingest(target, { ...channel, comments });
      expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
        stored: 0,
        pending: 9,
      });
      // Their records wait for the model again.
      expect(storedNow()).toBe(0);
    }
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(9));
    expect([pipeline.stats(channel.site, channel.channel).stored, storedNow()]).toEqual([0, 0]);
    expect(llama.state.bodies.flatMap((body) => promptComments(body))).toHaveLength(9);
  });

  it('adds no frame for comments sent only to be stored, so a frame leaving stores what only it shows in front (R50)', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { emitted, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    const popout: Target = { tabId: 1, frameId: 0 };
    const inline: Target = { tabId: 2, frameId: 3 };
    const comments = [
      comment('r', 'LOL'),
      ...Array.from({ length: 9 }, (_, i) => comment(`p${i}`, `popout line ${i}`)),
    ];
    // The popout is in front; the watch page's chat frame of the same stream is hidden.
    pipeline.ingest(popout, { ...channel, comments });
    expect(pipeline.stats(channel.site, channel.channel).pending).toBe(9);
    pipeline.ingest(inline, { ...channel, process: false, comments });
    // An answer that exists already is still shown there.
    expect(emitted.filter((event) => event.target === inline)).toEqual([
      {
        target: inline,
        annotations: [{ id: 'r', translation: '（笑）', category: 'chatter', state: 'done' }],
      },
    ]);
    // The popout goes to the background: its six waiting comments are stored.
    pipeline.ingest(popout, { ...channel, process: false, left: true, comments: [] });
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({ pending: 3, stored: 6 });
    door.open();
    await vi.waitFor(() => expect(pipeline.stats(channel.site, channel.channel).pending).toBe(0));
    // The batch already with the model answers the popout only.
    expect(emitted.filter((event) => event.target === inline)).toHaveLength(1);
  });

  it('processes a stored comment once its frame sends it in front, completing its record in place', async () => {
    const llama = fakeLlama(echo());
    const { emitted, pipeline } = setup({ fetch: llama.fetch });
    pipeline.ingest(target, {
      ...channel,
      process: false,
      comments: [comment('1', 'what a dodge'), comment('2', 'nice one')],
    });
    expect(
      pipeline.ingest(target, { ...channel, process: true, comments: [comment('2', 'nice one')] }),
    ).toEqual({ accepted: 1, dropped: 0 });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted).toEqual([
      {
        target,
        annotations: [{ id: '2', translation: '訳:nice one', category: 'chatter', state: 'done' }],
      },
    ]);
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['nice one'],
    ]);
    expect(recordsOf(pipeline)).toEqual([
      ['1', 'und-Latn', 'stored', undefined, undefined],
      ['2', 'und-Latn', 'done', '訳:nice one', 'chatter'],
    ]);
    // `stored` counts what is still only stored (R50); the record count does not grow.
    expect(pipeline.stats(channel.site, channel.channel)).toMatchObject({
      stored: 1,
      records: 2,
      pending: 0,
    });
    // Processed once: sending it again only repeats the annotation.
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'nice one')] });
    expect(llama.state.bodies).toHaveLength(1);
  });

  describe('lines a chat holds until judged (R52, R57)', () => {
    /** The fixture lines of each batch the model was asked, in order. */
    const batches = (bodies: readonly ChatBody[]): number[][] =>
      bodies.map((body) => promptComments(body).map((c) => Number(/\d+$/u.exec(c.text)?.[0])));
    const line = (n: number, held = false): RawComment => ({
      ...comment(`b${n}`, `line ${n}`),
      ...(held ? { held: true } : {}),
    });
    const lines = (from: number, to: number, held = false): RawComment[] =>
      Array.from({ length: to - from + 1 }, (_, i) => line(from + i, held));

    it('answers held lines that can still be judged before they come in first, oldest first', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
      pipeline.ingest(target, { ...channel, comments: lines(1, 30, true) });
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(30));
      const order = batches(llama.state.bodies);
      expect([order.at(0), order.at(1), order.at(-1)]).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [28, 29, 30],
      ]);
    });

    it('answers held lines past their window newest first, as any other line', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
      pipeline.ingest(target, { ...channel, comments: lines(1, 9, true) });
      // The first batch runs; the others could no longer be answered before their lines come in.
      clock.advance(holdWindowMs([]));
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(9));
      expect(batches(llama.state.bodies)).toEqual([
        [1, 2, 3],
        [7, 8, 9],
        [4, 5, 6],
      ]);
    });

    it('never puts lines that wait for nothing first (on screen when the chat came back, R44)', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
      // A look sends the lines on screen (none held), then new lines are held.
      pipeline.ingest(target, { ...channel, comments: [...lines(1, 6), ...lines(7, 9, true)] });
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(9));
      expect(batches(llama.state.bodies)).toEqual([
        [7, 8, 9],
        [4, 5, 6],
        [1, 2, 3],
      ]);
      // Without held lines the order is as before: newest first.
      const again = gate();
      const later = fakeLlama(echo());
      const second = setup({ fetch: gated(later.fetch, again) });
      second.pipeline.ingest(target, { ...channel, comments: lines(1, 9) });
      again.open();
      await vi.waitFor(() => expect(second.annotations()).toHaveLength(9));
      expect(batches(later.state.bodies)).toEqual([
        [7, 8, 9],
        [4, 5, 6],
        [1, 2, 3],
      ]);
    });

    it.each([
      // No batch measured: a 450 ms batch is assumed.
      { durations: [], window: 1300 },
      { durations: [450], window: 1300 },
      { durations: [900], window: 850 },
      { durations: [2000], window: 0 },
      // The 90th percentile (nearest rank) of the batches measured, so a few slow batches count;
      // never more than the hold less the flush.
      { durations: [300, 900, 1200], window: 550 },
      { durations: [...Array.from({ length: 18 }, () => 450), 1500, 1500], window: 1300 },
      { durations: [...Array.from({ length: 17 }, () => 450), 1500, 1500, 1500], window: 250 },
      { durations: [0], window: 1750 },
    ])(
      'gives held lines $window ms to be judged after batches of $durations ms (R58, R59)',
      ({ durations, window }) => {
        expect(holdWindowMs(durations)).toBe(window);
      },
    );

    it('shortens the window when the server answers slowly (R58)', async () => {
      const door = gate();
      const llama = fakeLlama(echo());
      const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
      const other = { site: 'twitch', channel: 'other' } as const;
      // The first batch takes 1,900 ms: no held line can be answered in time after it.
      pipeline.ingest(target, { ...channel, comments: [comment('first', 'first line 0')] });
      clock.advance(1300);
      // Channel a's held lines arrive; 600 ms later channel b's newer lines held by none.
      pipeline.ingest(target, {
        ...channel,
        comments: lines(1, 3, true).map((c) => ({ ...c, text: `a line ${c.id}` })),
      });
      clock.advance(600);
      pipeline.ingest(target, { ...other, comments: lines(4, 6) });
      door.open();
      await vi.waitFor(() => expect(annotations()).toHaveLength(7));
      // With the assumed 450 ms the held lines (600 ms old) would go first; measured, b's do.
      expect(
        llama.state.bodies
          .slice(1)
          .map((body) => (promptComments(body)[0]?.text.startsWith('a ') ? 'a' : 'b')),
      ).toEqual(['b', 'a']);
    });

    it.each([
      { name: 'still in time', wait: 0, order: ['a', 'b'] },
      { name: 'past their window', wait: holdWindowMs([]), order: ['b', 'a'] },
    ])(
      "picks the channel of held lines $name as the rule says, not a holding channel's by default",
      async ({ wait, order }) => {
        const door = gate();
        const llama = fakeLlama(echo());
        const { clock, annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
        const other = { site: 'twitch', channel: 'other' } as const;
        // A batch runs; channel a's held lines wait, then channel b's newer lines held by none.
        pipeline.ingest(target, { ...channel, comments: [comment('first', 'first line 0')] });
        pipeline.ingest(target, {
          ...channel,
          comments: lines(1, 3, true).map((c) => ({ ...c, text: `a line ${c.id}` })),
        });
        clock.advance(wait);
        pipeline.ingest(target, { ...other, comments: lines(4, 6) });
        door.open();
        await vi.waitFor(() => expect(annotations()).toHaveLength(7));
        expect(
          llama.state.bodies
            .slice(1)
            .map((body) => (promptComments(body)[0]?.text.startsWith('a ') ? 'a' : 'b')),
        ).toEqual(order);
      },
    );

    describe("a simulated chat (the review's model, fixed seeds)", () => {
      /** The review's linear congruential generator: the same numbers on every run. */
      function generator(seed: number): () => number {
        let state = seed;
        return () => {
          state = (state * 1103515245 + 12345) % 2147483648;
          return state / 2147483648;
        };
      }
      function poisson(rate: number, spanMs: number, seed = 7): number[] {
        const random = generator(seed);
        const arrivals: number[] = [];
        for (let t = 0; t < spanMs;) {
          t += (-Math.log(1 - random()) * 1000) / rate;
          arrivals.push(Math.round(t));
        }
        return arrivals;
      }
      /** Batch durations: always `ms`. */
      const constant = (ms: number) => (): (() => number) => () => ms;
      /** Batch durations around `ms`, lognormal with σ 0.35 and mean `ms`, from a fixed seed. */
      const lognormal = (ms: number) => (): (() => number) => {
        const random = generator(31);
        return () => {
          const z = Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
          return ms * Math.exp(0.35 * z - 0.35 ** 2 / 2);
        };
      };
      /** Picks the order of the waiting lines; `measured` is the ring of batch durations. */
      type Order = (
        waiting: readonly WaitingComment[],
        now: number,
        measured: readonly number[],
      ) => number[];
      const newestFirst: Order = (waiting) => waiting.map((_w, i) => i).reverse();
      const oldestFirst: Order = (waiting) => waiting.map((_w, i) => i);
      /** R59: the window follows the batches measured, as the pipeline's does. */
      const r59: Order = (waiting, now, measured) =>
        batchOrder(waiting, now, holdWindowMs(measured));
      /**
       * Percentage of held lines that come in before their judgement: lines posted at
       * `arrivals` (ms), every one held; the chat sends them 250 ms after the first one waiting
       * (its flush), two slots answer 3 lines each in `order`, a batch taking what `durations`
       * gives (its finish adds to a ring of the latest 20, as in the pipeline), waiting lines
       * expire after 8 s, and a line comes in once it and every line before it are judged, or
       * 2 s after it was posted.
       */
      function unjudged(
        arrivals: readonly number[],
        order: Order,
        durations: () => () => number,
      ): number {
        const duration = durations();
        const n = arrivals.length;
        const judged: number[] = Array.from({ length: n }, () => Infinity);
        const received: number[] = Array.from({ length: n }, () => Infinity);
        let waiting: number[] = [];
        let posted = 0;
        let flushAt = Infinity;
        const free = [0, 0];
        let running: { start: number; end: number }[] = [];
        const measured: number[] = [];
        for (let t = 0; t < (arrivals[n - 1] ?? 0) + 20_000; t += 10) {
          for (const batch of running.filter(({ end }) => end <= t)) {
            measured.push(batch.end - batch.start);
            if (measured.length > 20) measured.shift();
          }
          running = running.filter(({ end }) => end > t);
          for (; posted < n && (arrivals[posted] ?? Infinity) <= t; posted += 1)
            if (flushAt === Infinity) flushAt = t + 250;
          if (t >= flushAt) {
            for (let i = 0; i < posted; i += 1)
              if (received[i] === Infinity) {
                received[i] = t;
                waiting.push(i);
              }
            flushAt = Infinity;
          }
          waiting = waiting.filter((i) => t - (received[i] ?? 0) < 8_000);
          free.forEach((busy, slot) => {
            if (busy > t || waiting.length === 0) return;
            const view = waiting.map((i) => ({ held: true, receivedAt: received[i] ?? 0 }));
            const picked = order(view, t, measured)
              .slice(0, 3)
              .map((k) => waiting[k] ?? -1);
            waiting = waiting.filter((i) => !picked.includes(i));
            const end = t + Math.max(10, Math.round(duration() / 10) * 10);
            for (const i of picked) judged[i] = end;
            free[slot] = end;
            running.push({ start: t, end });
          });
        }
        let shown = 0;
        let early = 0;
        arrivals.forEach((at, i) => {
          shown = Math.max(shown, Math.min(judged[i] ?? Infinity, at + 2_000));
          if ((judged[i] ?? Infinity) > shown) early += 1;
        });
        return (100 * early) / n;
      }
      // 30 lines at once, then 6 a second for 20 s.
      const burst = [
        ...Array.from({ length: 30 }, () => 0),
        ...Array.from({ length: 120 }, (_, i) => 100 + Math.round((i * 1000) / 6)),
      ];

      it.each([
        // 2 slots of 3 lines; capacity 13.3, 10, 8, 6.7 and 5 lines a second.
        { kind: 'constant', rate: 13, ms: 450, durations: constant(450) },
        { kind: 'constant', rate: 10, ms: 600, durations: constant(600) },
        { kind: 'constant', rate: 6.5, ms: 750, durations: constant(750) },
        { kind: 'constant', rate: 6.5, ms: 900, durations: constant(900) },
        { kind: 'constant', rate: 5, ms: 1200, durations: constant(1200) },
        // Batches that vary as a server's do; overloaded, near capacity and below it.
        { kind: 'lognormal', rate: 20, ms: 450, durations: lognormal(450) },
        { kind: 'lognormal', rate: 10, ms: 900, durations: lognormal(900) },
        { kind: 'lognormal', rate: 13, ms: 450, durations: lognormal(450) },
        { kind: 'lognormal', rate: 10, ms: 600, durations: lognormal(600) },
        { kind: 'lognormal', rate: 6.5, ms: 750, durations: lognormal(750) },
        { kind: 'lognormal', rate: 6.5, ms: 900, durations: lognormal(900) },
        { kind: 'lognormal', rate: 5, ms: 1200, durations: lognormal(1200) },
      ])(
        'shows at most 1.5 points more lines unjudged than newest first and fewer than oldest first ($kind, $rate/s, $ms ms)',
        ({ rate, durations }) => {
          const arrivals = poisson(rate, 300_000);
          const share = unjudged(arrivals, r59, durations);
          expect(share).toBeLessThanOrEqual(unjudged(arrivals, newestFirst, durations) + 1.5);
          expect(share).toBeLessThan(unjudged(arrivals, oldestFirst, durations));
        },
      );

      it.each([
        { kind: 'constant', durations: constant(450) },
        { kind: 'lognormal', durations: lognormal(450) },
      ])(
        'shows at most 1.5 points more lines unjudged than newest first after a burst, and fewer than oldest first ($kind)',
        ({ durations }) => {
          const share = unjudged(burst, r59, durations);
          expect(share).toBeLessThanOrEqual(unjudged(burst, newestFirst, durations) + 1.5);
          expect(share).toBeLessThan(unjudged(burst, oldestFirst, durations));
        },
      );
    });
  });

  it('sends the newest comments of one ingest to the model first', async () => {
    const door = gate();
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: gated(llama.fetch, door) });
    pipeline.ingest(target, {
      ...channel,
      comments: Array.from({ length: 7 }, (_, i) => comment(`s${i + 1}`, `line ${i + 1}`)),
    });
    door.open();
    await vi.waitFor(() => expect(annotations()).toHaveLength(7));
    expect(llama.state.bodies.map((body) => promptComments(body).map((c) => c.text))).toEqual([
      ['line 5', 'line 6', 'line 7'],
      ['line 2', 'line 3', 'line 4'],
      ['line 1'],
    ]);
  });
});

describe('genre categories (R62)', () => {
  /** Every stream is titled and of `genre`, with `extra` (a title, relaxations, a note). */
  const genred =
    (genre: StreamContext['genre'], extra: Partial<StreamContext> = {}) =>
    (site: StreamContext['site'], partition: string): StreamContext => ({
      ...titled(site, partition),
      genre,
      ...extra,
    });
  const role = (id: string, text: string, author: RawComment['role']): RawComment => ({
    ...comment(id, text),
    ...(author === undefined ? {} : { role: author }),
  });

  it.each([
    // Only the categories the stream enables stand; any other verdict of the model is chat.
    {
      name: 'an unknown genre',
      context: genred(undefined),
      llm: 'instruction',
      expected: 'chatter',
    },
    { name: 'an FPS stream', context: genred('fps'), llm: 'instruction', expected: 'instruction' },
    {
      name: 'an FPS stream that invites advice (【参加型】 in the title)',
      context: genred('fps', { title: '【参加型】Fixture Royale' }),
      llm: 'instruction',
      expected: 'chatter',
    },
    {
      name: 'an FPS stream whose rules allow instructions',
      context: genred('fps', { relaxations: ['instruction'] }),
      llm: 'instruction',
      expected: 'chatter',
    },
    { name: 'a chatting stream', context: genred('chat'), llm: 'ghosting', expected: 'chatter' },
    {
      name: 'a deduction stream',
      context: genred('deduction'),
      llm: 'ghosting',
      expected: 'ghosting',
    },
    {
      name: 'a singing stream',
      context: genred('singing'),
      llm: 'instruction',
      expected: 'chatter',
    },
    // Always on: relay, privacy and sensitive.
    { name: 'an unknown genre', context: genred(undefined), llm: 'relay', expected: 'relay' },
    { name: 'a singing stream', context: genred('singing'), llm: 'privacy', expected: 'privacy' },
    { name: 'a chatting stream', context: genred('chat'), llm: 'sensitive', expected: 'sensitive' },
    // Spoilers: on without a note in a story stream, unless it allows spoilers.
    { name: 'a story stream', context: genred('story'), llm: 'spoiler', expected: 'spoiler' },
    {
      name: 'a story stream on its 2周目',
      context: genred('story', { title: '【2周目】Fixture Quest' }),
      llm: 'spoiler',
      expected: 'chatter',
    },
    { name: 'a chatting stream', context: genred('chat'), llm: 'spoiler', expected: 'chatter' },
  ] as const)(
    "shows the model's $llm in $name as $expected",
    async ({ context, llm, expected }) => {
      const text = 'a comment the model judged';
      const llama = fakeLlama(echo({ [text]: llm }));
      const { annotations, pipeline } = setup({ fetch: llama.fetch, context });
      pipeline.ingest(target, { ...channel, comments: [comment('1', text)] });
      await vi.waitFor(() => expect(annotations()).toHaveLength(1));
      // A copy answered from the text cache is judged the same way.
      pipeline.ingest(target, { ...channel, comments: [comment('2', text)] });
      expect(annotations().map((a) => a.category)).toEqual([expected, expected]);
      expect(llama.state.bodies).toHaveLength(1);
      expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.category)).toEqual(
        expected === 'chatter' ? [] : [expected, expected],
      );
    },
  );

  it.each(['owner', 'moderator', 'verified'] as const)(
    'never gives a genre category to a post by the %s (R38, R53, R62)',
    async (author) => {
      const verdicts = {
        'go left first': 'instruction',
        'saw this on another stream': 'relay',
        'they are in the tower': 'ghosting',
        'where do you live': 'privacy',
        'who did you vote for': 'sensitive',
        'the twist is coming': 'spoiler',
      } as const;
      const llama = fakeLlama(echo(verdicts));
      const { annotations, pipeline } = setup({
        fetch: llama.fetch,
        context: genred('fps', { spoilerNote: 'the final boss' }),
      });
      const texts = Object.keys(verdicts);
      pipeline.ingest(target, {
        ...channel,
        comments: texts.map((text, i) => role(String(i + 1), text, author)),
      });
      await vi.waitFor(() => expect(annotations()).toHaveLength(texts.length));
      expect(new Set(annotations().map((a) => a.category))).toEqual(new Set(['chatter']));
      expect(pipeline.hidden(channel.site, channel.channel)).toEqual([]);
    },
  );

  it('names the genre and defines only its categories in the prompt, and the grammar allows only their codes', async () => {
    const llama = fakeLlama(echo());
    const { annotations, pipeline } = setup({ fetch: llama.fetch, context: genred('fps') });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'hello there')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    const [body] = llama.state.bodies;
    const user = body?.messages[1]?.content ?? '';
    expect(user).toContain('Stream genre: fps (');
    for (const code of [
      'n = instruction',
      'r = relay',
      'g = ghosting',
      'v = privacy',
      'e = sensitive',
    ])
      expect(user).toContain(`- ${code}: `);
    expect(user).not.toContain('- p = spoiler: ');
    expect(body?.grammar.split('\n')[1]).toBe('code ::= [asqicnrgve]');
  });

  it('judges a text again once the genre of its stream changed (the cache scope)', async () => {
    const llama = fakeLlama(echo({ 'try the left path': 'instruction' }));
    let genre: StreamContext['genre'] = 'chat';
    const { annotations, pipeline } = setup({
      fetch: llama.fetch,
      context: (site, partition) => genred(genre)(site, partition),
    });
    pipeline.ingest(target, { ...channel, comments: [comment('1', 'try the left path')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    genre = 'story';
    pipeline.ingest(target, { ...channel, comments: [comment('2', 'try the left path')] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(2));
    expect(llama.state.bodies).toHaveLength(2);
    expect(annotations().map((a) => a.category)).toEqual(['chatter', 'instruction']);
  });

  it('learns from an ok verdict on a genre category: a correction in the next prompt and the text allowlisted (R53, R62)', async () => {
    const text = 'came over from another stream';
    const llama = fakeLlama(echo({ [text]: 'relay' }));
    const { annotations, pipeline } = setup({
      fetch: llama.fetch,
      feedback: createFeedbackStore(),
    });
    pipeline.ingest(target, { ...channel, comments: [comment('1', text)] });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0]).toMatchObject({ category: 'relay' });
    expect(await pipeline.review(channel.site, channel.channel, '1', 'ok')).toEqual(
      Ok({ persisted: true }),
    );
    // A copy is chat whatever the model says, and the next batch carries the correction.
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('2', text), comment('3', 'hello there')],
    });
    await vi.waitFor(() =>
      expect(annotations().filter((a) => a.id === '2' || a.id === '3')).toHaveLength(2),
    );
    expect(annotations().find((a) => a.id === '2')).toMatchObject({ category: 'chatter' });
    expect(pipeline.hidden(channel.site, channel.channel).map((h) => h.id)).toEqual([]);
    const user = llama.state.bodies.at(-1)?.messages[1]?.content ?? '';
    expect(user).toContain(
      `Viewer corrections (JSON): ${JSON.stringify([{ text, wrong: 'relay' }])}`,
    );
  });

  it('lists a genre category for review and counts it for the badge (R54)', async () => {
    const llama = fakeLlama(echo({ 'came over from another stream': 'relay' }));
    const counts: number[] = [];
    const { annotations, pipeline } = setup({
      fetch: llama.fetch,
      onHiddenChange: (_site, _name, count) => counts.push(count),
    });
    pipeline.ingest(target, {
      ...channel,
      comments: [comment('1', 'came over from another stream')],
    });
    await vi.waitFor(() => expect(annotations()).toHaveLength(1));
    expect(pipeline.hidden(channel.site, channel.channel)).toEqual([
      {
        id: '1',
        ...channel,
        text: 'came over from another stream',
        translation: '訳:came over from another stream',
        category: 'relay',
        source: 'model',
        at: START,
      },
    ]);
    expect(counts).toEqual([1]);
  });
});

describe('genre guess (R63)', () => {
  /** A server that answers the genre prompt with `reply` and records each request body. */
  const genreServer = (reply: string | undefined) => {
    const bodies: ChatBody[] = [];
    const fetch: Fetch = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ChatBody;
      bodies.push(body);
      return reply === undefined
        ? new Response('down', { status: 503 })
        : Response.json({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] });
    };
    return { bodies, fetch };
  };

  it('asks the model once on a comment slot, never the subtitle slot, with the genre grammar', async () => {
    const server = genreServer('horror');
    const { pipeline } = setup({ fetch: server.fetch });
    expect(
      await pipeline.guessGenre({ title: 'Fixture Haunt night', game: 'Fixture Haunt' }),
    ).toEqual(Ok('horror'));
    expect(server.bodies).toHaveLength(1);
    const [body] = server.bodies;
    expect(body).toMatchObject({
      model: 'gemma4-e4b',
      id_slot: 1,
      max_tokens: GENRE_MAX_TOKENS,
      temperature: 0,
      grammar: genrePrompt({}).grammar,
    });
    expect(body?.messages[1]?.content).toBe(
      'Title (JSON string): "Fixture Haunt night"\nGame (JSON string or null): "Fixture Haunt"',
    );
  });

  it('reads an answer outside the genre ids as other, and passes a failed request on', async () => {
    expect(
      await setup({ fetch: genreServer('rpg').fetch }).pipeline.guessGenre({ title: 'x' }),
    ).toEqual(Ok('other'));
    const failed = await setup({ fetch: genreServer(undefined).fetch }).pipeline.guessGenre({
      title: 'x',
    });
    expect(failed).toMatchObject({ ok: false, error: { internalCode: 'network_failed' } });
  });
});
