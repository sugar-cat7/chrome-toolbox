import { capture, Ok, type Result } from '@chrome-toolbox/contracts';

export type LanguageGuess = Readonly<{ lang: string; confidence: number }>;
type DetectedLanguage = Readonly<{ detectedLanguage: string; confidence: number }>;
type OnDeviceDetector = { detect(text: string): Promise<readonly DetectedLanguage[]> };
/** Adapter over Chrome's built-in `LanguageDetector`; `undefined` when the API is unavailable. */
export type LanguageDetectorApi = { create(): Promise<OnDeviceDetector> };
export type LanguageDetector = { detect(text: string): Promise<Result<LanguageGuess>> };

const minConfidence = 0.5;
const undetermined: LanguageGuess = { lang: 'und', confidence: 0 };

const inRanges = (code: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([from, to]) => code >= from && code <= to);
const kanaRanges = [
  [0x3041, 0x309f], // hiragana
  [0x30a0, 0x30ff], // katakana (includes the long-vowel mark)
  [0x31f0, 0x31ff], // katakana phonetic extensions
  [0xff66, 0xff9f], // half-width katakana
] as const;
const hangulRanges = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xac00, 0xd7af],
] as const;
const hanRanges = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2ebef],
] as const;
const latinRanges = [
  [0x41, 0x5a],
  [0x61, 0x7a],
  [0xc0, 0x24f],
] as const;

const letter = /\p{L}/u;
/**
 * Characters that mark kanji-only text as Japanese: full-width laughter `ｗ`, the full-width
 * `！` and `？` Japanese input produces, and marks only Japanese writes (`々`, `〆`, `〜`; the
 * long-vowel mark `ー` already counts as kana).
 */
const japaneseMarks = new Set(['ｗ', '！', '？', '々', '〆', '〜']);
/**
 * Characters only Chinese writes: simplified forms, and pronouns and particles kanji-only
 * Japanese chat does not use. One outweighs the Japanese marks above.
 */
const chineseCharacters = new Set([
  '你',
  '们',
  '們',
  '这',
  '這',
  '吗',
  '嗎',
  '呢',
  '么',
  '麼',
  '说',
  '說',
  '吧',
  '啊',
  '哦',
  '对',
  '过',
  '还',
  '爱',
  '哈',
  '谢',
  '强',
  '厉',
  '帅',
  '欢',
  '为',
  '时',
  '发',
  '现',
  '实',
  '头',
  '门',
  '东',
  '车',
  '马',
  '见',
  '气',
  '个',
  '让',
  '给',
  '错',
  '样',
  '假',
  '稳',
  '我',
  '他',
  '她',
  '是',
  '很',
  '啥',
  '咋',
  '嘛',
  '呀',
  '啦',
]);
/** Chinese words made only of characters Japanese writes too. */
const chineseWords = /加油|真的|主播|好看|好棒|没有/u;
/** Japanese words that contain one of the characters above. */
const japaneseWords = /我慢|我々|自我|是非|他人/gu;

/** Whether kanji-only text carries a Chinese character or word (outside a Japanese word). */
function chinese(text: string): boolean {
  const rest = text.replace(japaneseWords, '');
  if (chineseWords.test(rest)) return true;
  for (const char of rest) if (chineseCharacters.has(char)) return true;
  return false;
}
/** Half-width laughter (`w`, `www`) closing a short text, after any spaces or punctuation. */
const trailingLaughter = /(w+)[\s\p{P}\p{S}]*$/iu;
/** Longest text whose trailing `w` still reads as Japanese laughter. */
const SHORT_TEXT = 32;

/**
 * Single linear pass by Unicode script: kana > Hangul > Han-only > Latin or other letters
 * (Cyrillic, Thai, Arabic, Devanagari, …, whichever is more) > nothing. Han-only text is
 * Japanese when it carries a Japanese mark or ends in laughter, unless a Chinese character or
 * word says otherwise.
 */
export function scriptLanguageGuess(text: string): LanguageGuess {
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let latin = 0;
  let other = 0;
  let length = 0;
  let japaneseMark = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    length += 1;
    if (japaneseMarks.has(char)) japaneseMark = true;
    if (inRanges(code, kanaRanges)) kana += 1;
    else if (inRanges(code, hangulRanges)) hangul += 1;
    else if (inRanges(code, hanRanges)) han += 1;
    else if (inRanges(code, latinRanges)) latin += 1;
    else if (letter.test(char)) other += 1;
  }
  // Japanese mixes kanji with kana, so any kana outranks Han; Han alone is a Chinese hint
  // unless the text has a Japanese mark or its only Latin letters are trailing laughter.
  if (kana > 0 && kana >= hangul) return { lang: 'ja', confidence: 0.9 };
  if (hangul > 0) return { lang: 'ko', confidence: 0.9 };
  if (han > 0) {
    const laughter = length <= SHORT_TEXT ? trailingLaughter.exec(text)?.[1] : undefined;
    const japanese = japaneseMark || (laughter !== undefined && laughter.length === latin);
    return japanese && !chinese(text)
      ? { lang: 'ja', confidence: 0.6 }
      : { lang: 'zh', confidence: 0.5 };
  }
  if (other > latin) return { lang: 'und-Other', confidence: 0.3 };
  if (latin > 0) return { lang: 'und-Latn', confidence: 0.3 };
  return undetermined;
}

export function createLanguageDetector(api: LanguageDetectorApi | undefined): LanguageDetector {
  // One shared create(); a failed create is cached too so each comment does not retry it.
  let created: Promise<Result<OnDeviceDetector>> | undefined;
  const instance = (): Promise<Result<OnDeviceDetector>> | undefined => {
    if (api === undefined) return undefined;
    created ??= capture(() => api.create(), 'unexpected_failure');
    return created;
  };
  return {
    detect: async (text): Promise<Result<LanguageGuess>> => {
      const fallback = scriptLanguageGuess(text);
      const ready = await instance();
      if (ready === undefined || !ready.ok) return Ok(fallback);
      const detector = ready.value;
      const candidates = await capture(() => detector.detect(text), 'unexpected_failure');
      if (!candidates.ok) return Ok(fallback);
      const best = candidates.value[0];
      if (best === undefined || best.confidence < minConfidence) return Ok(fallback);
      return Ok({ lang: best.detectedLanguage, confidence: best.confidence });
    },
  };
}

/**
 * The languages detected for a channel's latest comments, at most `max` (R60): what its
 * kanji-only comments are read as (`channelLanguageGuess`).
 */
export type LanguageMix = {
  add(this: void, lang: string): void;
  /** The share of `lang` among the counted comments, 0 when none is counted. */
  share(this: void, lang: string): number;
  size(this: void): number;
  clear(this: void): void;
};
/** Comments a channel's language mix counts: its latest 200. */
export const LANGUAGE_MIX_MAX = 200;

export function createLanguageMix(max = LANGUAGE_MIX_MAX): LanguageMix {
  // A ring of the latest languages and how often each occurs in it.
  const ring: string[] = [];
  let next = 0;
  const counts = new Map<string, number>();
  const change = (lang: string, by: number): void => {
    const count = (counts.get(lang) ?? 0) + by;
    if (count === 0) counts.delete(lang);
    else counts.set(lang, count);
  };
  return {
    add(lang) {
      const replaced = ring[next];
      if (replaced !== undefined) change(replaced, -1);
      ring[next] = lang;
      next = (next + 1) % max;
      change(lang, 1);
    },
    share: (lang) => (ring.length === 0 ? 0 : (counts.get(lang) ?? 0) / ring.length),
    size: () => ring.length,
    clear() {
      ring.length = 0;
      next = 0;
      counts.clear();
    },
  };
}

const HAN = /\p{Script=Han}/u;
/**
 * Han (and `〆`, which kanji text writes but Unicode puts in no script), digits, punctuation,
 * symbols (emoji), marks, format characters and spaces only.
 */
const KANJI_ONLY = /^[\p{Script=Han}〆\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u;
/** Text whose letters are all kanji (Han), at least one, with any digits and symbols (R60). */
export const isKanjiOnly = (text: string): boolean => HAN.test(text) && KANJI_ONLY.test(text);

/**
 * The language of a comment in its channel (R60): kanji-only text (`isKanjiOnly`) without a
 * Chinese character or word is Japanese when at least half of the channel's counted comments
 * (`mix`) are, so it is classified and not translated; any other guess stands. Kanji alone does
 * not tell Japanese from Chinese, and Japanese chat writes many such lines (`主人公`, `完璧`).
 */
export function channelLanguageGuess(
  text: string,
  guess: LanguageGuess,
  mix: LanguageMix,
): LanguageGuess {
  if (guess.lang === 'ja' || !isKanjiOnly(text) || chinese(text)) return guess;
  return mix.share('ja') >= 0.5 ? { lang: 'ja', confidence: 0.6 } : guess;
}

/** Japanese and undetermined text never need translating; everything else (incl. `und-Latn` and `und-Other`) does. */
export function needsTranslation(guess: LanguageGuess, _target: 'ja'): boolean {
  return guess.lang !== 'ja' && guess.lang !== 'und';
}
