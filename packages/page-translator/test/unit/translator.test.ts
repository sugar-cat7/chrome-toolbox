import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok } from '@chrome-toolbox/contracts';
import {
  defaultSettings,
  PAGE_PLAMO_MAX_TOKENS,
  pageBatchMaxTokens,
  PLAMO_STOP,
  PLAMO_TRANSLATE_MODEL,
  settingsStore,
  type PageToken,
} from '@chrome-toolbox/extension-core';
import {
  chatCompletion,
  STUB_PAGE_PREFIX,
  STUB_PLAMO_PREFIX,
  type StubChat,
  type StubReply,
} from '@chrome-toolbox/extension-core/testing';
import type { TranslateReply, TranslateRequest } from '../../src/protocol.ts';
import { defaultPageSettings, pageSettingsStore } from '../../src/settings.ts';
import {
  createPageTranslator,
  PAGE_TIMEOUT_MS,
  PLAMO_TAKES_RICH,
  slotPlan,
  type PageTranslator,
} from '../../src/translator.ts';
import { gate, isRecord, llama, pause, type Server } from './llama.ts';

const GEMMA = defaultSettings.models.translate;
const PLAMO = PLAMO_TRANSLATE_MODEL;

const created: PageTranslator[] = [];
afterEach(() => {
  for (const translator of created.splice(0)) translator.dispose();
  fakeBrowser.reset();
});

async function translatorFor(
  server: Server,
  { translator = 'gemma', timeoutMs }: { translator?: 'gemma' | 'plamo'; timeoutMs?: number } = {},
): Promise<PageTranslator> {
  const area = fakeBrowser.storage.local;
  expect(await pageSettingsStore(area).save({ ...defaultPageSettings, translator })).toMatchObject({
    ok: true,
  });
  const made = createPageTranslator({
    fetch: server.fetch,
    settings: settingsStore(area),
    pageSettings: pageSettingsStore(area),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  created.push(made);
  return made;
}

const plain = (text: string): PageToken[] => [{ t: 'text', text }];
/** `Roll <1>backward</1> to dodge.`: a link in a sentence. */
const rich: PageToken[] = [
  { t: 'text', text: 'Roll' },
  { t: 'space' },
  { t: 'open', n: 1 },
  { t: 'text', text: 'backward' },
  { t: 'close', n: 1 },
  { t: 'space' },
  { t: 'text', text: 'to dodge.' },
];
/** A link that never closes: no page unit (`pageTokensValid`). */
const unclosed: PageToken[] = [
  { t: 'open', n: 1 },
  { t: 'text', text: 'Final Boss Guide' },
];
const cancelled = { ok: false, error: { internalCode: 'operation_cancelled' } };
const RICH_PIECES = [
  `${STUB_PAGE_PREFIX}Roll`,
  `${STUB_PAGE_PREFIX}backward`,
  `${STUB_PAGE_PREFIX} to dodge.`,
];
function request(
  units: readonly (string | PageToken[])[],
  {
    purpose = 'page',
    title = 'Fixture Wiki',
  }: { purpose?: 'page' | 'selection'; title?: string } = {},
): TranslateRequest {
  return {
    purpose,
    units: units.map((unit, i) => ({
      id: i + 1,
      tokens: typeof unit === 'string' ? plain(unit) : unit,
    })),
    page: { title, site: 'wiki.fixture.test' },
  };
}
const gemmaPieces = (text: string): string[] => [`${STUB_PAGE_PREFIX}${text}`];
const plamoPieces = (text: string): string[] => [`${STUB_PLAMO_PREFIX}${text}`];
/** The texts of the segments of a page batch, from its user turn. */
function batchTexts(chat: StubChat): string[] {
  const user = chat.messages.find((message) => message.role === 'user')?.content ?? '';
  return user
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line): unknown => JSON.parse(line))
    .flatMap((segment) =>
      isRecord(segment) && typeof segment['text'] === 'string' ? [segment['text']] : [],
    );
}
const lineOf = (chat: StubChat): string => chat.messages[0]?.content ?? '';
/** `texts` sorted: units sent at once may go out in any order. */
const sorted = (texts: readonly string[]): string[] =>
  [...texts].sort((a, b) => a.localeCompare(b));

describe('slots', () => {
  it.each([
    { total: undefined, plan: undefined },
    { total: 0, plan: undefined },
    // Slot 0 is the subtitles': a server with one slot has none for pages.
    { total: 1, plan: undefined },
    { total: 2, plan: { gemma: 1, plamo: [1] } },
    { total: 3, plan: { gemma: 2, plamo: [1, 2] } },
    { total: 4, plan: { gemma: 3, plamo: [1, 2] } },
  ])('slotPlan($total)', ({ total, plan }) => {
    expect(slotPlan(total)).toEqual(plan);
  });
});

describe('Gemma', () => {
  it('sends one Gemma batch with grammar, model and the last slot', async () => {
    const server = llama();
    const translator = await translatorFor(server);
    const units = ['Final Boss Guide', rich, 'Phase two starts at half health.'];
    const reply = await translator.translate(1, request(units));
    expect(reply).toEqual(
      Ok({
        results: [
          { id: 1, pieces: gemmaPieces('Final Boss Guide') },
          { id: 2, pieces: RICH_PIECES },
          { id: 3, pieces: gemmaPieces('Phase two starts at half health.') },
        ],
        translator: 'gemma',
      } satisfies TranslateReply),
    );
    // Gemma's slot count only; no model list while Gemma is chosen.
    expect(server.asked()).toEqual([`/props?${GEMMA}`]);
    const [chat, ...more] = server.chats(GEMMA);
    expect(more).toEqual([]);
    expect(chat).toMatchObject({
      model: GEMMA,
      id_slot: 2,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: pageBatchMaxTokens([
        plain('Final Boss Guide'),
        rich,
        plain('Phase two starts at half health.'),
      ]),
    });
    expect(chat?.grammar).toContain('line3 ::= "3\\t"');
    expect(chat?.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(chat?.messages[1]?.content).toContain(
      '"title":"Fixture Wiki","site":"wiki.fixture.test"',
    );
    expect(chat?.stop).toBeUndefined();

    // The slot count is asked once per model.
    await translator.translate(1, request(['Roll backward to dodge.']));
    expect(server.asked()).toEqual([`/props?${GEMMA}`]);
    expect(server.chats(GEMMA)[1]?.id_slot).toBe(2);
  });

  it('never sends a Gemma batch without a slot: it asks again on the next request', async () => {
    const server = llama({ state: { slots: { [GEMMA]: 'down' } } });
    const translator = await translatorFor(server);
    expect(await translator.translate(1, request(['Final Boss Guide']))).toMatchObject({
      ok: false,
      error: { internalCode: 'network_failed' },
    });
    expect(server.chats(GEMMA)).toEqual([]);

    // One slot is the subtitles' slot 0: nothing for pages either.
    server.state.slots[GEMMA] = 1;
    expect(await translator.translate(1, request(['Final Boss Guide']))).toMatchObject({
      ok: false,
      error: { internalCode: 'model_refused' },
    });
    expect(server.chats(GEMMA)).toEqual([]);

    server.state.slots[GEMMA] = 2;
    expect(await translator.translate(1, request(['Final Boss Guide']))).toMatchObject({
      ok: true,
    });
    expect(server.asked()).toEqual([`/props?${GEMMA}`, `/props?${GEMMA}`, `/props?${GEMMA}`]);
    expect(server.chats(GEMMA).map((chat) => chat.id_slot)).toEqual([1]);
  });

  it('asks a model for its slots once while several requests wait for the answer', async () => {
    const props = gate();
    const server = llama({ propsDoor: () => props.promise });
    const translator = await translatorFor(server);
    const first = translator.translate(1, request(['Final Boss Guide']));
    const second = translator.translate(2, request(['Roll backward.']));
    const third = translator.translate(3, request(['Phase two.']));
    await vi.waitFor(() => expect(server.asked()).toEqual([`/props?${GEMMA}`]));
    // A cancelled request stops waiting at once; the shared question goes on for the others.
    translator.cancel(3);
    expect(await third).toMatchObject(cancelled);
    expect(server.calls[0]?.signal?.aborted).toBe(false);
    props.open();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(server.asked()).toEqual([`/props?${GEMMA}`]);
    expect(server.chats(GEMMA).map((chat) => chat.id_slot)).toEqual([2, 2]);
  });

  it('asks again after a shared slot question failed', async () => {
    const server = llama({ state: { slots: { [GEMMA]: 'down' } } });
    const translator = await translatorFor(server);
    const failed = { ok: false, error: { internalCode: 'network_failed' } };
    expect(
      await Promise.all([
        translator.translate(1, request(['Final Boss Guide'])),
        translator.translate(2, request(['Roll backward.'])),
      ]),
    ).toMatchObject([failed, failed]);
    expect(server.asked()).toEqual([`/props?${GEMMA}`]);
    server.state.slots[GEMMA] = 3;
    expect(await translator.translate(1, request(['Final Boss Guide']))).toMatchObject({
      ok: true,
    });
    expect(server.asked()).toEqual([`/props?${GEMMA}`, `/props?${GEMMA}`]);
  });

  it('runs one Gemma batch at a time, across tabs and purposes', async () => {
    const server = llama({ door: pause });
    const translator = await translatorFor(server);
    const replies = await Promise.all([
      translator.translate(1, request(['Final Boss Guide'])),
      translator.translate(2, request(['Final Boss Guide'])),
      translator.translate(1, request(['Roll backward to dodge.'], { purpose: 'selection' })),
    ]);
    expect(replies.map((reply) => reply.ok)).toEqual([true, true, true]);
    expect(server.peak(GEMMA)).toBe(1);
  });

  it.each([
    {
      name: 'an HTTP error (no refusal for Gemma: it is sent again)',
      respond: (): StubReply => ({ status: 503, body: { error: { code: 503 } } }),
      code: 'network_failed',
    },
    {
      name: 'a body that is no chat completion',
      respond: (): StubReply => ({ body: { choices: [] } }),
      code: 'response_invalid',
    },
  ])('fails the whole request on $name', async ({ respond, code }) => {
    const server = llama({ respond });
    const translator = await translatorFor(server);
    expect(await translator.translate(1, request(['Final Boss Guide', rich]))).toMatchObject({
      ok: false,
      error: { internalCode: code },
    });
  });

  it('times a Gemma batch out after the timeout', async () => {
    expect(PAGE_TIMEOUT_MS).toBe(30_000);
    const held = gate();
    const server = llama({ door: () => held.promise });
    const translator = await translatorFor(server, { timeoutMs: 20 });
    expect(await translator.translate(1, request(['Final Boss Guide']))).toMatchObject({
      ok: false,
      error: { internalCode: 'network_failed' },
    });
    held.open();
  });

  it('fails alone a unit whose line does not read back (P21)', async () => {
    const server = llama({
      respond: (chat) =>
        chat.model === GEMMA
          ? chatCompletion(
              `1\t${STUB_PAGE_PREFIX}Final Boss Guide\n2\t${STUB_PAGE_PREFIX}Roll backward\n`,
            )
          : undefined,
    });
    const translator = await translatorFor(server);
    // Unit 2 lost its link, and unit 3 has no line.
    const reply = await translator.translate(
      1,
      request(['Final Boss Guide', rich, 'Roll backward.']),
    );
    expect(reply).toEqual(
      Ok({
        results: [{ id: 1, pieces: gemmaPieces('Final Boss Guide') }, { id: 2 }, { id: 3 }],
        translator: 'gemma',
      }),
    );
  });

  it('fails only the units with invalid tokens and sends the rest (P21)', async () => {
    const server = llama();
    const translator = await translatorFor(server);
    const adjacent: PageToken[] = [
      { t: 'text', text: 'Final' },
      { t: 'text', text: 'Boss' },
    ];
    const reply = await translator.translate(
      1,
      request(['Final Boss Guide', unclosed, 'Phase two starts at half health.', adjacent]),
    );
    expect(reply).toEqual(
      Ok({
        results: [
          { id: 1, pieces: gemmaPieces('Final Boss Guide') },
          { id: 2 },
          { id: 3, pieces: gemmaPieces('Phase two starts at half health.') },
          { id: 4 },
        ],
        translator: 'gemma',
      }),
    );
    expect(server.chats(GEMMA).map(batchTexts)).toEqual([
      ['Final Boss Guide', 'Phase two starts at half health.'],
    ]);

    // No valid unit at all: nothing goes to the server.
    expect(await translator.translate(1, request([unclosed]))).toEqual(
      Ok({ results: [{ id: 1 }], translator: 'gemma' }),
    );
    expect(server.chats(GEMMA)).toHaveLength(1);
  });
});

describe('PLaMo', () => {
  it('sends plain units to PLaMo one by one on slots 1 and 2', async () => {
    const server = llama({ door: pause });
    const translator = await translatorFor(server, { translator: 'plamo' });
    const texts = [
      'Final Boss Guide',
      'Phase two starts at half health.',
      'Roll backward to dodge.',
    ];
    const reply = await translator.translate(1, request(texts));
    expect(reply).toEqual(
      Ok({
        results: texts.map((text, i) => ({ id: i + 1, pieces: plamoPieces(text) })),
        translator: 'plamo',
      }),
    );
    expect(server.asked()).toEqual(['/v1/models', `/props?${PLAMO}`]);
    const chats = server.chats(PLAMO);
    expect(sorted(chats.map(lineOf))).toEqual(sorted(texts));
    expect(new Set(chats.map((chat) => chat.id_slot))).toEqual(new Set([1, 2]));
    expect(server.peak(PLAMO)).toBe(2);
    for (const chat of chats) {
      expect(chat.model).toBe(PLAMO);
      expect(chat.stop).toEqual(PLAMO_STOP);
      expect(chat.temperature).toBe(0);
      expect(chat.messages.map((message) => message.role)).toEqual(['user']);
      expect(chat.grammar).toBeUndefined();
      expect(chat.response_format).toBeUndefined();
      expect(chat.chat_template_kwargs).toMatchObject({ target_lang: 'ja' });
      expect(Object.keys(chat.chat_template_kwargs ?? {})).not.toContain('source_lang');
      expect(Object.keys(chat.chat_template_kwargs ?? {})).not.toContain('glossary');
      expect(chat.max_tokens).toBeLessThanOrEqual(PAGE_PLAMO_MAX_TOKENS);
    }
    // No Gemma batch: PLaMo translated every unit.
    expect(server.chats(GEMMA)).toEqual([]);
  });

  it('sends PLaMo units one at a time on slot 1 of a server with 2 slots', async () => {
    const server = llama({ state: { slots: { [PLAMO]: 2 } }, door: pause });
    const translator = await translatorFor(server, { translator: 'plamo' });
    const reply = await translator.translate(
      1,
      request(['Final Boss Guide', 'Roll backward.', 'Dodge.']),
    );
    expect(reply).toMatchObject({ ok: true, value: { translator: 'plamo' } });
    expect(server.chats(PLAMO).map((chat) => chat.id_slot)).toEqual([1, 1, 1]);
    expect(server.peak(PLAMO)).toBe(1);
  });

  it.each([
    { name: 'its slot count is unknown', slots: 'down' as const },
    { name: 'it has only slot 0', slots: 1 },
  ])('sends PLaMo units to Gemma while $name, and asks again next time', async ({ slots }) => {
    const server = llama({ state: { slots: { [PLAMO]: slots } } });
    const translator = await translatorFor(server, { translator: 'plamo' });
    const reply = await translator.translate(1, request(['Final Boss Guide', 'Roll backward.']));
    expect(reply).toEqual(
      Ok({
        results: [
          { id: 1, pieces: gemmaPieces('Final Boss Guide') },
          { id: 2, pieces: gemmaPieces('Roll backward.') },
        ],
        // PLaMo translated nothing.
        translator: 'gemma',
      }),
    );
    expect(server.chats(PLAMO)).toEqual([]);
    expect(server.chats(GEMMA).map(batchTexts)).toEqual([['Final Boss Guide', 'Roll backward.']]);

    server.state.slots[PLAMO] = 3;
    await translator.translate(1, request(['Final Boss Guide']));
    expect(server.asked()).toEqual([
      '/v1/models',
      `/props?${PLAMO}`,
      `/props?${GEMMA}`,
      `/props?${PLAMO}`,
    ]);
    expect(server.chats(PLAMO).map(lineOf)).toEqual(['Final Boss Guide']);
  });

  it.each([
    { name: 'every unit came from PLaMo', units: ['Final Boss Guide'], translator: 'plamo' },
    {
      name: 'PLaMo translated plain and rich units',
      units: ['Final Boss Guide', rich],
      translator: 'plamo',
    },
    { name: 'every unit was rich', units: [rich], translator: 'gemma' },
    { name: 'PLaMo refused every unit', units: ['Refused line.'], translator: 'gemma' },
    { name: 'no unit was valid', units: [unclosed], translator: 'gemma' },
  ])('reports PLaMo only when it translated a unit: $name', async ({ units, translator: by }) => {
    const server = llama({
      respond: (chat) =>
        chat.model === PLAMO && lineOf(chat) === 'Refused line.'
          ? { status: 503, body: { error: { code: 503 } } }
          : undefined,
    });
    const translator = await translatorFor(server, { translator: 'plamo' });
    expect(await translator.translate(1, request(units))).toMatchObject({
      ok: true,
      value: { translator: by },
    });
  });

  it('gives PLaMo the page title and the two units before it as context', async () => {
    const server = llama();
    const translator = await translatorFor(server, { translator: 'plamo' });
    const texts = [
      'Final Boss Guide',
      'Phase two starts at half health.',
      'Roll backward to dodge.',
    ];
    await translator.translate(1, request(texts));
    const context = (line: string): unknown =>
      server.chats(PLAMO).find((chat) => lineOf(chat) === line)?.chat_template_kwargs?.['context'];
    expect(context('Final Boss Guide')).toBe('Page: Fixture Wiki');
    expect(context('Phase two starts at half health.')).toBe(
      'Page: Fixture Wiki\nFinal Boss Guide',
    );
    expect(context('Roll backward to dodge.')).toBe(
      'Page: Fixture Wiki\nFinal Boss Guide\nPhase two starts at half health.',
    );

    // Without a title there is no page line; the first unit then has no context at all.
    await translator.translate(1, request(['Lore', 'Items', 'Maps', 'Tips'], { title: '' }));
    expect(
      server.chats(PLAMO).find((chat) => lineOf(chat) === 'Lore')?.chat_template_kwargs,
    ).not.toHaveProperty('context');
    expect(context('Tips')).toBe('Items\nMaps');
  });

  it('keeps rich units on Gemma while PLAMO_TAKES_RICH is false', async () => {
    expect(PLAMO_TAKES_RICH).toBe(false);
    const server = llama();
    const translator = await translatorFor(server, { translator: 'plamo' });
    const reply = await translator.translate(1, request(['Final Boss Guide', rich]));
    expect(reply).toEqual(
      Ok({
        results: [
          { id: 1, pieces: plamoPieces('Final Boss Guide') },
          { id: 2, pieces: RICH_PIECES },
        ],
        translator: 'plamo',
      }),
    );
    // PLaMo sees only the plain unit; the rich unit's markers never leave for it.
    expect(server.chats(PLAMO).map(lineOf)).toEqual(['Final Boss Guide']);
    expect(server.chats(GEMMA).map(batchTexts)).toEqual([['Roll <1>backward</1> to dodge.']]);
  });

  it('translates a rich unit with Gemma while PLaMo is selected', async () => {
    const server = llama({
      respond: (chat) =>
        chat.model === PLAMO && lineOf(chat).includes('<1>')
          ? // The markers are gone: the unit does not read back (P21).
            chatCompletion(`${STUB_PLAMO_PREFIX}Roll backward to dodge.`)
          : undefined,
    });
    const translator = await translatorFor(server, { translator: 'plamo' });
    const reply = await translator.translate(1, request(['Final Boss Guide', rich]));
    expect(reply).toEqual(
      Ok({
        results: [
          { id: 1, pieces: plamoPieces('Final Boss Guide') },
          { id: 2, pieces: RICH_PIECES },
        ],
        translator: 'plamo',
      }),
    );
    // With PLAMO_TAKES_RICH false the rich unit never reaches PLaMo; Gemma translates it in
    // the same batch shape the fallback would have used.
    expect(server.chats(PLAMO).map(lineOf)).toEqual(['Final Boss Guide']);
    expect(server.chats(GEMMA).map(batchTexts)).toEqual([['Roll <1>backward</1> to dodge.']]);
  });

  it('falls back to one Gemma batch for the units PLaMo could not translate', async () => {
    const server = llama({
      respond: (chat) => {
        if (chat.model !== PLAMO) return undefined;
        // HTTP 503 is model_refused; a reply cut by max_tokens is response_invalid.
        if (lineOf(chat) === 'Refused line.')
          return { status: 503, body: { error: { code: 503 } } };
        if (lineOf(chat) === 'Cut line.')
          return {
            body: {
              choices: [
                { message: { content: `${STUB_PLAMO_PREFIX}Cut` }, finish_reason: 'length' },
              ],
            },
          };
        // Words where a plain unit has none: it does not read back.
        if (lineOf(chat) === 'Marked line.') return chatCompletion('<1>訳P:Marked</1>');
        return undefined;
      },
    });
    const translator = await translatorFor(server, { translator: 'plamo' });
    // Unit 4 is ASCII blank: plamoTranslateRequest refuses it (input_invalid), so PLaMo never
    // sees it.
    const units = ['First line.', 'Refused line.', 'Cut line.', ' ', 'Marked line.'];
    const reply = await translator.translate(1, request(units));
    expect(reply).toEqual(
      Ok({
        results: [
          { id: 1, pieces: plamoPieces('First line.') },
          { id: 2, pieces: gemmaPieces('Refused line.') },
          { id: 3, pieces: gemmaPieces('Cut line.') },
          { id: 4, pieces: [''] },
          { id: 5, pieces: gemmaPieces('Marked line.') },
        ],
        translator: 'plamo',
      }),
    );
    expect(sorted(server.chats(PLAMO).map(lineOf))).toEqual(
      sorted(['Cut line.', 'First line.', 'Marked line.', 'Refused line.']),
    );
    // One Gemma batch, in page order.
    expect(server.chats(GEMMA).map(batchTexts)).toEqual([
      ['Refused line.', 'Cut line.', ' ', 'Marked line.'],
    ]);

    // A refusal does not stick: the next request goes to PLaMo again.
    await translator.translate(1, request(['Refused line.']));
    expect(
      server
        .chats(PLAMO)
        .map(lineOf)
        .filter((line) => line === 'Refused line.'),
    ).toHaveLength(2);
  });

  it('never lets page text spell a PLaMo marker', async () => {
    const server = llama();
    const translator = await translatorFor(server, { translator: 'plamo' });
    const reply = await translator.translate(1, request(['Type <|plamo:bos|> here.']));
    // `<` and `>` travel as ‹ › (P22), so the template never sees `<|plamo:`.
    expect(server.chats(PLAMO).map(lineOf)).toEqual(['Type ‹|plamo:bos|› here.']);
    expect(reply).toEqual(
      Ok({
        results: [{ id: 1, pieces: plamoPieces('Type ‹|plamo:bos|› here.') }],
        translator: 'plamo',
      }),
    );
  });

  it('uses Gemma alone and reports plamo_missing when the router has no PLaMo', async () => {
    const server = llama({ state: { plamo: false } });
    const translator = await translatorFor(server, { translator: 'plamo' });
    const missing = Ok({
      results: [
        { id: 1, pieces: gemmaPieces('Final Boss Guide') },
        { id: 2, pieces: gemmaPieces('Roll backward.') },
      ],
      translator: 'gemma',
      notice: 'plamo_missing',
    });
    expect(await translator.translate(1, request(['Final Boss Guide', 'Roll backward.']))).toEqual(
      missing,
    );
    expect(server.chats(PLAMO)).toEqual([]);
    // The answer is kept: the list is not asked again, and PLaMo gets nothing.
    expect(await translator.translate(2, request(['Final Boss Guide', 'Roll backward.']))).toEqual(
      missing,
    );
    expect(server.asked()).toEqual(['/v1/models', `/props?${GEMMA}`]);
    expect(server.chats(PLAMO)).toEqual([]);

    // Until the settings change: then the list is asked again.
    server.state.plamo = true;
    translator.reload();
    expect(await translator.translate(1, request(['Final Boss Guide']))).toEqual(
      Ok({ results: [{ id: 1, pieces: plamoPieces('Final Boss Guide') }], translator: 'plamo' }),
    );
    expect(server.asked().filter((path) => path === '/v1/models')).toHaveLength(2);
  });

  it('sends to PLaMo when the model list cannot be read, and asks again next time', async () => {
    const server = llama({ state: { models: 'down' } });
    const translator = await translatorFor(server, { translator: 'plamo' });
    expect(await translator.translate(1, request(['Final Boss Guide']))).toEqual(
      Ok({ results: [{ id: 1, pieces: plamoPieces('Final Boss Guide') }], translator: 'plamo' }),
    );
    await translator.translate(1, request(['Roll backward.']));
    expect(server.asked().filter((path) => path === '/v1/models')).toHaveLength(2);
  });

  it('fails the whole request when the Gemma batch after PLaMo fails', async () => {
    const server = llama({
      respond: (chat) => {
        if (chat.model === GEMMA) return { status: 503, body: {} };
        // PLaMo refuses the rich unit, so it is left for the Gemma batch that fails.
        if (chat.model === PLAMO && lineOf(chat).includes('<1>'))
          return { status: 503, body: { error: { code: 503 } } };
        return undefined;
      },
    });
    const translator = await translatorFor(server, { translator: 'plamo' });
    expect(await translator.translate(1, request(['Final Boss Guide', rich]))).toMatchObject({
      ok: false,
      error: { internalCode: 'network_failed' },
    });
  });
});

describe('cancel', () => {
  it('aborts the running page request of a tab on cancel and both on tab removal', async () => {
    const held = gate();
    const server = llama({ door: () => held.promise });
    const translator = await translatorFor(server);

    const page = translator.translate(1, request(['Final Boss Guide']));
    await vi.waitFor(() => expect(server.chats(GEMMA)).toHaveLength(1));
    const selection = translator.translate(
      1,
      request(['Roll backward.'], { purpose: 'selection' }),
    );
    const other = translator.translate(2, request(['Phase two.']));
    // page/cancel stops the tab's page batch only: its selection and other tabs go on.
    translator.cancel(1, 'page');
    expect(await page).toMatchObject(cancelled);
    expect(server.calls.find((call) => call.chat !== undefined)?.signal?.aborted).toBe(true);
    held.open();
    expect(await selection).toMatchObject({ ok: true });
    expect(await other).toMatchObject({ ok: true });
    const [cancelledBatch, ...rest] = server.chats(GEMMA).map(batchTexts);
    expect(cancelledBatch).toEqual(['Final Boss Guide']);
    expect(sorted(rest.flat())).toEqual(['Phase two.', 'Roll backward.']);

    // A closed tab stops both.
    const next = gate();
    const slow = llama({ door: () => next.promise });
    const second = await translatorFor(slow);
    const both = [second.translate(1, request(['Final Boss Guide']))];
    await vi.waitFor(() => expect(slow.chats(GEMMA)).toHaveLength(1));
    both.push(second.translate(1, request(['Roll backward.'], { purpose: 'selection' })));
    second.cancel(1);
    expect(await Promise.all(both)).toMatchObject([cancelled, cancelled]);
    next.open();
    expect(slow.chats(GEMMA)).toHaveLength(1);
  });

  it('aborts the previous request of the same tab and purpose', async () => {
    const held = gate();
    const server = llama({ door: () => held.promise });
    const translator = await translatorFor(server);
    const first = translator.translate(1, request(['Final Boss Guide']));
    await vi.waitFor(() => expect(server.chats(GEMMA)).toHaveLength(1));
    const second = translator.translate(1, request(['Roll backward.']));
    expect(await first).toMatchObject({
      ok: false,
      error: { internalCode: 'operation_cancelled' },
    });
    held.open();
    expect(await second).toEqual(
      Ok({ results: [{ id: 1, pieces: gemmaPieces('Roll backward.') }], translator: 'gemma' }),
    );
  });

  it('sends nothing to Gemma once a PLaMo request is cancelled', async () => {
    const held = gate();
    const server = llama({
      door: (chat) => (chat.model === PLAMO ? held.promise : Promise.resolve()),
    });
    const translator = await translatorFor(server, { translator: 'plamo' });
    const reply = translator.translate(1, request(['Final Boss Guide', rich, 'Roll backward.']));
    await vi.waitFor(() => expect(server.chats(PLAMO)).toHaveLength(2));
    translator.cancel(1);
    expect(await reply).toMatchObject({
      ok: false,
      error: { internalCode: 'operation_cancelled' },
    });
    held.open();
    expect(server.chats(GEMMA)).toEqual([]);
  });

  it('cancels everything on dispose and answers nothing after', async () => {
    const held = gate();
    const server = llama({ door: () => held.promise });
    const translator = await translatorFor(server);
    const running = translator.translate(1, request(['Final Boss Guide']));
    await vi.waitFor(() => expect(server.chats(GEMMA)).toHaveLength(1));
    translator.dispose();
    expect(await running).toMatchObject(cancelled);
    expect(await translator.translate(1, request(['Roll backward.']))).toMatchObject(cancelled);
    held.open();
  });
});

describe('settings', () => {
  it('keeps the settings until reload, then reads them and asks the server again', async () => {
    const server = llama();
    const translator = await translatorFor(server);
    await translator.translate(1, request(['Final Boss Guide']));
    const area = fakeBrowser.storage.local;
    await settingsStore(area).save({
      ...defaultSettings,
      models: { ...defaultSettings.models, translate: 'gemma4-e2b' },
    });
    await translator.translate(1, request(['Final Boss Guide']));
    expect(server.chats(GEMMA)).toHaveLength(2);

    translator.reload();
    await translator.translate(1, request(['Final Boss Guide']));
    expect(server.chats('gemma4-e2b')).toHaveLength(1);
    expect(server.asked()).toEqual([`/props?${GEMMA}`, '/props?gemma4-e2b']);

    // PLaMo chosen after a reload: the model list is asked from then on.
    await pageSettingsStore(area).save({ ...defaultPageSettings, translator: 'plamo' });
    translator.reload();
    await translator.translate(1, request(['Final Boss Guide']));
    expect(server.chats(PLAMO).map(lineOf)).toEqual(['Final Boss Guide']);
  });

  it('uses the default page settings when the stored record is not one', async () => {
    const server = llama();
    const translator = await translatorFor(server, { translator: 'plamo' });
    // The settings are read by the first request: a corrupt record does not lock translation.
    await fakeBrowser.storage.local.set({ page: { ...defaultPageSettings, translator: 'other' } });
    expect(await translator.translate(1, request(['Final Boss Guide']))).toEqual(
      Ok({ results: [{ id: 1, pieces: plamoPieces('Final Boss Guide') }], translator: 'plamo' }),
    );
    // PLaMo is the default: the model list and PLaMo's slots are asked; Gemma is not.
    expect(server.asked()).toEqual(['/v1/models', `/props?${PLAMO}`]);
    expect(server.chats(GEMMA)).toEqual([]);
  });

  it('fails a request when the page settings cannot be read from storage', async () => {
    const server = llama();
    const translator = createPageTranslator({
      fetch: server.fetch,
      settings: settingsStore(fakeBrowser.storage.local),
      pageSettings: {
        load: () => Promise.resolve(Err(failure('storage_failed'))),
        save: (settings) => Promise.resolve(Ok(settings)),
      },
    });
    created.push(translator);
    expect(await translator.translate(1, request(['Final Boss Guide']))).toMatchObject({
      ok: false,
      error: { internalCode: 'storage_failed' },
    });
    expect(server.calls).toEqual([]);
  });
});
