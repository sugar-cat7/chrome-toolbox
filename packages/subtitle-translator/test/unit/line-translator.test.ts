import { describe, expect, it } from 'vitest';
import { Ok } from '@chrome-toolbox/contracts';
import {
  createLlamaClient,
  createQueue,
  PLAMO_TRANSLATE_MODEL,
  plamoMaxTokens,
  subtitleMaxTokens,
  subtitlePrompt,
  type Fetch,
  type LlamaClient,
} from '@chrome-toolbox/extension-core';
import {
  createLineTranslator,
  type FallbackReason,
  type LineInput,
  type TranslatorStatus,
} from '../../src/line-translator.ts';
import type { SubtitleTranslator } from '../../src/settings.ts';

type ChatBody = {
  model: string;
  messages: { role: string; content: string }[];
};

/** The line a Gemma subtitle prompt asks to translate. */
function gemmaLineOf(body: ChatBody): string {
  const user = body.messages.at(-1)?.content ?? '';
  const match = /Line to translate \(JSON string\): (.*)$/u.exec(user);
  const line: unknown = JSON.parse(match?.[1] ?? '""');
  return typeof line === 'string' ? line : '';
}

/** How the fake answers a PLaMo chat: a made-up line, cut, blank, unreachable or an HTTP status. */
type PlamoAnswer = 'ok' | 'cut' | 'blank' | 'unreachable' | number;

const reply = (content: string, finishReason = 'stop'): Response =>
  Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });

/**
 * A llama.cpp router at the HTTP boundary. `GET /v1/models` lists `server.models` (HTTP 503 when
 * undefined). Gemma answers `訳:<line>` and a newline, or is unreachable for a line `gemma`
 * answers false. PLaMo answers `訳P:<line>` (made up) or what `plamo` says for the line.
 */
function fakeServer({
  plamo = () => 'ok',
  gemma = () => true,
}: {
  plamo?: (line: string) => PlamoAnswer;
  gemma?: (line: string) => boolean;
} = {}) {
  const server: { models: readonly string[] | undefined; listings: number } = {
    models: ['gemma4-e4b', PLAMO_TRANSLATE_MODEL],
    listings: 0,
  };
  const chats: ChatBody[] = [];
  const fetch: Fetch = async (input, init) => {
    if (input.endsWith('/v1/models')) {
      server.listings += 1;
      return server.models === undefined
        ? new Response('', { status: 503 })
        : Response.json({ data: server.models.map((id) => ({ id })) });
    }
    const body: ChatBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    chats.push(body);
    if (body.model !== PLAMO_TRANSLATE_MODEL) {
      const line = gemmaLineOf(body);
      if (!gemma(line)) throw new TypeError('Failed to fetch');
      return reply(`訳:${line}\n`);
    }
    const line = body.messages[0]?.content ?? '';
    const answer = plamo(line);
    if (answer === 'unreachable') throw new TypeError('Failed to fetch');
    if (typeof answer === 'number') return new Response('', { status: answer });
    if (answer === 'cut') return reply(`訳P:${line}`, 'length');
    return reply(answer === 'blank' ? ' \n' : `訳P:${line}`);
  };
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:18083',
    fetch,
    queue: createQueue(),
  });
  return {
    server,
    client,
    gemmaChats: () => chats.filter((chat) => chat.model !== PLAMO_TRANSLATE_MODEL),
    plamoChats: () => chats.filter((chat) => chat.model === PLAMO_TRANSLATE_MODEL),
  };
}

/** A line translator whose chosen translator the test changes with `choose`. */
function translatorFor(client: LlamaClient, first: SubtitleTranslator) {
  let translator = first;
  const lines = createLineTranslator({
    client,
    config: () => ({ translator, model: 'gemma4-e4b' }),
  });
  return {
    lines,
    choose: (next: SubtitleTranslator) => {
      translator = next;
    },
  };
}

/** The fallback of a status: the latest reason and the lines Gemma translated for each reason. */
const fellBack = (
  latest: FallbackReason,
  lines: Partial<Record<FallbackReason, number>>,
): TranslatorStatus['fallback'] => ({
  latest,
  lines: { not_listed: 0, refused: 0, language: 0, ...lines },
});

const CONTEXT = 'Title: Fixture Quest day 3\nChannel: Fixture Ch';
const line = (over: Partial<LineInput> = {}): LineInput => ({
  source: 'Okay chat, the bridge is out.',
  sourceLang: 'en',
  previous: ['We reached the gate.'],
  context: CONTEXT,
  glossary: [
    { source: 'Fixturo', target: 'Fixturo' },
    { source: 'bridge', target: '橋' },
  ],
  ...over,
});
const cancelled = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

describe('line translator', () => {
  it('translates with Gemma on slot 0 when Gemma is chosen', async () => {
    const { server, client, gemmaChats, plamoChats } = fakeServer();
    const { lines } = translatorFor(client, 'gemma');
    const input = line();

    expect(await lines.translate(input)).toEqual(Ok({ ja: `訳:${input.source}`, by: 'gemma' }));
    const prompt = subtitlePrompt(input);
    expect(gemmaChats()).toEqual([
      expect.objectContaining({
        model: 'gemma4-e4b',
        id_slot: 0,
        temperature: 0,
        cache_prompt: true,
        max_tokens: subtitleMaxTokens(input.source),
        chat_template_kwargs: { enable_thinking: false },
        messages: prompt.messages,
        grammar: prompt.grammar,
      }),
    ]);
    expect(plamoChats()).toEqual([]);
    expect(server.listings).toBe(0);
    expect(lines.status()).toEqual({ chosen: 'gemma' });
    // The signal reaches the chat: a cancelled line is not sent.
    expect(await lines.translate(line({ signal: cancelled() }))).toMatchObject({
      ok: false,
      error: { internalCode: 'operation_cancelled' },
    });
    expect(gemmaChats()).toHaveLength(1);
  });

  it('translates with PLaMo when it is chosen and listed', async () => {
    const { server, client, gemmaChats, plamoChats } = fakeServer();
    const { lines } = translatorFor(client, 'plamo');
    const input = line();

    expect(await lines.translate(input)).toEqual(Ok({ ja: `訳P:${input.source}`, by: 'plamo' }));
    // One user message and the template variables: no system turn, grammar or JSON Schema.
    expect(plamoChats()).toEqual([
      {
        model: 'plamo-3-translate-2b',
        messages: [{ role: 'user', content: input.source }],
        stream: false,
        cache_prompt: true,
        max_tokens: plamoMaxTokens(input.source),
        temperature: 0,
        id_slot: 0,
        chat_template_kwargs: {
          target_lang: 'ja',
          source_lang: 'en',
          context: 'We reached the gate.',
          // Only the terms the line contains.
          glossary: [{ source: 'bridge', target: '橋' }],
        },
        stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
      },
    ]);
    expect(gemmaChats()).toEqual([]);
    expect(server.listings).toBe(1);
    expect(lines.status()).toEqual({ chosen: 'plamo' });
  });

  it.each<{
    name: string;
    reason: FallbackReason;
    plamo: number;
    models?: string[];
    plamoStatus?: number;
    source?: string;
    sourceLang?: string;
    listings?: number;
  }>([
    { name: 'ルーターに載っていない', models: ['gemma4-e4b'], reason: 'not_listed', plamo: 0 },
    { name: 'HTTP 404', plamoStatus: 404, reason: 'refused', plamo: 1 },
    { name: 'HTTP 503', plamoStatus: 503, reason: 'refused', plamo: 1 },
    { name: '予約トークンを含む行', source: 'gg <|plamo:tag|> ez', reason: 'refused', plamo: 0 },
    // The language is checked before the model list is asked.
    { name: '対応していない言語', sourceLang: 'pt', reason: 'language', plamo: 0, listings: 0 },
  ])('falls back to Gemma for the line: $name', async (row) => {
    const { server, client, gemmaChats, plamoChats } = fakeServer({
      plamo: () => row.plamoStatus ?? 'ok',
    });
    if (row.models !== undefined) server.models = row.models;
    const { lines } = translatorFor(client, 'plamo');
    const input = line({
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.sourceLang === undefined ? {} : { sourceLang: row.sourceLang }),
    });

    expect(await lines.translate(input)).toEqual(Ok({ ja: `訳:${input.source}`, by: 'gemma' }));
    expect(gemmaChats()).toEqual([
      expect.objectContaining({ model: 'gemma4-e4b', id_slot: 0, grammar: expect.any(String) }),
    ]);
    expect(plamoChats()).toHaveLength(row.plamo);
    expect(server.listings).toBe(row.listings ?? 1);
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: fellBack(row.reason, { [row.reason]: 1 }),
    });
  });

  it('tries PLaMo again on the next line after a refusal', async () => {
    const { client, gemmaChats, plamoChats } = fakeServer({
      plamo: (source) => (source === 'First.' ? 503 : 'ok'),
    });
    const { lines } = translatorFor(client, 'plamo');

    expect(await lines.translate(line({ source: 'First.' }))).toEqual(
      Ok({ ja: '訳:First.', by: 'gemma' }),
    );
    expect(await lines.translate(line({ source: 'Second.' }))).toEqual(
      Ok({ ja: '訳P:Second.', by: 'plamo' }),
    );
    expect(plamoChats()).toHaveLength(2);
    expect(gemmaChats()).toHaveLength(1);
    // The fallback stays until the translator changes.
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: fellBack('refused', { refused: 1 }),
    });
  });

  it('counts the lines Gemma translated for PLaMo by reason and keeps the latest reason', async () => {
    const { client } = fakeServer({
      plamo: (source) => (source.startsWith('Refused') ? 500 : 'ok'),
    });
    const { lines } = translatorFor(client, 'plamo');

    await lines.translate(line({ source: 'Olá.', sourceLang: 'pt' }));
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: { latest: 'language', lines: { not_listed: 0, refused: 0, language: 1 } },
    });
    await lines.translate(line({ source: 'Fine.' }));
    await lines.translate(line({ source: 'Refused one.' }));
    await lines.translate(line({ source: 'Refused two.' }));
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: { latest: 'refused', lines: { not_listed: 0, refused: 2, language: 1 } },
    });
    await lines.translate(line({ source: 'Tchau.', sourceLang: 'pt' }));
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: { latest: 'language', lines: { not_listed: 0, refused: 2, language: 2 } },
    });
  });

  it('returns the error of a fallback line that Gemma could not translate, without counting it', async () => {
    const { server, client } = fakeServer({ gemma: (source) => source !== 'Down.' });
    server.models = ['gemma4-e4b'];
    const { lines } = translatorFor(client, 'plamo');

    expect(await lines.translate(line({ source: 'Down.' }))).toMatchObject({
      ok: false,
      error: { internalCode: 'network_failed' },
    });
    expect(lines.status()).toEqual({ chosen: 'plamo' });
  });

  it('asks the model list once, and again after the translator changes back to PLaMo', async () => {
    const { server, client, gemmaChats } = fakeServer();
    const { lines, choose } = translatorFor(client, 'plamo');

    expect(await lines.translate(line({ source: 'One.' }))).toEqual(
      Ok({ ja: '訳P:One.', by: 'plamo' }),
    );
    expect(await lines.translate(line({ source: 'Dois.', sourceLang: 'pt' }))).toEqual(
      Ok({ ja: '訳:Dois.', by: 'gemma' }),
    );
    expect(await lines.translate(line({ source: 'Three.' }))).toEqual(
      Ok({ ja: '訳P:Three.', by: 'plamo' }),
    );
    expect(server.listings).toBe(1);
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: fellBack('language', { language: 1 }),
    });

    choose('gemma');
    // A change of the chosen translator clears the fallback.
    expect(lines.status()).toEqual({ chosen: 'gemma' });
    expect(await lines.translate(line({ source: 'Four.' }))).toEqual(
      Ok({ ja: '訳:Four.', by: 'gemma' }),
    );
    expect(gemmaChats()).toHaveLength(2);
    expect(server.listings).toBe(1);

    choose('plamo');
    expect(await lines.translate(line({ source: 'Five.' }))).toEqual(
      Ok({ ja: '訳P:Five.', by: 'plamo' }),
    );
    expect(await lines.translate(line({ source: 'Six.' }))).toEqual(
      Ok({ ja: '訳P:Six.', by: 'plamo' }),
    );
    expect(server.listings).toBe(2);
    expect(lines.status()).toEqual({ chosen: 'plamo' });
  });

  it('sends the line to PLaMo when the model list cannot be read, and asks again before the next', async () => {
    const { server, client } = fakeServer();
    server.models = undefined;
    const { lines } = translatorFor(client, 'plamo');

    expect(await lines.translate(line({ source: 'One.' }))).toEqual(
      Ok({ ja: '訳P:One.', by: 'plamo' }),
    );
    expect(server.listings).toBe(1);
    server.models = ['gemma4-e4b'];
    expect(await lines.translate(line({ source: 'Two.' }))).toEqual(
      Ok({ ja: '訳:Two.', by: 'gemma' }),
    );
    expect(await lines.translate(line({ source: 'Three.' }))).toEqual(
      Ok({ ja: '訳:Three.', by: 'gemma' }),
    );
    // Read once, the answer is kept.
    expect(server.listings).toBe(2);
    expect(lines.status()).toEqual({
      chosen: 'plamo',
      fallback: fellBack('not_listed', { not_listed: 2 }),
    });
  });

  it.each([
    { name: '接続できない', failure: 'unreachable', code: 'network_failed' },
    { name: 'max_tokens で切れた', failure: 'cut', code: 'response_invalid' },
    { name: '空の返事', failure: 'blank', code: 'response_invalid' },
    { name: '取り消した', failure: 'ok', code: 'operation_cancelled', cancel: true },
  ] as const)('does not fall back to Gemma on $name', async ({ failure, code, ...row }) => {
    const { client, gemmaChats } = fakeServer({ plamo: () => failure });
    const { lines } = translatorFor(client, 'plamo');

    expect(
      await lines.translate(line('cancel' in row && row.cancel ? { signal: cancelled() } : {})),
    ).toMatchObject({ ok: false, error: { internalCode: code } });
    expect(gemmaChats()).toEqual([]);
    expect(lines.status()).toEqual({ chosen: 'plamo' });
  });
});
