// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { needsPageTranslation, pageLangHint } from '../../src/language.ts';

afterEach(() => {
  document.documentElement.removeAttribute('lang');
});

describe('needsPageTranslation', () => {
  it.each([
    { text: 'Phase 2 begins at 50% HP.', hint: undefined, needs: true },
    { text: '第2形態は体力が半分で始まる。', hint: undefined, needs: false },
    { text: 'The word かわいい means cute.', hint: undefined, needs: true },
    { text: '東京', hint: 'ja', needs: false },
    { text: '东京天气', hint: 'zh-cn', needs: true },
    { text: '東京', hint: undefined, needs: true },
    { text: 'Q', hint: undefined, needs: false },
    { text: '42 / 100', hint: undefined, needs: false },
    { text: 'https://wiki.fixture.test/bosses', hint: undefined, needs: false },
    { text: '안녕하세요 여러분', hint: 'ja', needs: true },
    // Rule 2 covers the bare host form and an e-mail address, not a sentence holding a URL.
    { text: 'www.fixture.test', hint: undefined, needs: false },
    { text: 'guides@wiki.fixture.test', hint: undefined, needs: false },
    { text: 'See https://wiki.fixture.test/bosses for more', hint: undefined, needs: true },
    // Rule 3: kana and kanji at least half of the letters; the long-vowel mark counts as kana.
    { text: 'ゲーム DLC', hint: undefined, needs: false },
    { text: 'HP is ゲージ', hint: undefined, needs: true },
    // Rule 4: a region subtag still says Japanese; a language that only starts with "ja" does not.
    { text: '東京', hint: 'ja-jp', needs: false },
    { text: '東京', hint: 'jam', needs: true },
  ])('needsPageTranslation($text, $hint) is $needs', ({ text, hint, needs }) => {
    expect(needsPageTranslation(text, hint)).toBe(needs);
  });
});

describe('pageLangHint', () => {
  it.each([
    { lang: 'ja-JP', hint: 'ja-jp' },
    { lang: ' EN ', hint: 'en' },
    { lang: '', hint: undefined },
    { lang: undefined, hint: undefined },
  ])('reads <html lang="$lang"> as $hint', ({ lang, hint }) => {
    if (lang !== undefined) document.documentElement.setAttribute('lang', lang);
    expect(pageLangHint(document)).toBe(hint);
  });
});
