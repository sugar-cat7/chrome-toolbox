import { describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createLlamaClient,
  createLruCache,
  createQueue,
  defaultSettings,
  subtitleMaxTokens,
  subtitlePrompt,
  type Fetch,
} from '@chrome-toolbox/extension-core';
import { toPromptGlossary, type GlossaryEntry } from '../../src/glossary.ts';
import { contextHash, type PageInfo } from '../../src/page-context.ts';
import type { TranslateRequest } from '../../src/protocol.ts';
import { CAPTION_CACHE_ENTRIES, createSubtitleTranslator } from '../../src/translate.ts';

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
 * llama-server's chat endpoint at the HTTP boundary: answers `訳:<line>` and a newline, or what
 * `reply` says for a line; unreachable for a line `reply` answers with undefined.
 */
function fakeServer(reply: (line: string) => string | undefined = (line) => `訳:${line}\n`) {
  const bodies: ChatBody[] = [];
  const fetch: Fetch = async (_input, init) => {
    const body: ChatBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    bodies.push(body);
    const content = reply(lineOf(body));
    if (content === undefined) throw new TypeError('Failed to fetch');
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  };
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:18083',
    fetch,
    queue: createQueue(),
  });
  return { bodies, client };
}

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

  it('serves repeated sentences from the cache, keyed by language, context and glossary', async () => {
    const { bodies, client } = fakeServer();
    let entries = GLOSSARY;
    const cache = createLruCache<string, string>({ max: CAPTION_CACHE_ENTRIES });
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
      glossary: async () => Ok(entries),
      cache,
    });
    const answer = Ok({ lines: [translated('a', 'Okay chat.')] });
    expect(await translator.translate(request(), PAGE)).toEqual(answer);
    expect(bodies).toHaveLength(1);
    expect(
      cache.get(
        `en\u0000${contextHash(CONTEXT)}\u0000${contextHash(JSON.stringify(toPromptGlossary(GLOSSARY)))}\u0000Okay chat.`,
      ),
    ).toBe('訳:Okay chat.');
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
    { name: 'an unreachable server', reply: undefined },
  ])('marks a sentence failed on $name and goes on with the next', async ({ reply }) => {
    const { bodies, client } = fakeServer((line) => (line === 'Bad.' ? reply : `訳:${line}\n`));
    const translator = createSubtitleTranslator({
      client,
      settings: async () => Ok(defaultSettings),
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
    { name: 'settings', settings: Err(failure('storage_failed')), glossary: Ok(GLOSSARY) },
    { name: 'glossary', settings: Ok(defaultSettings), glossary: Err(failure('storage_failed')) },
  ])('returns the error when the $name cannot be read, without a chat', async (row) => {
    const { bodies, client } = fakeServer();
    const translator = createSubtitleTranslator({
      client,
      settings: async () => row.settings,
      glossary: async () => row.glossary,
    });
    expect(await translator.translate(request(), PAGE)).toMatchObject({
      ok: false,
      error: { internalCode: 'storage_failed' },
    });
    expect(bodies).toEqual([]);
  });
});
