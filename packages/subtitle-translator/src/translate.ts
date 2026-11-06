import { Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createLruCache,
  parseSubtitleLine,
  subtitleMaxTokens,
  subtitlePrompt,
  type LlamaClient,
  type LruCache,
  type Settings,
} from '@chrome-toolbox/extension-core';
import { isJapanese } from './captions/tracks.ts';
import { toPromptGlossary, type GlossaryEntry } from './glossary.ts';
import { contextHash, contextText, type PageInfo } from './page-context.ts';
import { TRANSLATE_LIMITS, type TranslateRequest, type TranslateResponse } from './protocol.ts';

/** Translations the service worker keeps (keyed by language, context, glossary and source). */
export const CAPTION_CACHE_ENTRIES = 2_000;

/** One caption line to translate, with what its prompt needs. */
type LineInput = Readonly<{
  source: string;
  sourceLang: string;
  previous: readonly string[];
  context: string;
  glossary: readonly GlossaryEntry[];
}>;

/**
 * One sentence with Gemma on slot 0 (Task 8 moves this call into the line translator, beside
 * PLaMo). A reply that is cut or not one line fails, and the sentence stays in its source.
 */
async function translateLine(
  client: LlamaClient,
  model: string,
  input: LineInput,
): Promise<Result<string>> {
  const maxTokens = subtitleMaxTokens(input.source);
  const reply = await client.chat({
    ...subtitlePrompt(input),
    model,
    slot: 0,
    temperature: 0,
    cachePrompt: true,
    maxTokens,
    templateKwargs: { enable_thinking: false },
  });
  return reply.ok ? parseSubtitleLine(reply.value, maxTokens, input.source) : reply;
}

export type CaptionTranslator = {
  /**
   * Translates the sentences one after another. `page` is what the sender's tab reported; it
   * gives the stream context and the streamer's glossary only when it names the request's video.
   * A sentence that fails is `failed`; reading the settings or the glossary fails the request.
   */
  translate(
    this: void,
    request: TranslateRequest,
    page: PageInfo | undefined,
  ): Promise<Result<TranslateResponse>>;
};

/**
 * The service worker's caption translator: it keeps no state but its cache, so a service worker
 * that stopped loses nothing the watch page needs.
 */
export function createSubtitleTranslator({
  client,
  settings,
  glossary,
  cache = createLruCache({ max: CAPTION_CACHE_ENTRIES }),
}: {
  client: LlamaClient;
  settings: () => Promise<Result<Settings>>;
  glossary: (streamer: string) => Promise<Result<GlossaryEntry[]>>;
  cache?: LruCache<string, string>;
}): CaptionTranslator {
  return {
    translate: async (request, page): Promise<Result<TranslateResponse>> => {
      const { sourceLang, sentences } = request;
      if (isJapanese(sourceLang))
        return Ok({
          lines: sentences.map(({ id, source }) => ({ id, ja: source, state: 'done' })),
        });
      const loaded = await settings();
      if (!loaded.ok) return loaded;
      const shown = page?.videoId === request.videoId ? page : undefined;
      const entries =
        shown?.streamer === undefined ? Ok<GlossaryEntry[]>([]) : await glossary(shown.streamer);
      if (!entries.ok) return entries;
      const context = shown === undefined ? '' : contextText(shown);
      const terms = toPromptGlossary(entries.value);
      const keyHead = `${sourceLang}\u0000${contextHash(context)}\u0000${contextHash(JSON.stringify(terms))}\u0000`;
      const previous = [...request.previous];
      const lines: TranslateResponse['lines'] = [];
      for (const { id, source } of sentences) {
        const key = `${keyHead}${source}`;
        const cached = cache.get(key);
        const ja =
          cached === undefined
            ? await translateLine(client, loaded.value.models.translate, {
                source,
                sourceLang,
                previous: previous.slice(-TRANSLATE_LIMITS.previous),
                context,
                glossary: terms,
              })
            : Ok(cached);
        if (ja.ok) {
          cache.set(key, ja.value);
          lines.push({ id, ja: ja.value, state: 'done' });
        } else lines.push({ id, state: 'failed' });
        previous.push(source);
      }
      return Ok({ lines });
    },
  };
}
