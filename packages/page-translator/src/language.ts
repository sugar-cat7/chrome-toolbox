/**
 * The page's own language, `<html lang>` lowercased; `undefined` when it does not say. Only
 * kanji-only text needs it: kanji alone does not tell Japanese from Chinese.
 */
export function pageLangHint(doc: Document): string | undefined {
  const lang = doc.documentElement.getAttribute('lang')?.trim().toLowerCase();
  return lang === undefined || lang === '' ? undefined : lang;
}

const LETTER = /\p{L}/u;
/** Hiragana and katakana, with the long-vowel mark `ー` that both share. */
const KANA = /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
/** Kanji, with `々` and `〆`. */
const KANJI = /\p{Script_Extensions=Han}/u;
/** One word that is a web address. */
const URL_ONLY = /^(?:https?:\/\/|www\.)\S+$/iu;
const EMAIL_ONLY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/** A language tag whose language is Japanese (`ja`, `ja-jp`), not one that only starts so. */
const JAPANESE_TAG = /^ja(?:[-_]|$)/u;

/**
 * Whether a page text needs translating into Japanese, decided in this order:
 * 1. fewer than 2 letters (`\p{L}`): no;
 * 2. only a URL (`https?://` or `www.`, one word) or an e-mail address: no;
 * 3. some kana, and kana with kanji at least half of the letters: no (it is Japanese);
 * 4. letters all kanji: no when the page says it is Japanese (`hint`), yes otherwise;
 * 5. otherwise yes.
 * By share, not by any kana (extension-core's `scriptLanguageGuess`): an English paragraph that
 * quotes one Japanese word still needs translating.
 */
export function needsPageTranslation(text: string, hint: string | undefined): boolean {
  let letters = 0;
  let kana = 0;
  let kanji = 0;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    if (KANA.test(char)) kana += 1;
    else if (KANJI.test(char)) kanji += 1;
  }
  if (letters < 2) return false;
  const trimmed = text.trim();
  if (URL_ONLY.test(trimmed) || EMAIL_ONLY.test(trimmed)) return false;
  if (kana > 0 && 2 * (kana + kanji) >= letters) return false;
  if (kanji === letters) return hint === undefined || !JAPANESE_TAG.test(hint);
  return true;
}
