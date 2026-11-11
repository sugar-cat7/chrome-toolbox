import { z } from 'zod/mini';
import { decode, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { createFetchTransport, type FetchOptions } from './transport.ts';
import { parseBaseUrl } from './llm.ts';
import type { Queue } from './queue.ts';

/**
 * A comment is treated as abusive when its probability reaches this value. At 0.5 every comment
 * Clef flagged in a live Japanese gaming chat was a false positive (game terms, catchphrases,
 * affectionate teasing); a channel's feedback may raise it further.
 */
export const ABUSIVE_THRESHOLD = 0.8;

/** Whether a Clef probability makes a comment abusive at `threshold` (the default unless a channel raised it). */
export const isAbusive = (probability: number, threshold = ABUSIVE_THRESHOLD): boolean =>
  probability >= threshold;

export type ToxicityJudge = {
  mode: 'clef' | 'llm';
  /** The probability (0-1) that each text is abusive; `llm` mode returns `[]` (see `commentBatchPrompt`). */
  judge(this: void, texts: readonly string[], signal?: AbortSignal): Promise<Result<number[]>>;
};

const DEFAULT_MAX_PROMPT_CHARS = 1500;
const TIMEOUT_MS = 30_000;
const answerSchema = z.object({ noul: z.number().check(z.gte(0), z.lte(1)) });
const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

/** llama.cpp's router error for a model it has no preset for: `model '<name>' not found`. */
const MODEL_NOT_FOUND = /\bmodel '[^']*' not found\b/u;
const STATE_HEADER = 'Chat messages:';
// Clef scores every question of a request jointly, so a benign comment next to an abusive one
// inherits its score (live-observed). One comment per request keeps scores independent.
const DEFAULT_MAX_ITEMS = 1;
const messageLine = (text: string, n: number): string => `${n}: ${JSON.stringify(text)}`;
const question = (n: number): { type: string; instructions: string } => ({
  type: 'noul',
  instructions: `Is chat message ${n} abusive toward someone?`,
});
/** Request-body size one comment adds: its state line, newline and question entry (widest index). */
const itemCost = (text: string, widest: number): number =>
  messageLine(text, widest).length +
  1 +
  JSON.stringify({ [`c${widest}`]: question(widest) }).length;

/** Groups texts so each request's estimated size stays within `limit` and `maxItems` (a lone long text gets its own). */
function chunk(texts: readonly string[], limit: number, maxItems: number): string[][] {
  const groups: string[][] = [];
  let size = 0;
  for (const text of texts) {
    const cost = itemCost(text, maxItems);
    const last = groups[groups.length - 1];
    if (last && last.length < maxItems && size + cost <= limit) {
      last.push(text);
      size += cost;
    } else {
      groups.push([text]);
      size = STATE_HEADER.length + cost;
    }
  }
  return groups;
}

/**
 * `maxItemsPerChunk` defaults to 1: Clef judges all questions of one prompt jointly, so batching
 * lets an abusive comment raise its neighbours' scores. Raise it only to trade accuracy for speed.
 */
// Cloudflare Clef-Flash decision model, served by llama.cpp `POST /v1/systemone`:
// one `noul` question per comment answers with a probability in `answers[id].noul`.
export function createClefJudge(
  options: FetchOptions & {
    baseUrl: string;
    model: string;
    queue: Queue;
    maxPromptChars?: number;
    maxItemsPerChunk?: number;
  },
): ToxicityJudge {
  const {
    baseUrl,
    model,
    queue,
    maxPromptChars = DEFAULT_MAX_PROMPT_CHARS,
    maxItemsPerChunk = DEFAULT_MAX_ITEMS,
  } = options;
  const transport = createFetchTransport(options);
  /**
   * An HTTP error answer (R53). Clef is not there: 501 (the model is not a decision model), 404
   * (no such model or no `/v1/systemone` route) and a router's 400 "model '<name>' not found"
   * give `clef_unavailable`. Anything else (a 400 for this request alone, a 5xx while the model
   * loads) fails this request only: `response_invalid`.
   */
  async function refused(response: Response, signal: AbortSignal): Promise<Result<never>> {
    if (response.status === 501 || response.status === 404) return Err(failure('clef_unavailable'));
    if (response.status !== 400) return Err(failure('response_invalid'));
    const text = await transport.text(response, signal);
    if (signal.aborted) return Err(failure('operation_cancelled'));
    return Err(
      failure(
        text.ok && MODEL_NOT_FOUND.test(text.value) ? 'clef_unavailable' : 'response_invalid',
      ),
    );
  }
  async function request(
    origin: string,
    group: readonly string[],
    signal: AbortSignal,
  ): Promise<Result<number[]>> {
    // JSON-encoded so a comment cannot start a line that looks like another message.
    const state = `${STATE_HEADER}\n${group.map((text, i) => messageLine(text, i + 1)).join('\n')}`;
    const questions = Object.fromEntries(group.map((_text, i) => [`c${i + 1}`, question(i + 1)]));
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const response = await transport.request(`${origin}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: requestSignal,
    });
    if (signal.aborted) return Err(failure('operation_cancelled'));
    // A rejected fetch or a timeout: the server is unreachable or silent.
    if (!response.ok) return response;
    if (!response.value.ok) return refused(response.value, requestSignal);
    const body = await transport.json(response.value, requestSignal);
    if (signal.aborted) return Err(failure('operation_cancelled'));
    if (!body.ok) return body;
    const decoded = decode(responseSchema, body.value);
    if (!decoded.ok) return decoded;
    const probabilities: number[] = [];
    for (let i = 1; i <= group.length; i += 1) {
      const answer = decode(answerSchema, decoded.value.answers[`c${i}`]);
      if (!answer.ok) return answer;
      probabilities.push(answer.value.noul);
    }
    return Ok(probabilities);
  }
  async function judge(texts: readonly string[], signal?: AbortSignal): Promise<Result<number[]>> {
    if (texts.length === 0) return Ok([]);
    const origin = parseBaseUrl(baseUrl);
    if (!origin.ok) return origin;
    const probabilities: number[] = [];
    for (const group of chunk(texts, maxPromptChars, maxItemsPerChunk)) {
      const result = await queue.run(
        (taskSignal) => request(origin.value, group, taskSignal),
        signal,
      );
      if (!result.ok) return result;
      probabilities.push(...result.value);
    }
    return Ok(probabilities);
  }
  return { mode: 'clef', judge };
}

/** Alternative to Clef: abusiveness comes from the `abusive` category of `commentBatchPrompt`. */
export const llmCategoryJudge: ToxicityJudge = {
  mode: 'llm',
  judge: () => Promise.resolve(Ok([])),
};
