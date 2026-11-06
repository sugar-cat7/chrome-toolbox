import { describe, expect, it, vi } from 'vitest';
import {
  channelLanguageGuess,
  createLanguageDetector,
  createLanguageMix,
  isKanjiOnly,
  LANGUAGE_MIX_MAX,
  needsTranslation,
  scriptLanguageGuess,
} from './language.ts';

type Candidate = { detectedLanguage: string; confidence: number };
const adapter = (candidates: Candidate[]) => {
  const detect = vi.fn<(text: string) => Promise<Candidate[]>>(async () => candidates);
  const create = vi.fn<() => Promise<{ detect: typeof detect }>>(async () => ({ detect }));
  return { create, detect };
};
const value = <T>(result: { ok: boolean; value?: T }): T | undefined =>
  result.ok ? result.value : undefined;

describe('script language guess', () => {
  it.each([
    { text: 'こんにちは', lang: 'ja', confidence: 0.9 },
    { text: 'コメント', lang: 'ja', confidence: 0.9 },
    { text: '日本語の配信ありがとう', lang: 'ja', confidence: 0.9 },
    { text: '안녕하세요', lang: 'ko', confidence: 0.9 },
    { text: '你好', lang: 'zh', confidence: 0.5 },
    { text: '你好世界', lang: 'zh', confidence: 0.5 },
    // Kanji-only Japanese: full-width laughter, full-width ！？, marks only Japanese uses.
    { text: '倍以上ｗ', lang: 'ja', confidence: 0.6 },
    { text: '3回行動！？', lang: 'ja', confidence: 0.6 },
    { text: '三回行動！', lang: 'ja', confidence: 0.6 },
    { text: '時々', lang: 'ja', confidence: 0.6 },
    { text: '本日〜', lang: 'ja', confidence: 0.6 },
    // A short kanji text that ends in half-width laughter.
    { text: '反対側w', lang: 'ja', confidence: 0.6 },
    { text: '反対側 www', lang: 'ja', confidence: 0.6 },
    // Kanji-only Japanese words that contain a character Chinese chat also uses.
    { text: '了解！', lang: 'ja', confidence: 0.6 },
    { text: '我慢！', lang: 'ja', confidence: 0.6 },
    { text: '是非！', lang: 'ja', confidence: 0.6 },
    { text: '圧倒的！', lang: 'ja', confidence: 0.6 },
    // Chinese shares the full-width punctuation: a simplified form, a pronoun or particle, or a
    // Chinese word keeps the text Chinese, so it is still translated.
    { text: '你好！', lang: 'zh', confidence: 0.5 },
    { text: '真的吗？', lang: 'zh', confidence: 0.5 },
    { text: '加油！', lang: 'zh', confidence: 0.5 },
    { text: '太强了！', lang: 'zh', confidence: 0.5 },
    { text: '厉害！', lang: 'zh', confidence: 0.5 },
    { text: '笑死我了！', lang: 'zh', confidence: 0.5 },
    { text: '真的假的？', lang: 'zh', confidence: 0.5 },
    { text: '主播好帅！', lang: 'zh', confidence: 0.5 },
    { text: '我也是！', lang: 'zh', confidence: 0.5 },
    { text: '他很稳！', lang: 'zh', confidence: 0.5 },
    { text: '欢迎回来！', lang: 'zh', confidence: 0.5 },
    { text: '好看啦！', lang: 'zh', confidence: 0.5 },
    { text: '加油w', lang: 'zh', confidence: 0.5 },
    // Other Latin letters, or a long text, are no laughter hint.
    { text: '反対側wow', lang: 'zh', confidence: 0.5 },
    { text: `${'漢'.repeat(32)}w`, lang: 'zh', confidence: 0.5 },
    { text: 'gg wp', lang: 'und-Latn', confidence: 0.3 },
    { text: 'Привет всем', lang: 'und-Other', confidence: 0.3 },
    { text: 'สวัสดีครับ', lang: 'und-Other', confidence: 0.3 },
    { text: 'مرحبا بالجميع', lang: 'und-Other', confidence: 0.3 },
    { text: 'नमस्ते दोस्तों', lang: 'und-Other', confidence: 0.3 },
    { text: 'gg Привет', lang: 'und-Other', confidence: 0.3 },
    { text: 'gg wp Ж', lang: 'und-Latn', confidence: 0.3 },
    { text: '🔥🔥', lang: 'und', confidence: 0 },
    { text: '888 123', lang: 'und', confidence: 0 },
    { text: '', lang: 'und', confidence: 0 },
  ])('$text -> $lang', ({ text, lang, confidence }) => {
    expect(scriptLanguageGuess(text)).toEqual({ lang, confidence });
  });
});

describe('translation need', () => {
  it.each([
    { lang: 'ja', expected: false },
    { lang: 'und', expected: false },
    { lang: 'en', expected: true },
    { lang: 'und-Latn', expected: true },
    { lang: 'und-Other', expected: true },
    { lang: 'zh', expected: true },
  ])('$lang -> $expected', ({ lang, expected }) => {
    expect(needsTranslation({ lang, confidence: 1 }, 'ja')).toBe(expected);
  });
});

describe('language detector', () => {
  it('adopts the on-device result when confident', async () => {
    const api = adapter([{ detectedLanguage: 'id', confidence: 0.92 }]);
    const detector = createLanguageDetector(api);
    expect(value(await detector.detect('terima kasih'))).toEqual({ lang: 'id', confidence: 0.92 });
  });

  it('falls back to the script guess below 0.5 confidence or without candidates', async () => {
    const low = createLanguageDetector(adapter([{ detectedLanguage: 'id', confidence: 0.4 }]));
    const none = createLanguageDetector(adapter([]));
    expect(value(await low.detect('gg wp'))).toEqual({ lang: 'und-Latn', confidence: 0.3 });
    expect(value(await none.detect('こんにちは'))).toEqual({ lang: 'ja', confidence: 0.9 });
  });

  it('falls back to the script guess without an adapter', async () => {
    const detector = createLanguageDetector(undefined);
    expect(value(await detector.detect('안녕하세요'))).toEqual({ lang: 'ko', confidence: 0.9 });
  });

  it('creates the on-device detector once', async () => {
    const api = adapter([{ detectedLanguage: 'en', confidence: 0.99 }]);
    const detector = createLanguageDetector(api);
    await Promise.all([detector.detect('a'), detector.detect('b')]);
    await detector.detect('c');
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.detect).toHaveBeenCalledTimes(3);
  });

  it('caches a failed create and keeps falling back', async () => {
    const create = vi.fn<() => Promise<{ detect(text: string): Promise<Candidate[]> }>>(
      async () => {
        throw new Error('unavailable');
      },
    );
    const detector = createLanguageDetector({ create });
    expect(value(await detector.detect('gg'))).toEqual({ lang: 'und-Latn', confidence: 0.3 });
    expect(value(await detector.detect('gg'))).toEqual({ lang: 'und-Latn', confidence: 0.3 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('falls back when detect fails', async () => {
    const detector = createLanguageDetector({
      create: async () => ({
        detect: async (): Promise<Candidate[]> => {
          throw new Error('boom');
        },
      }),
    });
    expect(value(await detector.detect('你好'))).toEqual({ lang: 'zh', confidence: 0.5 });
  });
});

describe('kanji-only text (R60)', () => {
  it.each([
    ['主人公', true],
    ['完璧', true],
    ['完璧！', true],
    ['大勝利!!', true],
    ['第2形態', true],
    ['３回目', true],
    ['時々', true],
    ['〆切', true],
    ['神回 🔥', true],
    ['草 草', true],
    // Kana, Latin or Hangul letters make it something else.
    ['主人公だ', false],
    ['完璧ー', false],
    ['完璧ｗ', false],
    ['神 gg', false],
    ['대박', false],
    ['123!', false],
    ['', false],
  ] as const)('%s -> %s', (text, expected) => {
    expect(isKanjiOnly(text)).toBe(expected);
  });
});

describe('language mix of a channel (R60)', () => {
  it('counts the latest detected languages and gives the share of one', () => {
    const mix = createLanguageMix();
    expect(mix.share('ja')).toBe(0);
    mix.add('ja');
    mix.add('ja');
    mix.add('und-Latn');
    mix.add('zh');
    expect(mix.size()).toBe(4);
    expect(mix.share('ja')).toBe(0.5);
    expect(mix.share('zh')).toBe(0.25);
    expect(mix.share('ko')).toBe(0);
  });

  it(`keeps only the latest ${LANGUAGE_MIX_MAX}`, () => {
    const mix = createLanguageMix();
    for (let i = 0; i < LANGUAGE_MIX_MAX; i += 1) mix.add('ja');
    for (let i = 0; i < 150; i += 1) mix.add('und-Latn');
    expect(mix.size()).toBe(LANGUAGE_MIX_MAX);
    expect(mix.share('ja')).toBe(0.25);
    expect(mix.share('und-Latn')).toBe(0.75);
    for (let i = 0; i < LANGUAGE_MIX_MAX; i += 1) mix.add('zh');
    expect(mix.share('ja')).toBe(0);
    expect(mix.share('zh')).toBe(1);
  });

  it('forgets everything on clear', () => {
    const mix = createLanguageMix(3);
    mix.add('ja');
    mix.add('ja');
    mix.clear();
    expect(mix.size()).toBe(0);
    expect(mix.share('ja')).toBe(0);
    mix.add('zh');
    expect(mix.share('zh')).toBe(1);
  });
});

describe('language of a comment in its channel (R60)', () => {
  const zh = { lang: 'zh', confidence: 0.5 };
  /** A mix of `ja` Japanese and `other` English comments. */
  const mixOf = (ja: number, other: number) => {
    const mix = createLanguageMix();
    for (let i = 0; i < ja; i += 1) mix.add('ja');
    for (let i = 0; i < other; i += 1) mix.add('und-Latn');
    return mix;
  };

  it.each([
    // At least half of the channel's comments are Japanese: kanji-only text is Japanese.
    { text: '主人公', ja: 5, other: 5, expected: 'ja' },
    { text: '完璧！', ja: 9, other: 1, expected: 'ja' },
    { text: '第2形態 🔥', ja: 1, other: 0, expected: 'ja' },
    // Less than half, or nothing counted yet: the guess stands.
    { text: '主人公', ja: 4, other: 5, expected: 'zh' },
    { text: '主人公', ja: 0, other: 0, expected: 'zh' },
    // A Chinese character or word keeps it Chinese, however Japanese the channel.
    { text: '你好', ja: 10, other: 0, expected: 'zh' },
    { text: '加油！', ja: 10, other: 0, expected: 'zh' },
    { text: '太强了', ja: 10, other: 0, expected: 'zh' },
    // Not kanji-only: the guess stands.
    { text: 'gg 主人公', ja: 10, other: 0, expected: 'zh' },
  ])(
    '$text in a channel with $ja Japanese of $other others -> $expected',
    ({ text, ja, other, expected }) => {
      const guessed = channelLanguageGuess(text, zh, mixOf(ja, other));
      expect(guessed.lang).toBe(expected);
      expect(needsTranslation(guessed, 'ja')).toBe(expected !== 'ja');
    },
  );

  it('keeps a Japanese guess and any guess for other text as it is', () => {
    const mix = mixOf(10, 0);
    const ja = { lang: 'ja', confidence: 0.9 };
    expect(channelLanguageGuess('主人公', ja, mix)).toBe(ja);
    const en = { lang: 'en', confidence: 0.9 };
    expect(channelLanguageGuess('nice play', en, mix)).toBe(en);
  });
});
