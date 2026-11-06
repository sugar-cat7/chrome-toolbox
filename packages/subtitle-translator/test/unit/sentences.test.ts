import { describe, expect, it } from 'vitest';
import { SENTENCE_LIMITS, toSentences } from '../../src/captions/sentences.ts';
import type { Cue } from '../../src/captions/tracks.ts';
import { contextHash } from '../../src/page-context.ts';

const c = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });
/** One word of `n` letters. */
const chars = (n: number, letter = 'a'): string => letter.repeat(n);

describe('caption sentences', () => {
  it.each([
    {
      name: '句点で区切る',
      cues: [c(0, 900, 'Okay chat,'), c(900, 2000, "we're going in.")],
      sentences: ["Okay chat, we're going in."],
    },
    {
      name: '700ms の間で区切る',
      cues: [c(0, 1000, 'hi'), c(1800, 2500, 'there')],
      sentences: ['hi', 'there'],
    },
    {
      name: 'ちょうど 700ms の間で区切る',
      cues: [c(0, 1000, 'hi'), c(1700, 2500, 'there')],
      sentences: ['hi', 'there'],
    },
    {
      name: '699ms の間は区切らない',
      cues: [c(0, 1000, 'hi'), c(1699, 2500, 'there')],
      sentences: ['hi there'],
    },
    {
      name: '6 秒で区切る',
      cues: Array.from({ length: 8 }, (_, i) => c(i * 1000, i * 1000 + 1000, 'word')),
      sentences: ['word word word word word word', 'word word'],
    },
    {
      name: '疑問符、感嘆符、全角の記号と閉じ括弧',
      cues: [
        c(0, 500, 'Ready?'),
        c(500, 1000, 'Go!'),
        c(1000, 1500, 'いくよ。'),
        c(1500, 2000, 'ほんと？'),
        c(2000, 2500, 'やった！'),
        c(2500, 3000, 'He said "run."'),
        c(3000, 3500, 'okay'),
      ],
      sentences: ['Ready?', 'Go!', 'いくよ。', 'ほんと？', 'やった！', 'He said "run."', 'okay'],
    },
    {
      name: '200 文字を超える前に区切る',
      cues: [c(0, 100, chars(99)), c(100, 200, chars(100, 'b')), c(200, 300, chars(10, 'c'))],
      sentences: [`${chars(99)} ${chars(100, 'b')}`, chars(10, 'c')],
    },
    {
      name: '前後の空白を除き、空白だけの cue は捨てる',
      cues: [c(0, 500, '  hi  '), c(500, 900, '   '), c(900, 1200, 'there.')],
      sentences: ['hi there.'],
    },
    {
      name: '時刻の順に並べ直す',
      cues: [c(1000, 2000, 'second.'), c(0, 900, 'first.')],
      sentences: ['first.', 'second.'],
    },
  ])('toSentences: $name', ({ cues, sentences }) => {
    expect(toSentences(cues).map((sentence) => sentence.source)).toEqual(sentences);
  });

  it.each([
    {
      name: 'zh: 漢字の間は空けない',
      lang: 'zh-Hans',
      cues: [c(0, 900, '我们今天'), c(900, 2000, '去打游戏。')],
      sentences: ['我们今天去打游戏。'],
    },
    {
      name: 'ja: かなと漢字、句読点の間は空けない',
      lang: 'ja',
      cues: [c(0, 700, 'よし、今日は'), c(700, 1400, 'ダンジョンに'), c(1400, 2000, '行くぞ！')],
      sentences: ['よし、今日はダンジョンに行くぞ！'],
    },
    {
      name: 'ko: ハングルの語の間は空ける',
      lang: 'ko',
      cues: [c(0, 900, '안녕하세요'), c(900, 2000, '여러분 반가워요.')],
      sentences: ['안녕하세요 여러분 반가워요.'],
    },
    {
      name: 'ko: 韓国語のトラックでは漢字どうしの間も空ける',
      lang: 'ko',
      cues: [c(0, 900, '오늘은 漢字'), c(900, 2000, '學習 시간.')],
      sentences: ['오늘은 漢字 學習 시간.'],
    },
    {
      name: 'ハングルの隣は、言語が分からなくても空ける',
      lang: undefined,
      cues: [c(0, 900, '오늘은 漢字'), c(900, 2000, '공부.')],
      sentences: ['오늘은 漢字 공부.'],
    },
    {
      name: 'en: 空白で区切る',
      lang: 'en',
      cues: [c(0, 900, 'Okay chat,'), c(900, 2000, "we're going in.")],
      sentences: ["Okay chat, we're going in."],
    },
    {
      name: 'en と ja が混ざる: 日本語の隣だけ空けない',
      lang: 'ja',
      cues: [
        c(0, 500, 'Nice'),
        c(500, 1000, 'ナイス'),
        c(1000, 1500, 'GG'),
        c(1500, 2000, 'everyone「おつ」'),
        c(2000, 2600, 'bye.'),
      ],
      sentences: ['NiceナイスGG everyone「おつ」bye.'],
    },
    {
      name: 'ja: 全角の括弧の隣も空けない',
      lang: 'ja',
      cues: [c(0, 900, 'やった（笑）'), c(900, 2000, 'GG.')],
      sentences: ['やった（笑）GG.'],
    },
    {
      name: '空けずに続けた 200 文字は 1 文に入る',
      lang: 'ja',
      cues: [c(0, 100, chars(100, 'あ')), c(100, 200, chars(100, 'い')), c(200, 300, 'う')],
      sentences: [`${chars(100, 'あ')}${chars(100, 'い')}`, 'う'],
    },
  ])('toSentences joins CJK without a space: $name', ({ lang, cues, sentences }) => {
    expect(toSentences(cues, lang).map((sentence) => sentence.source)).toEqual(sentences);
  });

  it('keeps the time span of the cues and names each sentence by its start and source', () => {
    expect(toSentences([c(500, 900, 'Okay chat,'), c(900, 2000, "we're going in.")])).toEqual([
      {
        id: `500:${contextHash("Okay chat, we're going in.")}`,
        startMs: 500,
        endMs: 2000,
        source: "Okay chat, we're going in.",
      },
    ]);
  });

  it('splits a cue longer than 200 characters at spaces, sharing its time by length', () => {
    // Five-letter words: the 200th character falls inside the 34th word.
    const words = Array.from({ length: 50 }, (_, i) => `w${String(i).padStart(4, '0')}`);
    const text = words.join(' ');
    expect(text).toHaveLength(299);
    const sentences = toSentences([c(1000, 3990, text)]);
    expect(sentences.map((sentence) => sentence.source)).toEqual([
      words.slice(0, 33).join(' '),
      words.slice(33).join(' '),
    ]);
    for (const sentence of sentences)
      expect(sentence.source.length).toBeLessThanOrEqual(SENTENCE_LIMITS.chars);
    // 197 and 101 characters of 298: the cut falls at 1000 + 2990 × 197 / 298.
    expect(sentences.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [1000, 2977],
      [2977, 3990],
    ]);
  });

  it('cuts a cue without spaces at 200 characters, keeping surrogate pairs whole', () => {
    const text = `${chars(199)}😀${chars(50, 'b')}`;
    const sentences = toSentences([c(0, 1000, text)]);
    expect(sentences.map((sentence) => sentence.source)).toEqual([
      chars(199),
      `😀${chars(50, 'b')}`,
    ]);
  });
});
