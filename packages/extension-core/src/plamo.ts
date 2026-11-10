import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { cutByMaxTokens, type ChatReply, type ChatRequest } from './llm.ts';
import { REPLY_LANGUAGE_TAG, translationLimit, type GlossaryEntry } from './prompts.ts';

/** The preset section of PLaMo 3 Translate 2B in `models.ini`; settings do not change it. */
export const PLAMO_TRANSLATE_MODEL = 'plamo-3-translate-2b';
/** The turn markers the model writes when it runs on; `stop` ends the reply at them. */
export const PLAMO_STOP = ['<|plamo:tag|>', '<|plamo:bos|>'] as const;
export const PLAMO_LICENSE_URL = 'https://plamo.preferredai.jp/info/plamo-community-license-ja';
export const PLAMO_LIMITS = { contextLines: 3, contextLineChars: 200, maxTokens: 256 } as const;
/** The 53 languages of the model card (`pt` is not one of them). */
// oxfmt-ignore
export const PLAMO_LANGUAGES: readonly string[] = ['ja', 'en', 'zh-hans', 'zh-hant', 'ko', 'ar', 'az', 'be', 'bg', 'bn', 'ca', 'ceb', 'de', 'es', 'et', 'eu', 'fa', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it', 'jv', 'ka', 'kk', 'km', 'lt', 'lv', 'ml', 'mr', 'ms', 'my', 'ne', 'nl', 'pa', 'pl', 'ru', 'si', 'sk', 'sl', 'sr', 'sw', 'ta', 'te', 'th', 'tl', 'ur', 'uz', 'vi'];

/** What to do with a source language: send this code, leave `source_lang` out, or refuse. */
export type PlamoLanguage = Readonly<
  { kind: 'send'; code: string } | { kind: 'omit' } | { kind: 'unsupported' }
>;
export type PlamoInput = Readonly<{
  /** The source text to translate: one line or unit. */
  line: string;
  /** `'auto'` when unknown (`source_lang` is then not sent). */
  sourceLang: string;
  /** The source text before `line`, oldest first. */
  previous: readonly string[];
  glossary: readonly GlossaryEntry[];
  /** The PLaMo slot; `undefined` sends no `id_slot`. */
  slot: number | undefined;
  /** Upper bound of `max_tokens`; `PLAMO_LIMITS.maxTokens` when omitted. */
  maxTokensCap?: number;
}>;

const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/u;
const SIMPLIFIED = new Set(['cn', 'sg']);
const TRADITIONAL = new Set(['tw', 'hk', 'mo']);
const RESERVED = '<|plamo:';
const ASCII_BLANK = /^[ \t\r\n]*$/u;

/**
 * The code to send as `source_lang`. The template accepts only the lowercase codes of the model
 * card and fails on a region (`zh-CN`), so a region is dropped and Chinese gets its script.
 */
export function plamoLanguage(code: string): PlamoLanguage {
  const normalized = code.toLowerCase().replaceAll('_', '-');
  if (normalized === 'auto' || !LANGUAGE_CODE.test(normalized)) return { kind: 'omit' };
  const [first = '', second = ''] = normalized.split('-');
  if (first === 'zh') {
    if (second === '') return { kind: 'omit' };
    if (SIMPLIFIED.has(second) || second.startsWith('hans'))
      return { kind: 'send', code: 'zh-hans' };
    if (TRADITIONAL.has(second) || second.startsWith('hant'))
      return { kind: 'send', code: 'zh-hant' };
  }
  return PLAMO_LANGUAGES.includes(first) ? { kind: 'send', code: first } : { kind: 'unsupported' };
}

/** `max_tokens` for `line`: the translation limit (as the comment batch), capped. */
export function plamoMaxTokens(line: string, cap: number = PLAMO_LIMITS.maxTokens): number {
  return Math.min(cap, translationLimit(line));
}

/** The first `count` code points of `text` (a cut never splits a surrogate pair). */
function firstPoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('');
}

const usable = (text: string): boolean => !ASCII_BLANK.test(text) && !text.includes(RESERVED);
const fold = (text: string): string => text.normalize('NFKC').toLowerCase();

/**
 * The chat request for one line: a single user message and the template variables, nothing
 * the template cannot take (no system turn, grammar or JSON Schema). The caller adds `signal`.
 */
export function plamoTranslateRequest(
  input: PlamoInput,
): Result<ChatRequest & Readonly<{ model: string; maxTokens: number }>> {
  const language = plamoLanguage(input.sourceLang);
  if (!usable(input.line) || language.kind === 'unsupported') return Err(failure('input_invalid'));
  const context = input.previous
    .filter(usable)
    .slice(-PLAMO_LIMITS.contextLines)
    .map((previous) => firstPoints(previous, PLAMO_LIMITS.contextLineChars))
    .join('\n');
  const folded = fold(input.line);
  const glossary = input.glossary
    .filter(
      (entry) =>
        usable(entry.source) && usable(entry.target) && folded.includes(fold(entry.source)),
    )
    .map(({ source, target }) => ({ source, target }));
  return Ok({
    model: PLAMO_TRANSLATE_MODEL,
    messages: [{ role: 'user', content: input.line }],
    templateKwargs: {
      target_lang: 'ja',
      ...(language.kind === 'send' ? { source_lang: language.code } : {}),
      ...(context === '' ? {} : { context }),
      ...(glossary.length === 0 ? {} : { glossary }),
    },
    temperature: 0,
    maxTokens: plamoMaxTokens(input.line, input.maxTokensCap),
    stop: PLAMO_STOP,
    cachePrompt: true,
    tellRefusal: true,
    ...(input.slot === undefined ? {} : { slot: input.slot }),
  });
}

/**
 * The translation of `line` from a reply: one line, inner line breaks folded into a space.
 * `<` and `>` stay, since the page translator reads its markers from the result.
 */
export function parsePlamoLine(reply: ChatReply, maxTokens: number, line: string): Result<string> {
  if (cutByMaxTokens(reply, maxTokens)) return Err(failure('response_invalid'));
  const text = reply.text
    .trim()
    .replace(/\s*\n\s*/gu, ' ')
    .replace(REPLY_LANGUAGE_TAG, '');
  if (text === '' || text.includes(RESERVED) || Array.from(text).length > translationLimit(line))
    return Err(failure('response_invalid'));
  return Ok(text);
}
