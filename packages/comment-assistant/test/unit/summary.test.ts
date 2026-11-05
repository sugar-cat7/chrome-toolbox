import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@chrome-toolbox/contracts';
import {
  createLlamaClient,
  createQueue,
  summaryLines,
  type CommentRecord,
  type Fetch,
} from '@chrome-toolbox/extension-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeComment } from '../../src/fastpath.ts';
import { peaksOf, summarize, summaryInput, type SlotRunner } from '../../src/summary.ts';
import { SUMMARY_NOW, SUMMARY_REPLY, variedRecords } from './summary-fixture.ts';

// The summary's normalizations are counted (R45); they still normalize.
vi.mock(import('../../src/fastpath.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    normalizeComment: vi.fn<typeof actual.normalizeComment>(actual.normalizeComment),
  };
});

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 30);
/** The start of the minute `ago` minutes before NOW's minute. */
const minuteAgo = (ago: number): number => Math.floor(NOW / MINUTE) * MINUTE - ago * MINUTE;

let serial = 0;
/** A translated English chat comment `minutesAgo` before NOW; `extra` overrides any field. */
const record = (
  text: string,
  minutesAgo: number,
  extra: Partial<CommentRecord> = {},
): CommentRecord => {
  serial += 1;
  return {
    id: `r${serial}`,
    site: 'youtube',
    channel: 'fixture0001',
    author: `viewer${serial}`,
    text,
    lang: 'en',
    at: NOW - minutesAgo * MINUTE,
    state: 'done',
    category: 'chatter',
    translation: `訳:${text}`,
    ...extra,
  };
};
const japanese = (text: string, minutesAgo: number, extra: Partial<CommentRecord> = {}) =>
  record(text, minutesAgo, { lang: 'ja', translation: undefined, ...extra });

type ChatBody = { id_slot: number; max_tokens: number; grammar: string; model: string };
/**
 * A llama-server chat endpoint at the HTTP boundary that answers every request with `reply`, or
 * is unreachable without one.
 */
const fakeServer = (reply?: string) => {
  const bodies: (ChatBody & { messages: { content: string }[] })[] = [];
  const fetch: Fetch = async (_input, init) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    if (reply === undefined) throw new TypeError('Failed to fetch');
    return Response.json({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] });
  };
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:18083',
    fetch,
    queue: createQueue(),
  });
  return { bodies, model: { client, model: 'gemma4-e4b' } };
};
/** Runs the model call on slot 1 at once, as a pipeline with a free slot does. */
const slotOne: SlotRunner = (fn) => fn(1, new AbortController().signal);

describe('chat summary', () => {
  it.each([
    { windowMinutes: 5, ago: [1, 4, 6] },
    { windowMinutes: 15, ago: [1, 14, 16] },
  ] as const)(
    'uses only the records of the last $windowMinutes minutes',
    async ({ windowMinutes, ago }) => {
      const records = ago.map((minutes) => record(`comment ${minutes}`, minutes));
      const server = fakeServer('T 話題\n');
      const made = await summarize(
        server.model,
        () => records,
        windowMinutes,
        () => NOW,
        slotOne,
      );
      expect(made).toMatchObject({
        ok: true,
        value: { windowMinutes, total: 2, from: NOW - ago[1] * MINUTE, generatedAt: NOW },
      });
      const lines = summaryLines(summaryInput(records, NOW, windowMinutes));
      expect(lines.join('\n')).toContain(`comment ${ago[0]}`);
      expect(lines.join('\n')).toContain(`comment ${ago[1]}`);
      expect(lines.join('\n')).not.toContain(`comment ${ago[2]}`);
    },
  );

  it('finds the three busiest minutes, in time order', () => {
    const counts = [
      [0, 2],
      [1, 5],
      [2, 1],
      [3, 4],
      [4, 5],
    ] as const;
    const records = counts.flatMap(([ago, count]) =>
      Array.from({ length: count }, (_, i) =>
        record(`m${ago} ${i}`, 0, { at: minuteAgo(ago) + i }),
      ),
    );
    // A record before the window is not counted, nor abusive or spam ones (a raid is no peak).
    records.push(record('old', 0, { at: minuteAgo(10) }));
    for (const category of ['abusive', 'spam', 'spam'] as const)
      records.push(record(`hidden ${category}`, 0, { at: minuteAgo(2) + 9, category }));
    expect(peaksOf(records, NOW, 5)).toEqual([
      { minute: minuteAgo(4), count: 5 },
      { minute: minuteAgo(3), count: 4 },
      { minute: minuteAgo(1), count: 5 },
    ]);
    // Ties go to the newer minute.
    const flat = [0, 1, 2, 3].map((ago) => record(`flat ${ago}`, 0, { at: minuteAgo(ago) }));
    expect(peaksOf(flat, NOW, 5)).toEqual([
      { minute: minuteAgo(2), count: 1 },
      { minute: minuteAgo(1), count: 1 },
      { minute: minuteAgo(0), count: 1 },
    ]);
  });

  it('gives the model neither hidden (abusive, spam, spoiler) nor unanswered (pending, failed) comments', () => {
    const records = [
      record('kept done', 1),
      record('kept skipped', 1, { state: 'skipped', translation: undefined, category: undefined }),
      japanese('日本語のまま', 1),
      record('rude', 1, { category: 'abusive', abusive: 0.9 }),
      record('buy coins', 1, { category: 'spam' }),
      record('the boss dies', 1, { category: 'spoiler' }),
      record('waiting', 1, { state: 'pending', translation: undefined, category: undefined }),
      record('broken', 1, { state: 'failed', translation: undefined, category: undefined }),
      record('🔥🔥', 1, { lang: 'und', state: 'skipped', translation: undefined }),
    ];
    const text = summaryLines(summaryInput(records, NOW, 5)).join('\n');
    // Translations stand for translated comments; a Japanese or untranslated one is as written.
    for (const kept of ['訳:kept done', 'kept skipped', '日本語のまま'])
      expect(text).toContain(kept);
    for (const left of ['rude', 'coins', 'boss', 'waiting', 'broken', '🔥'])
      expect(text).not.toContain(left);
  });

  it('counts comments stored while the chat was not in front and reads them as written (R44)', async () => {
    /** A comment read while its chat was not in front: no translation, no category. */
    const stored = (text: string, minutesAgo: number, extra: Partial<CommentRecord> = {}) =>
      record(text, minutesAgo, {
        lang: 'und-Latn',
        state: 'stored',
        translation: undefined,
        category: undefined,
        ...extra,
      });
    const records = [
      record('translated line', 2),
      stored('stored line', 2),
      stored('stored question?', 1),
      stored('保存だけのコメント', 1, { lang: 'ja' }),
      stored('long ago', 20),
    ];
    // Every stored comment counts toward the total and the busy minutes.
    expect(peaksOf(records, NOW, 5)).toEqual([
      { minute: minuteAgo(2), count: 2 },
      { minute: minuteAgo(1), count: 2 },
    ]);
    // The model reads them as written, as chat: a stored question is no question.
    const input = summaryInput(records, NOW, 5);
    expect(input.questions).toEqual([]);
    const text = summaryLines(input).join('\n');
    for (const line of [
      '訳:translated line',
      '"stored line"',
      '"stored question?"',
      '保存だけのコメント',
    ])
      expect(text).toContain(line);
    const server = fakeServer('T 話題\n');
    const made = await summarize(
      server.model,
      () => records,
      5,
      () => NOW,
      slotOne,
    );
    expect(made).toMatchObject({ ok: true, value: { total: 4, unprocessed: 3, questions: [] } });
    // None stored: none unprocessed.
    const none = await summarize(
      server.model,
      () => records.slice(0, 1),
      5,
      () => NOW,
      slotOne,
    );
    expect(none).toMatchObject({ ok: true, value: { total: 1, unprocessed: 0 } });
  });

  it('writes the same text once with ×N, questions first and the most written first', () => {
    const records = [
      // Three busy minutes of greetings: the bursts.
      ...[10, 11, 12].flatMap((ago) => Array.from({ length: 5 }, () => japanese('わこつ', ago))),
      japanese('ナイス', 4),
      japanese('ないす', 3),
      japanese('ナイス！！！！', 3),
      japanese('ナイス!!!', 2),
      japanese('次の配信はいつ？', 4, { category: 'question' }),
      japanese('次の配信はいつ？', 2, { category: 'question' }),
      japanese('BGMいいね', 2),
    ];
    const input = summaryInput(records, NOW, 15);
    expect(input.questions).toEqual([{ text: '次の配信はいつ？', count: 2 }]);
    expect(input.peaks).toEqual([
      [{ text: 'わこつ', count: 5 }],
      [{ text: 'わこつ', count: 5 }],
      [{ text: 'わこつ', count: 5 }],
    ]);
    // `ナイス！！！！` and `ナイス!!!` normalize alike; `ないす` is another text. Ties: newest first.
    expect(input.others).toEqual([
      { text: 'ナイス!!!', count: 2 },
      { text: 'BGMいいね', count: 1 },
      { text: 'ないす', count: 1 },
      { text: 'ナイス', count: 1 },
    ]);
  });

  it('lists the comments of each busy minute under its burst, questions apart, each text once', () => {
    const records = [
      ...Array.from({ length: 4 }, (_, i) => japanese('すごい回避', 2, { at: minuteAgo(2) + i })),
      japanese('初見？', 2, { at: minuteAgo(2) + 5, category: 'question' }),
      japanese('こんばんは', 4),
      japanese('すごい回避', 3),
    ];
    const input = summaryInput(records, NOW, 5);
    // Bursts in time order; a burst counts its own minute only.
    expect(input.peaks).toEqual([
      [{ text: 'こんばんは', count: 1 }],
      [{ text: 'すごい回避', count: 1 }],
      [{ text: 'すごい回避', count: 4 }],
    ]);
    expect(input.questions).toEqual([{ text: '初見？', count: 1 }]);
    // A text already under a burst is not repeated among the rest.
    expect(input.others).toEqual([]);
  });

  it('fits 500 comments into 2,400 characters of lines and keeps every question', () => {
    const records = Array.from({ length: 500 }, (_, i) =>
      i % 20 === 0
        ? record(`question number ${i} about the second phase of the boss fight?`, (i % 29) + 0.5, {
            category: 'question',
          })
        : record(`comment ${i} with enough words to fill a long line of chat text`, (i % 29) + 0.5),
    );
    const input = summaryInput(records, NOW, 30);
    const lines = summaryLines(input);
    expect(Array.from(lines.join('')).length).toBeLessThanOrEqual(2400);
    expect(lines.every((line) => Array.from(line).length <= 60)).toBe(true);
    expect(input.questions).toHaveLength(25);
    // Every line here is cut to 60 characters: 40 of them fill the budget exactly.
    expect(lines).toHaveLength(40);
  });

  it('keeps the 40 most asked questions when there are more', () => {
    const records = Array.from({ length: 45 }, (_, i) =>
      record(`q${i}?`, 1, { category: 'question', at: NOW - MINUTE + i }),
    );
    records.push(record('q0?', 1, { category: 'question' }));
    const input = summaryInput(records, NOW, 5);
    expect(input.questions).toHaveLength(40);
    expect(input.questions[0]).toEqual({ text: '訳:q0?', count: 2 });
  });

  it('merges questions and labels bursts with the model, counting the merged comments itself', async () => {
    const records = [
      ...['how long is phase 2?', 'how long is phase 2?', 'how long is phase 2?'].map((text) =>
        record(text, 3, { category: 'question' }),
      ),
      record('what weapon?', 2, { category: 'question' }),
      ...['is phase 2 long?', 'is phase 2 long?'].map((text) =>
        record(text, 1, { category: 'question' }),
      ),
      ...Array.from({ length: 4 }, (_, i) => record('nice dodge', 2, { at: minuteAgo(2) + i })),
      record('next stream is saturday 9pm', 1, { category: 'important', author: 'mod_fixture' }),
    ];
    const input = summaryInput(records, NOW, 5);
    const asked = input.questions.map((q) => q.text);
    const ids = [
      asked.indexOf('訳:how long is phase 2?') + 1,
      asked.indexOf('訳:is phase 2 long?') + 1,
    ];
    const burst = input.peaks.findIndex((texts) => texts.length > 0) + 1;
    const server = fakeServer(`T ボス戦\nQ ${ids.join(',')} 第2形態の長さ\nP${burst} 見事な回避\n`);
    const made = await summarize(
      server.model,
      () => records,
      5,
      () => NOW,
      slotOne,
    );
    expect(made.ok).toBe(true);
    const summary = made.ok ? made.value : undefined;
    expect(summary?.topics).toEqual(['ボス戦']);
    // 3 + 2 merged comments; the question the model left alone keeps its own count.
    expect(summary?.questions).toEqual([
      { text: '第2形態の長さ', count: 5 },
      { text: '訳:what weapon?', count: 1 },
    ]);
    expect(summary?.peaks.find((peak) => peak.minute === minuteAgo(2))).toEqual({
      minute: minuteAgo(2),
      count: 5,
      label: '見事な回避',
    });
    expect(summary?.important).toEqual([
      { author: 'mod_fixture', text: '訳:next stream is saturday 9pm', at: NOW - MINUTE },
    ]);
    expect(server.bodies).toHaveLength(1);
    expect(server.bodies[0]).toMatchObject({ id_slot: 1, max_tokens: 256, model: 'gemma4-e4b' });
    expect(server.bodies[0]?.grammar.startsWith('root ::= topic{1,4} question{0,5}')).toBe(true);
  });

  it.each([
    { name: 'is down', reply: undefined },
    { name: 'answers outside the grammar', reply: 'Sure! Here is a summary.\n' },
  ] as const)('returns the counted parts when the model $name', async ({ reply }) => {
    const records = [
      record('when is the next stream?', 2, { category: 'question' }),
      record('when is the next stream?', 1, { category: 'question' }),
      record('hello', 1, { lang: 'und-Latn' }),
      japanese('こんにちは', 1),
      japanese('こんばんは', 1),
      record('schedule: saturday', 1, { category: 'important', author: 'mod_fixture' }),
    ];
    const made = await summarize(
      fakeServer(reply).model,
      () => records,
      5,
      () => NOW,
      slotOne,
    );
    expect(made).toEqual({
      ok: true,
      value: {
        windowMinutes: 5,
        total: 6,
        languages: ['en', 'ja', 'und-Latn'],
        from: NOW - 2 * MINUTE,
        generatedAt: NOW,
        topics: [],
        questions: [{ text: '訳:when is the next stream?', count: 2 }],
        peaks: [
          { minute: minuteAgo(2), count: 1 },
          { minute: minuteAgo(1), count: 5 },
        ],
        important: [{ author: 'mod_fixture', text: '訳:schedule: saturday', at: NOW - MINUTE }],
        unprocessed: 0,
        modelFailed: true,
      },
    });
  });

  it('answers with the counted parts alone, not as a failure, when the slot was given up', async () => {
    const server = fakeServer('T 話題\n');
    const records = [record('when?', 1, { category: 'question' }), record('hello', 1)];
    const cancelled = new AbortController();
    cancelled.abort();
    const superseded: SlotRunner = (fn) => fn(1, cancelled.signal);
    const made = await summarize(
      server.model,
      () => records,
      5,
      () => NOW,
      superseded,
    );
    expect(made).toMatchObject({ ok: true, value: { total: 2, topics: [] } });
    expect(made.ok && made.value.modelFailed).toBeUndefined();
    expect(server.bodies).toHaveLength(0);
  });

  it('reads the comments again when the slot is given, so the model sees what came meanwhile', async () => {
    const server = fakeServer('T 話題\n');
    const records = [record('first comment', 2)];
    let now = NOW - MINUTE;
    const late: SlotRunner = (fn) => {
      records.push(record('arrived while waiting', 0.5));
      now = NOW;
      return fn(1, new AbortController().signal);
    };
    const made = await summarize(
      server.model,
      () => records,
      5,
      () => now,
      late,
    );
    expect(made).toMatchObject({
      ok: true,
      value: { total: 2, generatedAt: NOW, topics: ['話題'] },
    });
    expect(server.bodies[0]?.messages[1]?.content).toContain('arrived while waiting');
  });

  it('does not call the model when there is nothing to summarize', async () => {
    const server = fakeServer('T 話題\n');
    const records = [
      record('rude', 1, { category: 'abusive' }),
      record('🔥', 1, { lang: 'und', state: 'skipped', translation: undefined }),
    ];
    let asked = 0;
    const counting: SlotRunner = (fn) => {
      asked += 1;
      return fn(1, new AbortController().signal);
    };
    const made = await summarize(
      server.model,
      () => records,
      5,
      () => NOW,
      counting,
    );
    expect(made).toMatchObject({ ok: true, value: { total: 2, topics: [], questions: [] } });
    expect(asked).toBe(0);
    expect(server.bodies).toHaveLength(0);
    const empty: Result<unknown> = await summarize(
      server.model,
      () => [],
      30,
      () => NOW,
      counting,
    );
    expect(empty).toMatchObject({
      ok: true,
      value: { total: 0, languages: [], peaks: [], important: [], from: NOW - 30 * MINUTE },
    });
  });

  it('lists important comments newest first, each text once, at most five', async () => {
    const records = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((letter, i) =>
        record(`notice ${letter}`, 6 - i, { category: 'important', author: `mod_${letter}` }),
      ),
      record('NOTICE  F', 0.5, { category: 'important', author: 'mod_copy' }),
    ];
    const made = await summarize(
      fakeServer().model,
      () => records,
      15,
      () => NOW,
      slotOne,
    );
    expect(made.ok && made.value.important.map((item) => item.author)).toEqual([
      'mod_copy',
      'mod_e',
      'mod_d',
      'mod_c',
      'mod_b',
    ]);
  });
});

describe('summary cost (R45)', () => {
  /** 5,000 comments of 5 busy minutes: chat, questions and notices, many texts repeated. */
  const busy = (): CommentRecord[] =>
    Array.from({ length: 5000 }, (_unused, i) => {
      const minutesAgo = (i % 300) / 60;
      if (i % 10 === 0)
        return record(`which stage is next ${i % 37}?`, minutesAgo, { category: 'question' });
      if (i % 97 === 0)
        return record(`notice number ${i % 7}`, minutesAgo, { category: 'important' });
      if (i % 3 === 0) return japanese(`今のは上手い ${i % 211}`, minutesAgo);
      return record(`that dodge was clean ${i % 503} WOOOOO`, minutesAgo);
    });

  it('normalizes each comment once per request, also when the model is asked', async () => {
    const records = busy();
    vi.mocked(normalizeComment).mockClear();
    const made = await summarize(
      fakeServer('T 話題\n').model,
      () => records,
      5,
      () => NOW,
      slotOne,
    );
    expect(made).toMatchObject({ ok: true, value: { total: 5000, topics: ['話題'] } });
    expect(vi.mocked(normalizeComment).mock.calls.length).toBeLessThanOrEqual(records.length);
  });

  it('takes under 3 times one normalization of every comment, on 5,000 comments', async () => {
    const records = busy();
    const model = fakeServer('T 話題\n').model;
    // The floor: every comment's text normalized once, in one pass.
    const pass = (): number => {
      const start = performance.now();
      for (const item of records) normalizeComment(item.translation ?? item.text);
      return performance.now() - start;
    };
    const summary = async (): Promise<number> => {
      const start = performance.now();
      await summarize(
        model,
        () => records,
        5,
        () => NOW,
        slotOne,
      );
      return performance.now() - start;
    };
    // The fastest of interleaved runs, after one of each to warm up.
    await summary();
    pass();
    let floor = Infinity;
    let made = Infinity;
    for (let run = 0; run < 5; run += 1) {
      floor = Math.min(floor, pass());
      made = Math.min(made, await summary());
    }
    // 4.2 times before R45 (3 normalizations a comment, the parts worked out twice), 1.6 now.
    expect(made / floor).toBeLessThan(3);
  });
});

describe('summary before and after R45', () => {
  it('gives the input lines and summaries of ca380e6 on a varied chat, in every window and model outcome', async () => {
    // Made with the code of ca380e6 from the same records (summary-fixture.ts).
    const expected: unknown = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '../fixtures/summary-ca380e6.json'), 'utf8'),
    );
    const records = variedRecords();
    const cancelled = new AbortController();
    cancelled.abort();
    const givenUp: SlotRunner = (fn) => fn(1, cancelled.signal);
    const made: Record<string, unknown> = {};
    for (const windowMinutes of [5, 15, 30] as const) {
      const run = (reply: string | undefined, slot: SlotRunner) =>
        summarize(
          fakeServer(reply).model,
          () => records,
          windowMinutes,
          () => SUMMARY_NOW,
          slot,
        );
      made[windowMinutes] = {
        input: summaryInput(records, SUMMARY_NOW, windowMinutes),
        answered: await run(SUMMARY_REPLY, slotOne),
        failed: await run(undefined, slotOne),
        givenUp: await run(SUMMARY_REPLY, givenUp),
      };
    }
    // Every outcome occurs: the model's topics, a failed model and a slot given up.
    expect(made).toMatchObject({
      5: {
        answered: { value: { topics: ['ボス戦の話', '次の配信'] } },
        failed: { value: { modelFailed: true } },
        givenUp: { value: { topics: [] } },
      },
    });
    expect(JSON.parse(JSON.stringify(made))).toEqual(expected);
  });
});
