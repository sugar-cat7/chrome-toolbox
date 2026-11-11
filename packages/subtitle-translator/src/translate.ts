import { Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createLruCache,
  defaultSettings,
  type LlamaClient,
  type LruCache,
  type Settings,
} from '@chrome-toolbox/extension-core';
import { isJapanese } from './captions/tracks.ts';
import { toPromptGlossary, type GlossaryEntry } from './glossary.ts';
import { createLineTranslator, type TranslatorStatus } from './line-translator.ts';
import { contextHash, contextText, type PageInfo } from './page-context.ts';
import { TRANSLATE_LIMITS, type TranslateRequest, type TranslateResponse } from './protocol.ts';
import {
  defaultSubtitleSettings,
  type SubtitleSettings,
  type SubtitleTranslator,
} from './settings.ts';

/**
 * Translations the service worker keeps (keyed by the translator that made them, language,
 * context, glossary and source).
 */
export const CAPTION_CACHE_ENTRIES = 2_000;
/** A kept translation and the translator chosen when it was made. */
export type CaptionCacheEntry = Readonly<{ ja: string; chosen: SubtitleTranslator }>;

/**
 * Failures after which the rest of a batch gets no chat: a server that cannot be reached (or did
 * not answer within the timeout) would only make each sentence wait as long again, and a cancelled
 * request means the batch is no longer wanted. The rest fail (or come from the cache), and the
 * page retries them once.
 */
const BATCH_STOPPERS: readonly string[] = ['network_failed', 'operation_cancelled'];

export type CaptionTranslator = {
  /**
   * Translates the sentences one after another. `page` is what the sender's tab reported; it
   * gives the stream context and the streamer's glossary only when it names the request's video.
   * A sentence that fails is `failed`, and after an unreachable server or a cancellation so are the
   * ones after it that are not in the cache; reading the settings or the glossary fails the
   * request.
   */
  translate(
    this: void,
    request: TranslateRequest,
    page: PageInfo | undefined,
  ): Promise<Result<TranslateResponse>>;
  /** The line translator's status for the translator of the settings read last (Gemma before). */
  status(this: void): TranslatorStatus;
};

/**
 * The service worker's caption translator: it keeps no state but its cache and the line
 * translator's status, so a service worker that stopped loses nothing the watch page needs. A line
 * is kept under the translator that made it and looked up under the chosen one (S20). A line
 * Gemma translated while PLaMo was chosen is kept under Gemma, and a PLaMo lookup that misses
 * takes it, so a repeated line does not go to PLaMo and Gemma again; a line made while Gemma was
 * chosen is not served for PLaMo.
 */
export function createSubtitleTranslator({
  client,
  settings,
  subtitles,
  glossary,
  cache = createLruCache({ max: CAPTION_CACHE_ENTRIES }),
}: {
  client: LlamaClient;
  settings: () => Promise<Result<Settings>>;
  subtitles: () => Promise<Result<SubtitleSettings>>;
  glossary: (streamer: string) => Promise<Result<GlossaryEntry[]>>;
  cache?: LruCache<string, CaptionCacheEntry>;
}): CaptionTranslator {
  /** The translator and Gemma model of the settings read last. */
  let latest: Readonly<{ translator: SubtitleTranslator; model: string }> = {
    translator: defaultSubtitleSettings.translator,
    model: defaultSettings.models.translate,
  };
  const lineTranslator = createLineTranslator({ client, config: () => latest });
  return {
    status: lineTranslator.status,
    translate: async (request, page): Promise<Result<TranslateResponse>> => {
      const { sourceLang, sentences } = request;
      if (isJapanese(sourceLang))
        return Ok({
          lines: sentences.map(({ id, source }) => ({ id, ja: source, state: 'done' })),
        });
      const loaded = await settings();
      if (!loaded.ok) return loaded;
      const chosen = await subtitles();
      if (!chosen.ok) return chosen;
      const { translator } = chosen.value;
      latest = { translator, model: loaded.value.models.translate };
      const shown = page?.videoId === request.videoId ? page : undefined;
      const entries =
        shown?.streamer === undefined ? Ok<GlossaryEntry[]>([]) : await glossary(shown.streamer);
      if (!entries.ok) return entries;
      const context = shown === undefined ? '' : contextText(shown);
      const terms = toPromptGlossary(entries.value);
      const keyTail = `${sourceLang}\u0000${contextHash(context)}\u0000${contextHash(JSON.stringify(terms))}\u0000`;
      const keyOf = (by: SubtitleTranslator, source: string): string =>
        `${by}\u0000${keyTail}${source}`;
      /** The chosen translator's line, or Gemma's line made while the same one was chosen. */
      const cachedFor = (source: string): string | undefined => {
        const own = cache.get(keyOf(translator, source));
        if (own !== undefined) return own.ja;
        const gemma = cache.get(keyOf('gemma', source));
        return gemma?.chosen === translator ? gemma.ja : undefined;
      };
      const previous = [...request.previous];
      const lines: TranslateResponse['lines'] = [];
      /** Set once the server could not be reached or the request was cancelled. */
      let unreachable = false;
      for (const { id, source } of sentences) {
        const cached = cachedFor(source);
        if (cached !== undefined) lines.push({ id, ja: cached, state: 'done' });
        else if (unreachable) lines.push({ id, state: 'failed' });
        else {
          const ja = await lineTranslator.translate({
            source,
            sourceLang,
            previous: previous.slice(-TRANSLATE_LIMITS.previous),
            context,
            glossary: terms,
          });
          if (ja.ok) {
            cache.set(keyOf(ja.value.by, source), { ja: ja.value.ja, chosen: translator });
            lines.push({ id, ja: ja.value.ja, state: 'done' });
          } else {
            unreachable = BATCH_STOPPERS.includes(ja.error.internalCode);
            lines.push({ id, state: 'failed' });
          }
        }
        previous.push(source);
      }
      return Ok({ lines });
    },
  };
}
