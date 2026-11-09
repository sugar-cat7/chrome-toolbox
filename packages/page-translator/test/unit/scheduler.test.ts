// @vitest-environment jsdom
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type InternalErrorCode, type Result } from '@chrome-toolbox/contracts';
import { systemTimers, type PageToken, type Timers } from '@chrome-toolbox/extension-core';
import {
  createScheduler,
  PAGE_LIMITS,
  PAGE_TIMING,
  type Scheduler,
} from '../../src/content/scheduler.ts';
import { scanCursor, type Segment } from '../../src/content/segment.ts';
import { createWriter, type Writer } from '../../src/content/writer.ts';
import {
  progressSchema,
  type DisplayMode,
  type Progress,
  type TranslateReply,
  type TranslateRequest,
} from '../../src/protocol.ts';
import {
  installIntersection,
  restorePage,
  setVisibility,
  type FakeIntersection,
} from './intersection.ts';

/** What the fake server puts before each text it translates. */
const TRANSLATED = '訳:';
const FLUSH = PAGE_TIMING.mutationFlushMs;
/** Global Constraints: a scan works at most 8 ms before it yields to the page. */
const SLICE_MS = 8;
/**
 * Lets the scheduler go on. A zero-delay timer set while fake timers run fires 1 ms later, so the
 * scan slices and the observer's reports each take a millisecond here.
 */
async function next(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
}
/** Past the next flush of the page's changes, and the scan it starts. */
const AFTER_FLUSH = FLUSH + 50;

let io: FakeIntersection;
let running: Scheduler | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  io = installIntersection();
  document.title = 'Made-up Guide';
});

afterEach(() => {
  running?.stop();
  running = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restorePage();
  document.body.replaceChildren();
});

/** `value`, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  assert.exists(value);
  return value;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const line = (n: number): string => `Paragraph ${n} of the made-up guide.`;
const textsOf = (tokens: readonly PageToken[]): string[] =>
  tokens.flatMap((token) => (token.t === 'text' ? [token.text] : []));

type Call = Readonly<{
  request: TranslateRequest;
  signal: AbortSignal;
  at: number;
  answer: (result: Result<TranslateReply>) => void;
}>;

/** A translator that holds each request until the test answers it. */
function heldTranslator(): {
  translate: (request: TranslateRequest, signal: AbortSignal) => Promise<Result<TranslateReply>>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    translate: (request, signal) =>
      new Promise((resolve) => calls.push({ request, signal, at: Date.now(), answer: resolve })),
  };
}

/** A working server's answer: every text token as `訳:<text>`. */
const replyTo = (request: TranslateRequest): Result<TranslateReply> =>
  Ok({
    results: request.units.map((unit) => ({
      id: unit.id,
      pieces: textsOf(unit.tokens).map((text) => `${TRANSLATED}${text}`),
    })),
    translator: 'gemma',
  });
/** The text of each unit a request asks for. */
const sourcesOf = (call: Call | undefined): string[] =>
  must(call).request.units.map((unit) => textsOf(unit.tokens).join(' '));

/** Timers that also list the delay of every timer set. */
function recordingTimers(): { timers: Timers; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    timers: {
      set: (fn, ms) => {
        delays.push(ms);
        return systemTimers.set(fn, ms);
      },
      clear: (id) => systemTimers.clear(id),
    },
  };
}

/** A writer that counts its writes and releases, and lists what it released, with its text then. */
function countingWriter(writer: Writer): {
  writer: Writer;
  counts: { write: number; release: number };
  released: (Element | ShadowRoot)[];
  releasedText: (string | null)[];
} {
  const counts = { write: 0, release: 0 };
  const released: (Element | ShadowRoot)[] = [];
  const releasedText: (string | null)[] = [];
  return {
    counts,
    released,
    releasedText,
    writer: {
      ...writer,
      write: (segment, pieces, mode) => {
        counts.write += 1;
        return writer.write(segment, pieces, mode);
      },
      release: (block) => {
        counts.release += 1;
        released.push(block);
        releasedText.push(block.textContent);
        writer.release(block);
      },
    },
  };
}

/** A paragraph `<p data-n="n">` with `text`, not on the page yet. */
function make(n: number, text: (n: number) => string = line): HTMLElement {
  const element = document.createElement('p');
  element.dataset['n'] = String(n);
  element.textContent = text(n);
  return element;
}

/** `count` paragraphs `<p data-n="n">`, numbered from 1, appended to `parent`. */
function paragraphs(
  count: number,
  parent: Element = document.body,
  text: (n: number) => string = line,
): HTMLElement[] {
  const elements = range(1, count).map((n) => make(n, text));
  parent.append(...elements);
  return elements;
}

/** Only the elements whose `data-n` passes `near` come near the viewport. */
function nearOnly(near: (n: number) => boolean): void {
  io.setOnScreen((element) => {
    const n = element.getAttribute('data-n');
    return n !== null && near(Number(n));
  });
}

/** The elements the scheduler's IntersectionObserver watches now. */
const observed = (): Element[] => io.observers[0]?.targets() ?? [];

type Started = {
  scheduler: Scheduler;
  writer: Writer;
  calls: Call[];
  progress: Progress[];
};

/** A scheduler started on the test page, with a held translator and a real writer. */
function start(
  options: {
    translate?: (request: TranslateRequest, signal: AbortSignal) => Promise<Result<TranslateReply>>;
    writer?: Writer;
    mode?: DisplayMode;
    timers?: Timers;
    now?: () => number;
  } = {},
): Started {
  const held = heldTranslator();
  const writer = options.writer ?? createWriter(document);
  const progress: Progress[] = [];
  const scheduler = createScheduler({
    doc: document,
    writer,
    translate: options.translate ?? held.translate,
    mode: () => options.mode ?? 'replace',
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.now === undefined ? {} : { now: options.now }),
    onProgress: (next) => progress.push(next),
  });
  running = scheduler;
  scheduler.start();
  return { scheduler, writer, calls: held.calls, progress };
}

/** Answers call `i` as a working server, then lets the scheduler go on. */
async function answer(calls: Call[], i: number): Promise<void> {
  const call = must(calls[i]);
  call.answer(replyTo(call.request));
  await vi.advanceTimersByTimeAsync(0);
}

/** Answers every request as a working server until none is left. */
async function answerAll(calls: Call[]): Promise<void> {
  for (let i = 0; i < calls.length; i += 1) await answer(calls, i);
}

const texts = (elements: readonly Element[]): (string | null)[] =>
  elements.map((element) => element.textContent);

describe('createScheduler', () => {
  it('asks only for paragraphs near the viewport, one batch at a time', async () => {
    const elements = paragraphs(300);
    nearOnly((n) => n <= 12);
    const { calls } = start();
    await next();
    expect(calls).toHaveLength(1);
    expect(sourcesOf(calls[0])).toEqual(range(1, 6).map(line));
    expect(must(calls[0]).request).toMatchObject({
      purpose: 'page',
      page: { title: 'Made-up Guide', site: 'wiki.fixture.test' },
    });
    // One request at a time: the next waits for the answer.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    await answer(calls, 0);
    expect(calls).toHaveLength(2);
    expect(sourcesOf(calls[1])).toEqual(range(7, 12).map(line));
    await answer(calls, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    expect(texts(elements.slice(0, 12))).toEqual(
      range(1, 12).map((n) => `${TRANSLATED}${line(n)}`),
    );
    expect(texts(elements.slice(12))).toEqual(range(13, 300).map(line));
  });

  it('caps a batch at 6 units and 800 characters', async () => {
    // 300 characters each: two make 600, a third would pass 800.
    const long = (n: number): string => `Part ${n}: ${'moss gate lore '.repeat(20)}`.slice(0, 300);
    expect(long(1)).toHaveLength(300);
    paragraphs(4, document.body, long);
    nearOnly(() => true);
    const { calls } = start();
    await next();
    expect(sourcesOf(calls[0])).toEqual([long(1), long(2)]);
    await answer(calls, 0);
    expect(sourcesOf(calls[1])).toEqual([long(3), long(4)]);
    await answer(calls, 1);
    expect(calls).toHaveLength(2);
  });

  it('never asks for paragraphs that a jump scrolled past', async () => {
    paragraphs(300);
    nearOnly((n) => n <= 12);
    const { calls } = start();
    await next();
    expect(calls).toHaveLength(1);
    nearOnly((n) => n >= 150 && n <= 162);
    io.update();
    await answerAll(calls);
    const asked = calls.flatMap(sourcesOf);
    expect(asked).toEqual([...range(1, 6), ...range(150, 162)].map(line));
    for (const n of range(13, 149)) expect(asked).not.toContain(line(n));
  });

  it('drops a waiting paragraph that left the viewport before its batch', async () => {
    const elements = paragraphs(20);
    nearOnly((n) => n <= 12);
    const { calls } = start();
    await next();
    expect(sourcesOf(calls[0])).toEqual(range(1, 6).map(line));
    nearOnly((n) => n <= 6);
    io.update();
    await answer(calls, 0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(texts(elements.slice(6, 12))).toEqual(range(7, 12).map(line));
  });

  it('asks once for repeated text and fills every copy from the cache', async () => {
    const list = document.createElement('ul');
    document.body.append(list);
    const item = (n: number): HTMLElement => {
      const element = document.createElement('li');
      element.dataset['n'] = String(n);
      element.textContent = 'Edit';
      return element;
    };
    const items = range(1, 20).map(item);
    list.append(...items);
    nearOnly(() => true);
    const { scheduler, calls } = start();
    await next();
    expect(calls).toHaveLength(1);
    expect(sourcesOf(calls[0])).toEqual(['Edit']);
    // A copy that appears while the text is asked for waits for the same answer.
    const during = item(21);
    list.append(during);
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(calls).toHaveLength(1);
    await answer(calls, 0);
    expect(texts([...items, during])).toEqual(range(1, 21).map(() => `${TRANSLATED}Edit`));
    // A copy that appears later comes from the cache at once, without a request, even away
    // from the viewport (a block the page draws again shows no original in between).
    nearOnly((n) => n <= 21);
    const late = item(22);
    list.append(late);
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(late.textContent).toBe(`${TRANSLATED}Edit`);
    expect(observed()).not.toContain(late);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(scheduler.progress()).toMatchObject({ found: 22, done: 22, cached: 1 });
  });

  it('asks nothing for a Japanese page', async () => {
    document.body.innerHTML =
      '<article data-n="1"><h1 data-n="1">攻略のまとめ</h1><p data-n="1">後ろに転がると光の攻撃を避けられる。</p></article>';
    nearOnly(() => true);
    const { scheduler, calls } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    expect(scheduler.progress()).toMatchObject({ found: 0, done: 0, waiting: 0 });
  });

  it('stops while hidden and resumes when visible', async () => {
    const elements = paragraphs(20);
    nearOnly((n) => n <= 6);
    const { calls } = start();
    await next();
    expect(calls).toHaveLength(1);
    setVisibility(document, 'hidden');
    expect(must(calls[0]).signal.aborted).toBe(true);
    // The aborted request's answer comes too late to be written.
    await answer(calls, 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(texts(elements.slice(0, 6))).toEqual(range(1, 6).map(line));
    setVisibility(document, 'visible');
    await next();
    expect(calls).toHaveLength(2);
    expect(sourcesOf(calls[1])).toEqual(range(1, 6).map(line));
    await answer(calls, 1);
    expect(texts(elements.slice(0, 6))).toEqual(range(1, 6).map((n) => `${TRANSLATED}${line(n)}`));
  });

  it('asks for what is near when the page comes back, not what was near when it left', async () => {
    paragraphs(20);
    nearOnly((n) => n <= 12);
    const { calls } = start();
    await next();
    expect(sourcesOf(calls[0])).toEqual(range(1, 6).map(line));
    setVisibility(document, 'hidden');
    // The page scrolled while it was hidden.
    nearOnly((n) => n >= 13 && n <= 18);
    setVisibility(document, 'visible');
    await answerAll(calls);
    expect(calls.slice(1).map(sourcesOf)).toEqual([range(13, 18).map(line)]);
  });

  it('waits until visible before scanning a page opened in a background tab', async () => {
    paragraphs(20);
    nearOnly((n) => n <= 6);
    setVisibility(document, 'hidden');
    const { scheduler, calls } = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(io.observers).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(scheduler.progress()).toMatchObject({ state: 'on', found: 0 });
    setVisibility(document, 'visible');
    await next();
    expect(observed()).toHaveLength(20);
    expect(sourcesOf(calls[0])).toEqual(range(1, 6).map(line));
  });

  it('batches 50 added paragraphs into one flush', async () => {
    const feed = document.createElement('div');
    document.body.append(feed);
    nearOnly((n) => n <= 3);
    const { timers, delays } = recordingTimers();
    const { calls } = start({ timers, now: () => 0 });
    await next();
    const scansBefore = delays.filter((ms) => ms === 0).length;
    for (const n of range(1, 50)) {
      feed.append(make(n));
      await vi.advanceTimersByTimeAsync(5);
    }
    // 250 ms in: nothing is scanned or asked for before the flush.
    expect(observed()).toHaveLength(0);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(delays.filter((ms) => ms === FLUSH)).toHaveLength(1);
    // One scan for the whole flush.
    expect(delays.filter((ms) => ms === 0).length - scansBefore).toBe(1);
    expect(observed()).toHaveLength(50);
    expect(calls).toHaveLength(1);
    expect(sourcesOf(calls[0])).toEqual(range(1, 3).map(line));
  });

  it('re-translates a paragraph the page rewrote and keeps the page value on restore', async () => {
    document.body.innerHTML = '<p data-n="1">Counter value is <b>twelve</b> now</p>';
    const paragraph = must(document.querySelector('p'));
    const bold = must(paragraph.querySelector('b')?.firstChild);
    assert.instanceOf(bold, Text);
    nearOnly(() => true);
    const { scheduler, writer, calls } = start();
    await next();
    expect(sourcesOf(calls[0])).toEqual(['Counter value is twelve now']);
    await answer(calls, 0);
    expect(paragraph.textContent).toBe(
      `${TRANSLATED}Counter value is ${TRANSLATED}twelve ${TRANSLATED}now`,
    );
    // The page's own update (React's counter) of one node of the paragraph.
    bold.data = 'thirteen';
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(calls).toHaveLength(2);
    // The other nodes were given back first: the request holds no translation.
    expect(sourcesOf(calls[1])).toEqual(['Counter value is thirteen now']);
    await answer(calls, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    expect(paragraph.textContent).toBe(
      `${TRANSLATED}Counter value is ${TRANSLATED}thirteen ${TRANSLATED}now`,
    );
    // The writer holds exactly the paragraphs done: the old one was given back, not kept apart.
    expect(writer.size()).toBe(scheduler.progress().done);
    expect(scheduler.progress()).toMatchObject({ found: 1, tracked: 1, done: 1 });
    scheduler.stop();
    writer.restore({ sliced: false });
    expect(paragraph.textContent).toBe('Counter value is thirteen now');
  });

  it('scans the whole body again after a burst of more than 500 changes', async () => {
    const elements = paragraphs(600);
    nearOnly(() => false);
    const { scheduler, calls } = start();
    await next();
    expect(scheduler.progress().found).toBe(600);
    // The page rewrites every paragraph at once: more changed nodes than one flush gathers.
    const fresh = (n: number): string => `Rewritten paragraph ${n} of the guide.`;
    for (const [i, element] of elements.entries()) {
      const text = must(element.firstChild);
      assert.instanceOf(text, Text);
      text.data = fresh(i + 1);
    }
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    nearOnly((n) => n <= 6);
    io.update();
    await next();
    expect(scheduler.progress().found).toBe(600);
    expect(sourcesOf(calls[0])).toEqual(range(1, 6).map(fresh));
  });

  it('translates again a paragraph in an open shadow root the page rewrote', async () => {
    const host = document.createElement('section');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p data-n="1">Shadow paragraph one.</p>';
    nearOnly(() => true);
    const { calls } = start();
    await next();
    expect(sourcesOf(calls[0])).toEqual(['Shadow paragraph one.']);
    await answer(calls, 0);
    const text = must(shadow.querySelector('p')?.firstChild);
    assert.instanceOf(text, Text);
    text.data = 'Shadow paragraph two.';
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(sourcesOf(calls[1])).toEqual(['Shadow paragraph two.']);
  });

  it('takes in a shadow root attached later once its host’s children change', async () => {
    const host = document.createElement('section');
    document.body.append(host);
    nearOnly(() => true);
    const { calls } = start();
    await next();
    // Attaching a shadow root is no change the observer reports.
    host.attachShadow({ mode: 'open' }).innerHTML = '<p data-n="1">Late shadow words.</p>';
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(calls).toHaveLength(0);
    host.append(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(sourcesOf(calls[0])).toEqual(['Late shadow words.']);
  });

  it('takes in a shadow root attached later when started again, leaving the rest as it is', async () => {
    const [first] = paragraphs(1);
    const host = document.createElement('section');
    document.body.append(host);
    nearOnly(() => true);
    const counted = countingWriter(createWriter(document));
    const { scheduler, calls } = start({ writer: counted.writer });
    await next();
    await answer(calls, 0);
    expect(must(first).textContent).toBe(`${TRANSLATED}${line(1)}`);
    counted.released.length = 0;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p data-n="2">Late shadow words.</p>';
    scheduler.start();
    await next();
    expect(calls.map(sourcesOf)).toEqual([[line(1)], ['Late shadow words.']]);
    // Only the containers holding no paragraph yet are made again; the translated one is kept.
    expect(counted.released).toEqual([document.body, host, shadow, shadow.querySelector('p')]);
    expect(must(first).textContent).toBe(`${TRANSLATED}${line(1)}`);
  });

  it('releases blocks an SPA removed', async () => {
    const main = document.createElement('main');
    document.body.append(main);
    const old = paragraphs(20, main);
    nearOnly((n) => n <= 6);
    const { calls } = start();
    await next();
    expect(sourcesOf(calls[0])).toEqual(range(1, 6).map(line));
    // The route changes: the whole body of the page is replaced.
    const page = (n: number): string => `Another page, paragraph ${n}.`;
    const fresh = range(101, 120).map((n) => make(n, page));
    main.replaceChildren(...fresh);
    nearOnly((n) => n >= 101 && n <= 106);
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(observed().length).toBeGreaterThan(0);
    expect(observed().every((element) => element.isConnected)).toBe(true);
    for (const element of old) expect(observed()).not.toContain(element);
    await answerAll(calls);
    expect(calls).toHaveLength(2);
    expect(sourcesOf(calls[1])).toEqual(range(101, 106).map(page));
    // The answer for the removed paragraphs was not written into them.
    expect(texts(old.slice(0, 6))).toEqual(range(1, 6).map(line));
    expect(texts(fresh.slice(0, 6))).toEqual(range(101, 106).map((n) => `${TRANSLATED}${page(n)}`));
  });

  it('retries a failed batch twice, then marks it failed', async () => {
    paragraphs(3);
    nearOnly(() => true);
    const at: number[] = [];
    const { scheduler, progress } = start({
      translate: () => {
        at.push(Date.now());
        return Promise.resolve(Err(failure('network_failed')));
      },
    });
    await vi.advanceTimersByTimeAsync(400_000);
    // Sent at once, again after 5 s, and after 30 s more; then never.
    const first = must(at[0]);
    expect(at.map((time) => time - first)).toEqual([0, 5_000, 35_000]);
    expect(scheduler.progress()).toMatchObject({
      found: 3,
      done: 0,
      failed: 3,
      notice: 'unreachable',
    });
    expect(progress.at(-1)).toEqual(scheduler.progress());
  });

  it('sends no retry while hidden', async () => {
    paragraphs(2);
    nearOnly(() => true);
    let asked = 0;
    start({
      translate: () => {
        asked += 1;
        return Promise.resolve(Err(failure('network_failed')));
      },
    });
    await next();
    expect(asked).toBe(1);
    setVisibility(document, 'hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toBe(1);
    setVisibility(document, 'visible');
    await next();
    expect(asked).toBe(2);
  });

  it.each([
    { code: 'queue_full', retried: true },
    { code: 'ipc_failed', retried: true },
    { code: 'operation_cancelled', retried: true },
    { code: 'response_invalid', retried: false },
  ] satisfies { code: InternalErrorCode; retried: boolean }[])(
    'retries a batch that failed with $code: $retried',
    async ({ code, retried }) => {
      paragraphs(2);
      nearOnly(() => true);
      let asked = 0;
      const { scheduler } = start({
        translate: () => {
          asked += 1;
          return Promise.resolve(Err(failure(code)));
        },
      });
      await vi.advanceTimersByTimeAsync(PAGE_TIMING.retryMs[0] + 50);
      expect(asked).toBe(retried ? 2 : 1);
      expect(scheduler.progress().failed).toBe(retried ? 0 : 2);
      expect(scheduler.progress().notice).toBeUndefined();
      // Each send counts an attempt: the third failure is the last.
      await vi.advanceTimersByTimeAsync(400_000);
      expect(asked).toBe(retried ? PAGE_TIMING.attempts : 1);
      expect(scheduler.progress()).toMatchObject({ failed: 2, done: 0 });
      expect(scheduler.progress().notice).toBe(retried ? 'unreachable' : undefined);
    },
  );

  it('clears unreachable once a request goes through, keeping the failed paragraphs counted', async () => {
    // The choice: `notice` tells whether llama.cpp answers now; the paragraphs that failed stay
    // in `failed` (原文のまま) until the page is translated again.
    paragraphs(3);
    nearOnly((n) => n <= 2);
    let down = true;
    const { scheduler } = start({
      translate: (request) =>
        Promise.resolve(down ? Err(failure('network_failed')) : replyTo(request)),
    });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(scheduler.progress()).toMatchObject({ failed: 2, notice: 'unreachable' });
    down = false;
    nearOnly(() => true);
    io.update();
    await next();
    expect(scheduler.progress()).toMatchObject({ failed: 2, done: 1 });
    expect(scheduler.progress().notice).toBeUndefined();
  });

  it('gives a changed block back before reading it again', async () => {
    document.body.innerHTML = '<p data-n="1">Counter value is <b>twelve</b> now</p>';
    const paragraph = must(document.querySelector('p'));
    const bold = must(paragraph.querySelector('b')?.firstChild);
    assert.instanceOf(bold, Text);
    nearOnly(() => true);
    const counted = countingWriter(createWriter(document));
    const { calls } = start({ writer: counted.writer });
    await next();
    await answer(calls, 0);
    counted.released.length = 0;
    counted.releasedText.length = 0;
    bold.data = 'thirteen';
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    // Released once, while the rest of it still showed the translation…
    expect(counted.released).toEqual([paragraph]);
    expect(counted.releasedText).toEqual([
      `${TRANSLATED}Counter value is thirteen ${TRANSLATED}now`,
    ]);
    // …so the scan after it read the original text.
    expect(sourcesOf(calls[1])).toEqual(['Counter value is thirteen now']);
  });

  it('fails only the paragraph whose unit came back without pieces', async () => {
    const elements = paragraphs(2);
    nearOnly(() => true);
    const { scheduler, calls } = start();
    await next();
    const [first, second] = must(calls[0]).request.units;
    // The second unit's translation could not be read back (P21).
    must(calls[0]).answer(
      Ok({
        results: [{ id: must(first).id, pieces: [`${TRANSLATED}one`] }, { id: must(second).id }],
        translator: 'gemma',
        notice: 'plamo_missing',
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(texts(elements)).toEqual([`${TRANSLATED}one`, line(2)]);
    expect(scheduler.progress()).toMatchObject({
      found: 2,
      done: 1,
      failed: 1,
      notice: 'plamo_missing',
      translator: 'gemma',
    });
  });

  it('starting again clears the failures and asks for the near paragraphs again', async () => {
    paragraphs(3);
    nearOnly(() => true);
    let fail = true;
    const asked: TranslateRequest[] = [];
    const { scheduler } = start({
      translate: (request) => {
        asked.push(request);
        return Promise.resolve(fail ? Err(failure('network_failed')) : replyTo(request));
      },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(3);
    expect(scheduler.progress()).toMatchObject({ failed: 3, notice: 'unreachable' });
    fail = false;
    scheduler.start();
    await next();
    expect(asked).toHaveLength(4);
    expect(scheduler.progress()).toMatchObject({ done: 3, failed: 0 });
    expect(scheduler.progress().notice).toBeUndefined();
  });

  it('stops registering at 10,000 tracked paragraphs', { timeout: 60_000 }, async () => {
    // 1,700 blocks of 6 lines: 10,200 paragraphs in fewer blocks than the observer may watch.
    document.body.innerHTML = range(1, 1700)
      .map(
        (n) =>
          `<p data-n="${n}">${range(1, 6)
            .map((i) => `Line ${i} of part ${n}.`)
            .join('<br>')}</p>`,
      )
      .join('');
    nearOnly(() => false);
    const { scheduler, calls } = start();
    await next();
    expect(scheduler.progress()).toMatchObject({ tracked: PAGE_LIMITS.tracked, limit: true });
    // The block holding the 10,000th paragraph is the last one watched.
    expect(observed()).toHaveLength(Math.ceil(PAGE_LIMITS.tracked / 6));
    const late = make(0);
    document.body.prepend(late);
    nearOnly(() => true);
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(observed()).not.toContain(late);
    expect(calls).toHaveLength(0);
    // The page drops ten blocks (60 paragraphs): there is room again, and the flag clears.
    const blocks = [...document.querySelectorAll('p[data-n]')].filter((p) => p !== late);
    for (const block of blocks.slice(0, 10)) block.remove();
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(scheduler.progress()).toMatchObject({ tracked: PAGE_LIMITS.tracked - 60, limit: false });
    // A paragraph the page adds now is taken in; the one left out earlier waits for a new start.
    const later = make(0);
    document.body.append(later);
    await vi.advanceTimersByTimeAsync(AFTER_FLUSH);
    expect(observed()).toContain(later);
    expect(observed()).not.toContain(late);
    // A new start scans for what was left out: the room fills up (the first in page order) and
    // the flag is set again.
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(observed()).toContain(late);
    expect(scheduler.progress()).toMatchObject({ tracked: PAGE_LIMITS.tracked, limit: true });
  });

  it('stops scanning at 5,000 watched blocks and goes on when some are let go', async () => {
    paragraphs(PAGE_LIMITS.observedBlocks + 10);
    nearOnly(() => false);
    const { scheduler, calls } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(observed()).toHaveLength(PAGE_LIMITS.observedBlocks);
    expect(scheduler.progress().found).toBe(PAGE_LIMITS.observedBlocks);
    // Six blocks are translated and let go: the scan takes in six more and waits again.
    nearOnly((n) => n <= 6);
    io.update();
    await answer(calls, 0);
    await next();
    expect(scheduler.progress()).toMatchObject({ found: PAGE_LIMITS.observedBlocks + 6, done: 6 });
    expect(observed()).toHaveLength(PAGE_LIMITS.observedBlocks);
    // Six more let go: the last four are taken in, and the scan is over.
    nearOnly((n) => n >= 7 && n <= 12);
    io.update();
    await answer(calls, 1);
    await next();
    expect(scheduler.progress()).toMatchObject({
      found: PAGE_LIMITS.observedBlocks + 10,
      done: 12,
    });
    expect(observed()).toHaveLength(PAGE_LIMITS.observedBlocks - 2);
  });

  it('ignores its own writes and pair hosts in the mutation records', async () => {
    const elements = paragraphs(3);
    nearOnly(() => true);
    const { timers, delays } = recordingTimers();
    const counted = countingWriter(createWriter(document));
    const { calls } = start({ writer: counted.writer, mode: 'pair', timers });
    await next();
    await answer(calls, 0);
    expect(document.querySelectorAll('pt-ja')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    const before = { ...counted.counts, timers: delays.length };
    expect(before.write).toBe(3);
    // The writer switches to replace (its own text, its boxes removed), and a pair host appears.
    counted.writer.setMode('replace');
    await next();
    expect(texts(elements)).toEqual(range(1, 3).map((n) => `${TRANSLATED}${line(n)}`));
    must(elements[0]).after(document.createElement('pt-ja'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect({ ...counted.counts, timers: delays.length }).toEqual(before);
    expect(calls).toHaveLength(1);
  });

  it('refills the waiting list where it stopped, without sorting the page again', async () => {
    // 1,000 near blocks: more units than the waiting list holds.
    paragraphs(1000);
    nearOnly(() => true);
    const compare = vi.spyOn(Node.prototype, 'compareDocumentPosition');
    const { scheduler, calls } = start();
    await next();
    await answerAll(calls);
    expect(scheduler.progress()).toMatchObject({ done: 1000, waiting: 0 });
    expect(calls.flatMap(sourcesOf)).toEqual(range(1, 1000).map(line));
    // The blocks are put in page order once, as they come near (n log n), not again per batch.
    expect(compare.mock.calls.length).toBeLessThan(2 * 1000 * Math.log2(1000));
  });

  it('translates a block of many lines in turn, scanning it in slices', async () => {
    document.body.innerHTML = `<div data-n="1">${range(1, 1000).map(line).join('<br>')}</div>`;
    nearOnly(() => true);
    // The steps a scan of the body takes: each visits one element or reads one child.
    const cursor = scanCursor({ root: document.body, hint: undefined, nextId: () => 0 });
    const out: Segment[] = [];
    let steps = 1;
    while (cursor.step(out)) steps += 1;
    expect(out).toHaveLength(1000);
    // A fake clock: each look at it is 1 ms later, and the scheduler looks once per step.
    let clock = 0;
    const spans: number[] = [];
    const { timers, delays } = recordingTimers();
    const sliced: Timers = {
      set: (fn, ms) =>
        timers.set(
          ms !== 0
            ? fn
            : () => {
                const started = clock;
                fn();
                // From the slice's first look at the clock to its last.
                if (clock > started) spans.push(clock - started - 1);
              },
          ms,
        ),
      clear: (id) => timers.clear(id),
    };
    const { scheduler, calls } = start({ timers: sliced, now: () => (clock += 1) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.progress().found).toBe(1000);
    // Every slice stops at SLICE_MS: one zero-delay yield per 8 steps.
    expect(delays.filter((ms) => ms === 0)).toHaveLength(Math.ceil(steps / SLICE_MS));
    expect(spans).toHaveLength(Math.ceil(steps / SLICE_MS));
    expect(Math.max(...spans)).toBe(SLICE_MS);
    await answerAll(calls);
    expect(calls.every((call) => call.request.units.length <= PAGE_LIMITS.batchUnits)).toBe(true);
    expect(calls.flatMap(sourcesOf)).toEqual(range(1, 1000).map(line));
    expect(scheduler.progress()).toMatchObject({ found: 1000, done: 1000, waiting: 0 });
    // A block whose paragraphs are all done is watched no more.
    expect(observed()).toHaveLength(0);
  });

  it('stops at once, idempotently, and lets nothing in afterwards', async () => {
    const elements = paragraphs(6);
    nearOnly(() => true);
    const { scheduler, calls } = start();
    await next();
    expect(calls).toHaveLength(1);
    scheduler.stop();
    expect(must(calls[0]).signal.aborted).toBe(true);
    expect(observed()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.stop();
    await answer(calls, 0);
    paragraphs(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(texts(elements)).toEqual(range(1, 6).map(line));
    expect(scheduler.progress()).toMatchObject({ state: 'idle', found: 0, cached: 0 });
  });

  it('reports progress in the popup’s shape, with the display mode', async () => {
    paragraphs(8);
    nearOnly(() => true);
    const { scheduler, calls, progress } = start({ mode: 'pair' });
    await next();
    expect(progressSchema.parse(scheduler.progress())).toEqual({
      state: 'on',
      mode: 'pair',
      found: 8,
      done: 0,
      waiting: 8,
      failed: 0,
      tracked: 8,
      cached: 0,
      limit: false,
    });
    await answerAll(calls);
    expect(progress.at(-1)).toMatchObject({
      found: 8,
      done: 8,
      waiting: 0,
      cached: 8,
      translator: 'gemma',
    });
  });
});
