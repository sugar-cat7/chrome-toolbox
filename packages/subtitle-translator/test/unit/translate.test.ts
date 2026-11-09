import { describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createLlamaClient,
  createLruCache,
  createQueue,
  defaultSettings,
  PLAMO_TRANSLATE_MODEL,
  subtitleMaxTokens,
  subtitlePrompt,
  type Fetch,
  type LlamaClient,
} from '@chrome-toolbox/extension-core';
import { toPromptGlossary, type GlossaryEntry } from '../../src/glossary.ts';
import { contextHash, type PageInfo } from '../../src/page-context.ts';
import type { TranslateRequest } from '../../src/protocol.ts';
import {
  defaultSubtitleSettings,
  type SubtitleSettings,
  type SubtitleTranslator,
} from '../../src/settings.ts';
import {
  CAPTION_CACHE_ENTRIES,
  createSubtitleTranslator,
  type CaptionCacheEntry,
} from '../../src/translate.ts';

type ChatBody = {
  model: string;
  id_slot: number;
  max_tokens: number;
  temperature: number;
  cache_prompt: boolean;
  chat_template_kwargs: unknown;
  grammar: string;
  messages: { role: string; content: string }[];
};

/** The line a subtitle prompt asks to translate. */
function lineOf(body: ChatBody): string {
  const user = body.messages.at(-1)?.content ?? '';
  const match = /Line to translate \(JSON string\): (.*)$/u.exec(user);
  const line: unknown = JSON.parse(match?.[1] ?? '""');
  return typeof line === 'string' ? line : '';
}

/**
 * A llama.cpp router at the HTTP boundary. `GET /v1/models` lists `server.models`. Gemma
 * answers `訳:<line>` and a newline, or what `reply` says for a line; unreachable for a line
 * `reply` answers with undefined. PLaMo answers `訳P:<line>` (made up), or `server.plamoStatus`
 * when it is set.
 */
function fakeServer(reply: (line: string) => string | undefined = (line) => `訳:${line}\n`) {
  const bodies: ChatBody[] = [];
  const server: { models: readonly string[]; plamoStatus: number | undefined } = {
    models: ['gemma4-e4b', PLAMO_TRANSLATE_MODEL],
    plamoStatus: undefined,
  };
  const fetch: Fetch = async (input, init) => {
    if (input.endsWith('/v1/models'))
      return Response.json({ data: server.models.map((id) => ({ id })) });
    const body: ChatBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    bodies.push(body);
    if (body.model === PLAMO_TRANSLATE_MODEL && server.plamoStatus !== undefined)
      return new Response('', { status: server.plamoStatus });
    const content =
      body.model === PLAMO_TRANSLATE_MODEL
        ? `訳P:${body.messages[0]?.content ?? ''}`
        : reply(lineOf(body));
    if (content === undefined) throw new TypeError('Failed to fetch');
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  };
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:18083',
    fetch,
    queue: createQueue(),
  });
  return { bodies, client, server };
}

/** The viewer's subtitle settings with `translator`. */
const subtitlesWith =
  (translator: SubtitleTranslator) => async (): Promise<Result<SubtitleSettings>> =>
    Ok({ ...defaultSubtitleSettings, translator });

const VIDEO = 'abcdefghijk';
const PAGE: PageInfo = {
  videoId: VIDEO,
  streamer: 'UC-fixture',
  title: 'Fixture Quest day 3',
  author: 'Fixture Ch',
  live: false,
  tracks: 2,
};
const CONTEXT = 'Title: Fixture Quest day 3\nChannel: Fixture Ch';
const GLOSSARY: GlossaryEntry[] = [{ source: 'Fixturo', target: '' }];
const request = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({
  videoId: VIDEO,
  sourceLang: 'en',
  previous: [],
  sentences: [{ id: 'a', source: 'Okay chat.' }],
  ...over,
});
const translated = (id: string, source: string) => ({ id, ja: `訳:${source}`, state: 'done' });

describe('caption translator', () => {
  it('translates each sentence on slot 0 with the translate model and the three sentences before it', async () => {
    const { bodies, client } = fakeServer();
    const glossary = vi.fn<(streamer: string) => Promise<Result<GlossaryEntry[]>>>(async () =>
      Ok(GLOSSARY),
    );
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      subtitles: subtitlesWith('gemma'),
      glossary,
    });
    const sources = ['Fixturo is here.', 'Okay chat.', "We're going in."];
    const result = await translator.translate(
      request({
        previous: ['Zero.', 'One.'],
        sentences: sources.map((source, i) => ({ id: `s${i}`, source })),
      }),
      PAGE,
    );
    expect(result).toEqual(Ok({ lines: sources.map((source, i) => translated(`s${i}`, source)) }));
    expect(glossary).toHaveBeenCalledWith('UC-fixture');
    const previous = [
      ['Zero.', 'One.'],
      ['Zero.', 'One.', 'Fixturo is here.'],
      ['One.', 'Fixturo is here.', 'Okay chat.'],
    ];
    expect(bodies).toEqual(
      sources.map((source, i) => {
        const prompt = subtitlePrompt({
          source,
          sourceLang: 'en',
          previous: previous[i] ?? [],
          context: CONTEXT,
          // An empty target keeps the source as it is.
          glossary: [{ source: 'Fixturo', target: 'Fixturo' }],
        });
        return expect.objectContaining({
          model: 'gemma4-e4b',
          id_slot: 0,
          temperature: 0,
          cache_prompt: true,
          max_tokens: subtitleMaxTokens(source),
          chat_template_kwargs: { enable_thinking: false },
          messages: prompt.messages,
          grammar: prompt.grammar,
        });
      }),
    );
  });

  it('serves repeated sentences from the cache, keyed by translator, language, context and glossary', async () => {
    const { bodies, client } = fakeServer();
    let entries = GLOSSARY;
    const cache = createLruCache<string, CaptionCacheEntry>({ max: CAPTION_CACHE_ENTRIES });
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      subtitles: subtitlesWith('gemma'),
      glossary: async () => Ok(entries),
      cache,
    });
    const answer = Ok({ lines: [translated('a', 'Okay chat.')] });
    expect(await translator.translate(request(), PAGE)).toEqual(answer);
    expect(bodies).toHaveLength(1);
    expect(
      cache.get(
        `gemma\u0000en\u0000${contextHash(CONTEXT)}\u0000${contextHash(JSON.stringify(toPromptGlossary(GLOSSARY)))}\u0000Okay chat.`,
      ),
    ).toEqual({ ja: '訳:Okay chat.', chosen: 'gemma' });
    // The same sentence after other lines: the previous lines are not part of the key.
    expect(await translator.translate(request({ previous: ['Zero.'] }), PAGE)).toEqual(answer);
    expect(bodies).toHaveLength(1);
    entries = [{ source: 'Fixturo', target: 'フィクスチューロ' }];
    await translator.translate(request(), PAGE);
    expect(bodies).toHaveLength(2);
    await translator.translate(request({ sourceLang: 'es' }), PAGE);
    expect(bodies).toHaveLength(3);
    await translator.translate(request(), { ...PAGE, title: 'Fixture Quest day 4' });
    expect(bodies).toHaveLength(4);
    await translator.translate(request({ sourceLang: 'es' }), PAGE);
    expect(bodies).toHaveLength(4);
    expect(CAPTION_CACHE_ENTRIES).toBe(2000);
  });

  it.each([
    { name: 'ja', sourceLang: 'ja' },
    { name: 'ja-JP', sourceLang: 'ja-JP' },
  ])(
    'answers a Japanese track ($name) with its own sentences, without a chat',
    async ({ sourceLang }) => {
      const { bodies, client } = fakeServer();
      const translator = createSubtitleTranslator({
        client,
        settings: async () => Err(failure('storage_failed')),
        subtitles: async () => Err(failure('storage_failed')),
        glossary: async () => Err(failure('storage_failed')),
      });
      expect(
        await translator.translate(
          request({ sourceLang, sentences: [{ id: 'a', source: 'よし行くぞ' }] }),
          PAGE,
        ),
      ).toEqual(Ok({ lines: [{ id: 'a', ja: 'よし行くぞ', state: 'done' }] }));
      expect(bodies).toEqual([]);
    },
  );

  it.each([
    { name: 'a reply without its newline', reply: 'nope' },
    { name: 'an empty reply', reply: '\n' },
  ])('marks a sentence failed on $name and goes on with the next', async ({ reply }) => {
    const { bodies, client } = fakeServer((line) => (line === 'Bad.' ? reply : `訳:${line}\n`));
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      subtitles: subtitlesWith('gemma'),
      glossary: async () => Ok([]),
    });
    const result = await translator.translate(
      request({
        sentences: [
          { id: 'a', source: 'Bad.' },
          { id: 'b', source: 'Good.' },
        ],
      }),
      PAGE,
    );
    expect(result).toEqual(Ok({ lines: [{ id: 'a', state: 'failed' }, translated('b', 'Good.')] }));
    expect(bodies).toHaveLength(2);
    // A failed line is not kept: it is asked again.
    await translator.translate(request({ sentences: [{ id: 'a', source: 'Bad.' }] }), PAGE);
    expect(bodies).toHaveLength(3);
  });

  it.each(['network_failed', 'operation_cancelled'] as const)(
    'after %s, fails the rest of the batch without a chat, still answering it from the cache',
    async (code) => {
      const { client } = fakeServer();
      const chat = vi.fn<LlamaClient['chat']>(async () => Err(failure(code)));
      const cache = createLruCache<string, CaptionCacheEntry>({ max: CAPTION_CACHE_ENTRIES });
      const keyHead = `gemma\u0000en\u0000${contextHash(CONTEXT)}\u0000${contextHash('[]')}\u0000`;
      cache.set(`${keyHead}Known.`, { ja: '訳:Known.', chosen: 'gemma' });
      const translator = createSubtitleTranslator({
        client: { ...client, chat },
        settings: async () => Ok(defaultSettings),
        subtitles: subtitlesWith('gemma'),
        glossary: async () => Ok([]),
        cache,
      });
      const result = await translator.translate(
        request({
          sentences: [
            { id: 'a', source: 'First.' },
            { id: 'b', source: 'Second.' },
            { id: 'c', source: 'Known.' },
            { id: 'd', source: 'Fourth.' },
          ],
        }),
        PAGE,
      );
      expect(result).toEqual(
        Ok({
          lines: [
            { id: 'a', state: 'failed' },
            { id: 'b', state: 'failed' },
            translated('c', 'Known.'),
            { id: 'd', state: 'failed' },
          ],
        }),
      );
      expect(chat).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: 'of another video', page: { ...PAGE, videoId: 'zyxwvutsrqp' } },
    { name: 'not reported', page: undefined },
  ])('translates without context and glossary when the tab page is $name', async ({ page }) => {
    const { bodies, client } = fakeServer();
    const glossary = vi.fn<(streamer: string) => Promise<Result<GlossaryEntry[]>>>(async () =>
      Ok(GLOSSARY),
    );
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      subtitles: subtitlesWith('gemma'),
      glossary,
    });
    await translator.translate(request(), page);
    expect(glossary).not.toHaveBeenCalled();
    expect(bodies[0]?.messages).toEqual(
      subtitlePrompt({
        source: 'Okay chat.',
        sourceLang: 'en',
        previous: [],
        context: '',
        glossary: [],
      }).messages,
    );
  });

  it.each([
    {
      name: 'settings',
      settings: Err(failure('storage_failed')),
      subtitles: Ok(defaultSubtitleSettings),
      glossary: Ok(GLOSSARY),
    },
    {
      name: 'subtitle settings',
      settings: Ok(defaultSettings),
      subtitles: Err(failure('storage_failed')),
      glossary: Ok(GLOSSARY),
    },
    {
      name: 'glossary',
      settings: Ok(defaultSettings),
      subtitles: Ok(defaultSubtitleSettings),
      glossary: Err(failure('storage_failed')),
    },
  ])('returns the error when the $name cannot be read, without a chat', async (row) => {
    const { bodies, client } = fakeServer();
    const translator = createSubtitleTranslator({
      client,
      settings: async () => row.settings,
      subtitles: async () => row.subtitles,
      glossary: async () => row.glossary,
    });
    expect(await translator.translate(request(), PAGE)).toMatchObject({
      ok: false,
      error: { internalCode: 'storage_failed' },
    });
    expect(bodies).toEqual([]);
  });

  it('keys the cache by the translator that produced the line', async () => {
    const { bodies, client } = fakeServer();
    const cache = createLruCache<string, CaptionCacheEntry>({ max: CAPTION_CACHE_ENTRIES });
    let chosen: SubtitleTranslator = 'gemma';
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      subtitles: async () => Ok({ ...defaultSubtitleSettings, translator: chosen }),
      glossary: async () => Ok([]),
      cache,
    });
    const byGemma = Ok({ lines: [translated('a', 'Okay chat.')] });
    const byPlamo = Ok({ lines: [{ id: 'a', ja: '訳P:Okay chat.', state: 'done' }] });
    const keyTail = `en\u0000${contextHash(CONTEXT)}\u0000${contextHash('[]')}\u0000Okay chat.`;

    expect(await translator.translate(request(), PAGE)).toEqual(byGemma);
    chosen = 'plamo';
    // A line Gemma translated while Gemma was chosen is not served for PLaMo.
    expect(await translator.translate(request(), PAGE)).toEqual(byPlamo);
    expect(bodies.map((body) => body.model)).toEqual(['gemma4-e4b', 'plamo-3-translate-2b']);
    expect(cache.get(`gemma\u0000${keyTail}`)).toEqual({ ja: '訳:Okay chat.', chosen: 'gemma' });
    expect(cache.get(`plamo\u0000${keyTail}`)).toEqual({ ja: '訳P:Okay chat.', chosen: 'plamo' });
    chosen = 'gemma';
    expect(await translator.translate(request(), PAGE)).toEqual(byGemma);
    chosen = 'plamo';
    expect(await translator.translate(request(), PAGE)).toEqual(byPlamo);
    expect(bodies).toHaveLength(2);
  });

  it('keeps a line Gemma translated for PLaMo under the Gemma key and serves it again for PLaMo', async () => {
    const { bodies, client, server } = fakeServer();
    server.plamoStatus = 503;
    const cache = createLruCache<string, CaptionCacheEntry>({ max: CAPTION_CACHE_ENTRIES });
    let chosen: SubtitleTranslator = 'plamo';
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      subtitles: async () => Ok({ ...defaultSubtitleSettings, translator: chosen }),
      glossary: async () => Ok([]),
      cache,
    });
    const byGemma = Ok({ lines: [translated('a', 'Okay chat.')] });
    const keyTail = `en\u0000${contextHash(CONTEXT)}\u0000${contextHash('[]')}\u0000Okay chat.`;
    // Before any request: the default translator.
    expect(translator.status()).toEqual({ chosen: 'gemma' });

    // PLaMo refuses the line, and Gemma translates it.
    expect(await translator.translate(request(), PAGE)).toEqual(byGemma);
    expect(bodies.map((body) => body.model)).toEqual(['plamo-3-translate-2b', 'gemma4-e4b']);
    expect(translator.status()).toEqual({
      chosen: 'plamo',
      fallback: { latest: 'refused', lines: { not_listed: 0, refused: 1, language: 0 } },
    });
    expect(cache.get(`gemma\u0000${keyTail}`)).toEqual({ ja: '訳:Okay chat.', chosen: 'plamo' });
    expect(cache.get(`plamo\u0000${keyTail}`)).toBeUndefined();
    // Asked again with PLaMo chosen, the line comes from the cache: neither PLaMo nor Gemma.
    server.plamoStatus = undefined;
    expect(await translator.translate(request(), PAGE)).toEqual(byGemma);
    expect(bodies).toHaveLength(2);
    chosen = 'gemma';
    expect(await translator.translate(request(), PAGE)).toEqual(byGemma);
    expect(bodies).toHaveLength(2);
    expect(translator.status()).toEqual({ chosen: 'gemma' });
  });
});
