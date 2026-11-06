import { Ok, type Result } from '@chrome-toolbox/contracts';
import {
  parsePlamoLine,
  parseSubtitleLine,
  PLAMO_TRANSLATE_MODEL,
  plamoLanguage,
  plamoTranslateRequest,
  subtitleMaxTokens,
  subtitlePrompt,
  type LlamaClient,
} from '@chrome-toolbox/extension-core';
import type { GlossaryEntry } from './glossary.ts';
import type { SubtitleTranslator } from './settings.ts';

/**
 * One line to translate, with what its prompt needs (from captions or the live pipeline);
 * `glossary` has been through `toPromptGlossary`.
 */
export type LineInput = Readonly<{
  source: string;
  sourceLang: string;
  previous: readonly string[];
  context: string;
  glossary: readonly GlossaryEntry[];
  signal?: AbortSignal;
}>;
/**
 * Why a line went to Gemma while PLaMo was chosen: the router does not list PLaMo, PLaMo refused
 * the line (HTTP 4xx/5xx, or a line it cannot take), or PLaMo does not know the language.
 */
export type FallbackReason = 'not_listed' | 'refused' | 'language';
/**
 * The chosen translator; `fallback` only once Gemma translated a line while PLaMo was chosen:
 * the latest reason and the number of those lines.
 */
export type TranslatorStatus = Readonly<{
  chosen: SubtitleTranslator;
  fallback?: Readonly<{ reason: FallbackReason; lines: number }>;
}>;
/** A translation and the model that made it. */
export type LineTranslation = Readonly<{ ja: string; by: SubtitleTranslator }>;
export type LineTranslator = {
  translate(this: void, input: LineInput): Promise<Result<LineTranslation>>;
  status(this: void): TranslatorStatus;
};
/** The translator the viewer chose, and Gemma's name (`models.translate`). */
type LineConfig = Readonly<{ translator: SubtitleTranslator; model: string }>;

/** `signal` as a request field; the key is left out without one. */
const signalOf = (input: LineInput): { signal?: AbortSignal } =>
  input.signal === undefined ? {} : { signal: input.signal };

/** One line with Gemma on slot 0; a reply that is cut or not one line fails. */
async function gemmaLine(
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
    ...signalOf(input),
  });
  return reply.ok ? parseSubtitleLine(reply.value, maxTokens, input.source) : reply;
}

/**
 * Translates one subtitle line with the chosen model. With PLaMo chosen (slot 0), a line goes to
 * Gemma when PLaMo cannot take its language, the router does not list PLaMo, or PLaMo refuses it
 * (S16). Any other failure (unreachable, timed out, cancelled, a cut or unreadable reply, a full
 * queue) is returned: Gemma would not do better, and a retry after a timeout doubles the delay.
 */
export function createLineTranslator({
  client,
  config,
}: {
  client: LlamaClient;
  config: () => LineConfig;
}): LineTranslator {
  let chosen = config().translator;
  let fallback: TranslatorStatus['fallback'];
  /** Whether the router lists PLaMo; undefined until a list was read since PLaMo was chosen. */
  let listed: boolean | undefined;
  /** Counts changes of the chosen translator: what was learnt before a change is not kept. */
  let epoch = 0;

  /** The config now; a change of the chosen translator forgets the fallback and the list. */
  function current(): LineConfig {
    const now = config();
    if (now.translator !== chosen) {
      chosen = now.translator;
      fallback = undefined;
      listed = undefined;
      epoch += 1;
    }
    return now;
  }

  /** Whether the router lists PLaMo: asked once, and again only after a failed ask. */
  async function plamoListed(signal: AbortSignal | undefined): Promise<Result<boolean>> {
    if (listed !== undefined) return Ok(listed);
    const asked = epoch;
    const models = await client.models(signal);
    if (!models.ok) return models;
    const answer = models.value.includes(PLAMO_TRANSLATE_MODEL);
    if (asked === epoch) listed = answer;
    return Ok(answer);
  }

  /** The line with Gemma instead of PLaMo; counted when Gemma translated it. */
  async function fallBack(
    reason: FallbackReason,
    input: LineInput,
    model: string,
  ): Promise<Result<LineTranslation>> {
    const asked = epoch;
    const ja = await gemmaLine(client, model, input);
    if (!ja.ok) return ja;
    if (asked === epoch) fallback = { reason, lines: (fallback?.lines ?? 0) + 1 };
    return Ok({ ja: ja.value, by: 'gemma' });
  }

  async function translate(input: LineInput): Promise<Result<LineTranslation>> {
    const { translator, model } = current();
    if (translator === 'gemma') {
      const ja = await gemmaLine(client, model, input);
      return ja.ok ? Ok({ ja: ja.value, by: 'gemma' }) : ja;
    }
    if (plamoLanguage(input.sourceLang).kind === 'unsupported')
      return fallBack('language', input, model);
    // A list that cannot be read leaves the line to PLaMo; the next line asks again.
    const listing = await plamoListed(input.signal);
    if (listing.ok && !listing.value) return fallBack('not_listed', input, model);
    const request = plamoTranslateRequest({
      line: input.source,
      sourceLang: input.sourceLang,
      previous: input.previous,
      glossary: input.glossary,
      slot: 0,
    });
    if (!request.ok) return fallBack('refused', input, model);
    const reply = await client.chat({ ...request.value, ...signalOf(input) });
    if (!reply.ok)
      return reply.error.internalCode === 'model_refused'
        ? fallBack('refused', input, model)
        : reply;
    const ja = parsePlamoLine(reply.value, request.value.maxTokens, input.source);
    return ja.ok ? Ok({ ja: ja.value, by: 'plamo' }) : ja;
  }

  return {
    translate,
    status: (): TranslatorStatus => {
      const { translator } = current();
      return fallback === undefined ? { chosen: translator } : { chosen: translator, fallback };
    },
  };
}
