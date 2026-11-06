import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLlamaClient,
  createQueue,
  PAGE_PLAMO_MAX_TOKENS,
  PLAMO_STOP,
  PLAMO_TRANSLATE_MODEL,
  pageTokensValid,
  pageUnitSource,
} from '@chrome-toolbox/extension-core';
import { fromRoot } from './paths.ts';
import {
  FIRST_SCREEN_UNITS,
  loadPageUnits,
  packBatches,
  runPageBench,
  type PageUnitSample,
} from './page.ts';

const FIXTURE = fromRoot('packages/bench/fixtures/page/units.jsonl');

type Sent = {
  model?: string;
  messages: { role: string; content: string }[];
  grammar?: string;
  response_format?: unknown;
  chat_template_kwargs?: Record<string, unknown>;
  stop?: string[];
  id_slot?: number;
  max_tokens?: number;
  temperature?: number;
};

/**
 * A fake llama-server. `reply` makes the content of each chat answer; `advance` moves the fake
 * clock by that many ms per chat request (its argument is the request's index).
 */
function fakeServer(
  options: {
    reply?: (body: Sent) => string;
    advance?: (index: number) => number;
    totalSlots?: number;
    status?: (body: Sent) => number;
  } = {},
) {
  const sent: Sent[] = [];
  let t = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    if (url.includes('/props')) return Response.json({ total_slots: options.totalSlots ?? 3 });
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent;
    const index = sent.length;
    sent.push(body);
    t += options.advance?.(index) ?? 0;
    const status = options.status?.(body) ?? 200;
    if (status !== 200) return new Response('', { status });
    return Response.json({
      choices: [{ message: { content: options.reply?.(body) ?? '' }, finish_reason: 'stop' }],
    });
  };
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch,
    queue: createQueue({ concurrency: 2 }),
  });
  return { client, sent, now: () => t };
}

/** A Gemma reply that writes each segment's source back: every marker stays, so every unit reads. */
const echoBatch = (body: Sent): string => {
  const user = body.messages.at(-1)?.content ?? '';
  const lines = user.split('Segments (one JSON object per line):\n')[1]?.split('\n') ?? [];
  return lines
    .map((line) => {
      const { id, text } = JSON.parse(line) as { id: number; text: string };
      return `${id}\t${text}\n`;
    })
    .join('');
};
const echoLine = (body: Sent): string => body.messages.at(-1)?.content ?? '';
const stripMarkers = (text: string): string => text.replace(/<\/?\d+>|<k\d+\/>/gu, '');
const isGemma = (body: Sent): boolean => body.model === 'gemma-x';

const text = (value: string, id: string, lang = 'en', kind = 'paragraph'): PageUnitSample => ({
  id,
  lang,
  kind: kind as PageUnitSample['kind'],
  tokens: [{ t: 'text', text: value }],
});

describe('page fixtures', () => {
  const units = loadPageUnits(FIXTURE);

  it('hold 40 valid units: 24 English and 4 of each other language', () => {
    expect(units).toHaveLength(40);
    expect(new Set(units.map((unit) => unit.id)).size).toBe(40);
    expect(units.filter((unit) => !pageTokensValid(unit.tokens))).toEqual([]);
    const count = (key: (unit: PageUnitSample) => string): Record<string, number> => {
      const table: Record<string, number> = {};
      for (const unit of units) table[key(unit)] = (table[key(unit)] ?? 0) + 1;
      return table;
    };
    expect(count((unit) => unit.lang)).toEqual({ en: 24, ko: 4, es: 4, zh: 4, id: 4 });
    expect(count((unit) => `${unit.lang}/${unit.kind}`)).toMatchObject({
      'en/label': 8,
      'en/paragraph': 10,
      'en/rich': 6,
    });
    for (const lang of ['ko', 'es', 'zh', 'id'])
      expect(units.filter((unit) => unit.lang === lang && unit.kind === 'rich')).toHaveLength(1);
  });

  it('have rich units with markers, and 150 to 400 characters in English paragraphs', () => {
    for (const unit of units.filter((u) => u.kind === 'rich'))
      expect(unit.tokens.some((token) => token.t === 'open' || token.t === 'keep')).toBe(true);
    for (const unit of units.filter((u) => u.lang === 'en' && u.kind === 'paragraph')) {
      const length = Array.from(pageUnitSource(unit.tokens).text).length;
      expect(length).toBeGreaterThanOrEqual(150);
      expect(length).toBeLessThanOrEqual(400);
    }
  });

  it('reject a unit that is not valid, naming the line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'page-units-'));
    const file = path.join(dir, 'units.jsonl');
    const twoTexts = [
      { t: 'text', text: 'one' },
      { t: 'text', text: 'two' },
    ];
    writeFileSync(
      file,
      `${JSON.stringify({ id: 'a', lang: 'en', kind: 'label', tokens: twoTexts })}\n`,
    );
    expect(() => loadPageUnits(file)).toThrow(/units\.jsonl:1: tokens are not a valid unit/u);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('packBatches', () => {
  it('cuts at 6 units and 800 characters, in order', () => {
    const short = Array.from({ length: 14 }, (_, i) => text('x'.repeat(10), `s${i}`));
    expect(packBatches(short).map((batch) => batch.length)).toEqual([6, 6, 2]);
    const long = Array.from({ length: 5 }, (_, i) => text('y'.repeat(300), `l${i}`));
    expect(packBatches(long).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(
      packBatches([...short, ...long])
        .flat()
        .map((unit) => unit.id),
    ).toEqual([...short, ...long].map((unit) => unit.id));
  });
});

describe('runPageBench', () => {
  const units = loadPageUnits(FIXTURE);

  it('stops before measuring when the server is not ready', async () => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => new Response('', { status: 503 }),
    });
    await expect(
      runPageBench({ gemma: client, gemmaModel: 'gemma-x', units, rounds: 1 }),
    ).rejects.toThrow(/llama-server is not ready/);
  });

  it('sends Gemma the extension batch: grammar, pinned slot, at most 6 units and 800 characters', async () => {
    const server = fakeServer({ reply: echoBatch });
    const report = await runPageBench({
      gemma: server.client,
      gemmaModel: 'gemma-x',
      units,
      rounds: 1,
      now: server.now,
    });
    const main = server.sent.slice(0, packBatches(units).length);
    for (const body of main) {
      expect(body.model).toBe('gemma-x');
      expect(body.messages[0]?.role).toBe('system');
      expect(body.grammar).toContain('root ::=');
      expect(body.temperature).toBe(0);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.id_slot).toBe(2);
      expect(body.response_format).toBeUndefined();
    }
    const gemmaRows = report.rows.filter((row) => row.model === 'gemma');
    expect(gemmaRows).toHaveLength(40);
    expect(gemmaRows.every((row) => row.pieces !== undefined && row.error === undefined)).toBe(
      true,
    );
    expect(report.gemma).toMatchObject({
      attempts: 40,
      successes: 40,
      richAttempts: 10,
      richKept: 10,
    });
    expect(report.plamo).toBeUndefined();
  });

  it('sends PLaMo one unit at a time with the template variables only, on slot 1 or 2', async () => {
    const server = fakeServer({ reply: echoLine });
    await runPageBench({
      gemma: server.client,
      plamo: server.client,
      gemmaModel: 'gemma-x',
      units,
      rounds: 1,
      now: server.now,
    });
    const plamo = server.sent.filter((body) => body.model === PLAMO_TRANSLATE_MODEL);
    expect(plamo.length).toBeGreaterThanOrEqual(40);
    for (const body of plamo) {
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe('user');
      expect(body).not.toHaveProperty('grammar');
      expect(body).not.toHaveProperty('response_format');
      expect(body.chat_template_kwargs).toMatchObject({ target_lang: 'ja' });
      expect(body.chat_template_kwargs).not.toHaveProperty('source_lang');
      expect(body.chat_template_kwargs).not.toHaveProperty('glossary');
      expect(body.stop).toEqual([...PLAMO_STOP]);
      expect([1, 2]).toContain(body.id_slot);
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBeLessThanOrEqual(PAGE_PLAMO_MAX_TOKENS);
    }
    const first = plamo.find(
      (body) => body.messages[0]?.content === pageUnitSource(units[0]?.tokens ?? []).text,
    );
    expect(first?.chat_template_kwargs?.context).toBe('Page: Emberfall Wiki');
    const third = plamo.find(
      (body) => body.messages[0]?.content === pageUnitSource(units[2]?.tokens ?? []).text,
    );
    expect(third?.chat_template_kwargs?.context).toBe(
      [
        'Page: Emberfall Wiki',
        pageUnitSource(units[0]?.tokens ?? []).text,
        pageUnitSource(units[1]?.tokens ?? []).text,
      ].join('\n'),
    );
  });

  it('replaces only the model when --plamo names another one', async () => {
    const server = fakeServer({ reply: echoLine });
    await runPageBench({
      gemma: server.client,
      plamo: server.client,
      gemmaModel: 'gemma-x',
      plamoModel: 'plamo-other',
      units: units.slice(0, 2),
      rounds: 1,
    });
    expect(server.sent.filter((body) => body.model === 'plamo-other').length).toBeGreaterThan(0);
    expect(server.sent.some((body) => body.model === PLAMO_TRANSLATE_MODEL)).toBe(false);
  });

  it('times the first screen: its 12 units in document order, p50 of the rounds', async () => {
    const first = units.slice(0, FIRST_SCREEN_UNITS);
    const batches = packBatches(first).length;
    const main = packBatches(units).length;
    const delays = [100, 300, 200];
    const server = fakeServer({
      reply: echoBatch,
      advance: (index) => (index < main ? 1 : (delays[Math.floor((index - main) / batches)] ?? 0)),
    });
    const report = await runPageBench({
      gemma: server.client,
      gemmaModel: 'gemma-x',
      units,
      rounds: 3,
      now: server.now,
    });
    expect(FIRST_SCREEN_UNITS).toBe(12);
    expect(report.firstScreen.gemmaMs).toEqual(delays.map((delay) => delay * batches));
    expect(report.firstScreen.gemmaP50Ms).toBe(200 * batches);
    expect(server.sent).toHaveLength(main + 3 * batches);
    expect(report.firstScreen.plamoMs).toBeUndefined();
  });

  it('counts a unit PLaMo wrote without its markers as a failure, and the markers it kept', async () => {
    const server = fakeServer({
      reply: (body) => (isGemma(body) ? echoBatch(body) : stripMarkers(echoLine(body))),
    });
    const report = await runPageBench({
      gemma: server.client,
      plamo: server.client,
      gemmaModel: 'gemma-x',
      units,
      rounds: 1,
      now: server.now,
    });
    expect(report.plamo).toMatchObject({
      attempts: 40,
      successes: 30,
      richAttempts: 10,
      richKept: 0,
      failures: { response_invalid: 10 },
    });
    expect(report.gemma).toMatchObject({ richKept: 10 });
    const failed = report.rows.filter((row) => row.model === 'plamo' && row.error !== undefined);
    expect(failed.every((row) => row.kind === 'rich')).toBe(true);
  });

  it('fails an invalid unit alone, without sending it, and counts an HTTP error', async () => {
    const bad: PageUnitSample = {
      id: 'bad',
      lang: 'en',
      kind: 'rich',
      tokens: [
        { t: 'text', text: 'one' },
        { t: 'text', text: 'two' },
      ],
    };
    const ok = text('Boss guide', 'ok', 'en', 'label');
    const refused = text('Refused label', 'refused', 'en', 'label');
    const server = fakeServer({
      reply: (body) => (isGemma(body) ? echoBatch(body) : echoLine(body)),
      status: (body) => (body.messages.at(-1)?.content === 'Refused label' ? 500 : 200),
    });
    const report = await runPageBench({
      gemma: server.client,
      plamo: server.client,
      gemmaModel: 'gemma-x',
      units: [bad, ok, refused],
      rounds: 1,
    });
    const contents = server.sent.flatMap((body) => body.messages.map((message) => message.content));
    expect(
      contents.some((content) => content.includes('"one"') || content.includes('onetwo')),
    ).toBe(false);
    expect(report.gemma.failures).toEqual({ tokens_invalid: 1 });
    expect(report.gemma).toMatchObject({ attempts: 3, successes: 2 });
    expect(report.plamo?.failures).toEqual({ tokens_invalid: 1, model_refused: 1 });
    expect(report.rows.find((row) => row.model === 'gemma' && row.id === 'ok')?.pieces).toEqual([
      'Boss guide',
    ]);
  });
});
