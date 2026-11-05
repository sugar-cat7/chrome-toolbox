import { describe, expect, it } from 'vitest';
import {
  createTextCache,
  endsAsQuestion,
  hasAbuseCue,
  hasLink,
  isCopypasta,
  isEmoteChatter,
  mayBeQuestion,
  normalizeComment,
  trivialVerdict,
  TWITCH_EMOTES,
  unstretched,
} from '../../src/fastpath.ts';

/** A seeded random number generator in [0, 1) (mulberry32), so a failure can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T => {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('nothing to pick');
  return item;
};
/**
 * Characters copypasta tests are made of: letters, kana, laughter, emoji, spaces, marks, and the
 * combining acute accent, combining dakuten and zero-width joiner (one character each, none a
 * whole letter).
 */
const PIECES = [
  ...['a', 'b', 'c', 'h', 'w', 'あ', 'い', 'ナ', '草', '😀', ' ', '!', ',', '、', 'ー'],
  ...['\u0301', '\u3099', '\u200d'],
];
/** Any short text over few characters, so 6-character pieces repeat often. */
const randomText = (random: () => number): string =>
  Array.from({ length: Math.floor(random() * 120) }, () => pick(random, PIECES)).join('');
/** A phrase pasted 2 to 5 times, with separators and text around it. */
function pasted(random: () => number): string {
  const phrase = Array.from({ length: 3 + Math.floor(random() * 10) }, () =>
    pick(random, PIECES),
  ).join('');
  const copies = Array.from({ length: 2 + Math.floor(random() * 4) }, () => phrase);
  const joined = copies.reduce(
    (text, copy) => text + pick(random, ['', ' ', ', ', '!', '  ', '、 ']) + copy,
  );
  return `${randomText(random).slice(0, 12)}${joined}${randomText(random).slice(0, 12)}`;
}
/**
 * isCopypasta as it was before the counted search (R45): the regular expression tried at every
 * start position. The reference the counted search must agree with.
 */
function fullSearch(normalized: string): boolean {
  const repeated = /(.{6,}?)(?:[\s\p{P}]{0,2}\1){2,}/suy;
  const laughter = /^[wｗ草笑はハふフひヒへヘほホーｰ～〜━哈ㅋㅎhajrskeoxdu]+$/u;
  const collapse = (text: string): string =>
    text.replace(/[\s\p{P}\p{S}\p{M}\p{Cf}]/gu, '').replace(/(.)\1+/gsu, '$1');
  const rootOf = (text: string): string => /^(.+?)\1*$/su.exec(text)?.[1] ?? text;
  for (let start = 0; start < normalized.length; start += 1) {
    repeated.lastIndex = start;
    const match = repeated.exec(normalized);
    const unit = match?.[1];
    if (match === null || unit === undefined) continue;
    const letters = collapse(unit);
    if (rootOf(letters).length >= 6 && collapse(match[0]).length >= 20 && !laughter.test(letters))
      return true;
  }
  return false;
}

describe('normalizeComment', () => {
  it.each([
    { input: 'wwwwww', expected: 'www' },
    { input: 'LETS GOOOOO', expected: 'lets gooo' },
    { input: 'ＬＯＬ', expected: 'lol' },
    { input: 'ｗｗｗｗｗ', expected: 'www' },
    // Digit runs stay whole: 100000 and 1000000 must not share a cache key.
    { input: '８８８８８', expected: '88888' },
    { input: 'Congrats on 100000 subs!', expected: 'congrats on 100000 subs!' },
    { input: 'Congrats on 1000000 subs!', expected: 'congrats on 1000000 subs!' },
    { input: '٣٣٣٣٣', expected: '٣٣٣٣٣' },
    { input: '草草草草草', expected: '草草草' },
    { input: '🔥🔥🔥🔥', expected: '🔥🔥🔥' },
    { input: 'Kiara!!!!!', expected: 'kiara!!!' },
    { input: '  gg \t\n  wp  ', expected: 'gg wp' },
    { input: 'ｈｅｌｌｏ　ｗｏｒｌｄ', expected: 'hello world' },
    { input: 'nice play', expected: 'nice play' },
    { input: 'aa bb', expected: 'aa bb' },
  ])('$input -> $expected', ({ input, expected }) => {
    expect(normalizeComment(input)).toBe(expected);
  });
});

describe('trivialVerdict', () => {
  it.each([
    { text: 'lol', translation: '（笑）' },
    { text: 'lmao', translation: '（爆笑）' },
    { text: 'kekw', translation: '（笑）' },
    { text: 'omegalul', translation: '（爆笑）' },
    { text: 'pog', translation: 'すごい' },
    { text: 'poggers', translation: 'すごい' },
    { text: 'ez', translation: '楽勝' },
    { text: 'www', translation: undefined },
    { text: 'w', translation: undefined },
    { text: '草', translation: undefined },
    { text: 'gg', translation: undefined },
    { text: '888', translation: undefined },
    { text: '8888888', translation: undefined },
    { text: 'f', translation: undefined },
    { text: '?', translation: undefined },
    { text: '!', translation: undefined },
    { text: '12345', translation: undefined },
    { text: '10/10', translation: undefined },
    { text: '1:23:45', translation: undefined },
    { text: '🔥 100', translation: undefined },
    // Repeats of one reaction and trailing punctuation are the same reaction.
    { text: 'lol lol', translation: '（笑）' },
    { text: 'lol!', translation: '（笑）' },
    { text: 'ww', translation: undefined },
    { text: '草草草', translation: undefined },
    { text: 'gg ez', translation: undefined },
    // Stretched and longer laughter, and emote variants, read as their stock reaction (R43).
    { text: 'lmaooo', translation: '（爆笑）' },
    { text: 'lmfao', translation: '（爆笑）' },
    { text: 'lmfaooo!!', translation: '（爆笑）' },
    { text: 'loool', translation: '（笑）' },
    { text: 'lolol', translation: '（笑）' },
    { text: 'lololol lol', translation: '（笑）' },
    { text: 'kekwww', translation: '（笑）' },
    { text: 'omegaluuul', translation: '（爆笑）' },
    { text: 'poggg', translation: 'すごい' },
    { text: 'pogggers', translation: 'すごい' },
    { text: 'ezzz', translation: '楽勝' },
    { text: 'ggg', translation: undefined },
    { text: 'lul', translation: '（笑）' },
    { text: 'lulw', translation: '（笑）' },
    { text: 'kekl', translation: '（笑）' },
    { text: 'pogu', translation: 'すごい' },
    { text: 'pogchamp', translation: 'すごい' },
    // Reactions that all read the same are translated together.
    { text: 'kekw lul', translation: '（笑）' },
    { text: 'lol lmao', translation: undefined },
  ])('$text is chatter without a model call', ({ text, translation }) => {
    expect(trivialVerdict(text)).toEqual({
      category: 'chatter',
      ...(translation === undefined ? {} : { translation }),
    });
  });

  it.each([
    'lol that was close',
    'gg wp',
    'f in chat',
    'hello',
    'w8',
    'when is the next stream?',
    // A mention is a name, whatever it spells.
    '@lol',
    '@kekw',
    'lol @bob',
    '',
    `${'lol '.repeat(40)}lol`,
  ])('%s needs the model', (text) => {
    expect(trivialVerdict(text)).toBeUndefined();
  });
});

describe('tier votes and hashtag memes (R31)', () => {
  it.each([
    'S',
    'A',
    'B',
    'F',
    'A+',
    'S-',
    'SS',
    'ｓｓ',
    'ＳＳＳ',
    'Ａ＋',
    '5',
    '10',
    '10点',
    '８点',
    '#PR',
    '＃pr',
    '＃ad',
    '#gg',
    '#pr #ad',
  ])('%s is chatter without a model call', (text) => {
    expect(trivialVerdict(normalizeComment(text))).toEqual({ category: 'chatter' });
  });

  it.each([
    'sa',
    'ab',
    'no',
    'ad',
    'S tier',
    's+++',
    '100点満点',
    '#this-is-a-very-long-hashtag',
    '#pr is back',
    'nice #pr',
    // A Japanese hashtag may carry an insult: it goes the normal way (Clef and the model).
    '#ネタ',
    '＃ネタ',
    '#pr #ネタ',
  ])('%s still needs the model', (text) => {
    expect(trivialVerdict(normalizeComment(text))).toBeUndefined();
  });
});

describe('isEmoteChatter (R39)', () => {
  it('lists about 100 emote names', () => {
    expect(TWITCH_EMOTES.size).toBeGreaterThanOrEqual(90);
    expect(TWITCH_EMOTES.size).toBeLessThanOrEqual(130);
    for (const name of ['KEKW', 'PauseChamp', 'monkaS', 'catJAM', 'xdd', 'peepoHappy'])
      expect(TWITCH_EMOTES.has(name)).toBe(true);
  });

  it.each([
    'KEKW',
    'PauseChamp',
    'monkaS',
    'Sadge',
    'catJAM',
    'xdd',
    'PogU',
    'KEKW KEKW KEKW',
    'LUL OMEGALUL',
    'EZ Clap',
    // A wall of one emote is a reaction, not copypasta.
    'catJAM catJAM catJAM catJAM catJAM catJAM catJAM catJAM',
    // Laughter and stock reactions beside the emotes.
    'PepeLaugh LMAOOOO',
    'Clueless lol',
    'KEKW gg',
    'hahahaha PogChamp',
    // Laughter alone.
    'hahahaha',
    'HAHAHA',
    'ahahaha',
    'jajajaja',
    'JAJAJ',
    'hehehe',
    'LMAOOOO',
    'lmfao',
    'lolol',
    'xD',
    'XDDD',
    'kkkkkk',
    'rsrsrs',
    'wkwkwk',
    // Trailing punctuation, emoji, full width and invisible characters around the names.
    'Pog!',
    'Aware...',
    'PogU 🔥',
    'ＫＥＫＷ',
    'Prayge ͏',
    'KEKW​',
    // Stock reactions in any case, stretched or spelt as an emote (R43).
    'kekw lul',
    'KEKWW',
  ])('%s is chatter by rule', (text) => {
    expect(isEmoteChatter(text)).toBe(true);
  });

  it.each([
    '',
    '?',
    '12345',
    // Emote names are case-sensitive.
    'pausechamp',
    'PAUSECHAMP',
    'monkas',
    'sadge copium',
    // Only listed variants, no patterns.
    'PauseChampion',
    'Kappa123',
    'monkaSS',
    'Sadgee',
    // Words beside the emotes need the model.
    'KEKW that was close',
    'Clueless he said',
    'trash KEKW',
    'hahahaha you are bad',
    'jaja que malo',
    '@Kappa',
    // A mention whose name is laughter or a reaction is not one (R43).
    '@xdd',
    '@lol',
    '@KEKW',
    '@hahaha KEKW',
    // Not laughter.
    'he',
    'ha',
    'hello',
    'haha8',
  ])('%s needs the model', (text) => {
    expect(isEmoteChatter(text)).toBe(false);
  });
});

describe('hasAbuseCue (R43)', () => {
  it.each([
    // Japanese: anywhere in the text, katakana, hiragana or kanji, long marks and stretches.
    'ばーか',
    'ばーーーか',
    'バカじゃないの',
    '馬鹿だな',
    'アホすぎ',
    'あほか',
    'このジジイ',
    'ババアうるさい',
    // The long mark itself may end the word.
    'このババー',
    'ジジーかよ',
    'ガキは寝ろ',
    'ゴミプレイ',
    'ｶｽが',
    'クズすぎる',
    'デブ',
    'ブスじゃん',
    'ハゲ',
    '消えろ',
    '失せろ',
    'しね',
    'お前しね',
    '死ね',
    '４ね',
    '氏ね',
    'タヒね',
    'しねえええええ',
    // At the end, or before punctuation, a laugh or 笑, also after hiragana.
    'はよしね',
    'さっさとしね',
    'まじでしね',
    'まじでしねw',
    'まじでしね笑',
    'もういいからしね！',
    '殺すぞ',
    'うざい',
    'うっざ',
    'まじうぜー',
    'キモい',
    'きもっ',
    '雑魚',
    'ざこすぎ',
    '下手くそ',
    '黙れ',
    '静かにしろ',
    'うるせえ',
    'うるさい',
    'ガイジ',
    '池沼',
    'クソゲー',
    '糞',
    'お前さあ',
    'てめえ',
    'テメー',
    '貴様',
    'ヤリマン',
    // English: whole words, any case or width, stretched, plural.
    'you idiot',
    'IDIOT!!!',
    'IDIOOOOOOT',
    'idiots',
    'ＩＤＩＯＴ',
    'stuuuupid',
    'so dumb',
    'retard',
    'moron',
    'holy shit',
    'fuck',
    'fucking hell',
    'bitch',
    'what an ass',
    'asshole',
    'trash',
    'garbage player',
    'loser',
    'ugly',
    'kys',
    'go die',
    'i hate this guy',
    'STFU',
    'clown',
    'schizo',
    'pathetic',
    'this sucks',
    'kill yourself',
    'faggot',
    'this fking boss',
    'fk off',
    // Emotes posted as slurs.
    'Gayge',
    'TriHard 7',
    '@streamer you idiot',
    'idiot😂',
    'バカidiot',
    // The format name guards only itself (R60).
    '馬鹿凸に来るな馬鹿',
    'バカ凸のバカ',
    // Spanish: whole words, with or without accents, either gender, plural, ¡ and ¿.
    'idiota',
    'eres un idiota',
    '¡idiota!',
    '¿estúpido?',
    'ESTUPIDA',
    'estúpidas',
    'pendejo',
    'PENDEJAAA',
    'basura',
    'mierda',
    'puta',
    'puto',
    'cabrón',
    'cabrona',
    'cabrones',
    'imbécil',
  ])('%s has an abuse cue', (text) => {
    expect(hasAbuseCue(normalizeComment(text))).toBe(true);
  });

  it.each([
    '',
    'nice play',
    'hello there',
    'GG',
    'こんにちは',
    'ナイス',
    '草',
    'がんばれ',
    'お疲れ様',
    // Harmless words that hold a Japanese cue.
    'こればかりだね',
    'バカンス行きたい',
    'カスタムいいね',
    'カステラ食べたい',
    'はげしい戦い',
    '気持ちいい',
    'じゃあほんとに',
    'まあほどほどに',
    'わたしね、思うんだけど',
    'そうですしね',
    'かわいいしね',
    'もう言ったしね',
    'それもそうだしね',
    'もしね、勝てたら',
    'それはなしね',
    'むかしね',
    // Let's (volitional + ぜ).
    'いこうぜ',
    'やろうぜ',
    '勝とうぜ',
    '超絶うまい',
    'ちょうぜつ',
    // Harmless words that hold a cue, guarded where it is simple.
    'くそ面白い',
    'クソおもしろい',
    'お前ら元気？',
    'ばかでかい',
    'カスケード',
    'ごみ箱',
    'ゴミ箱',
    '見てめっちゃ笑った',
    '口座開設した',
    'シネマで見た',
    'いきものがかり',
    // A stream format named after the word (R60).
    '馬鹿凸',
    'バカ凸',
    'ばかとつ',
    'バカとつ',
    '今日は馬鹿凸の日',
    'ﾊﾞｶ凸たのしみ',
    'バカ凸きたー',
    // English words that contain a cue but are not one.
    'as if',
    'assist',
    'class act',
    'pass',
    'what a badass play',
    'diet',
    'he died lol',
    'hateful',
    'dumbbell',
    'shiitake',
    'trashcan',
    'niger river',
    'scunthorpe',
    // A mention is a name.
    '@trash_panda hi',
    '@idiot',
    // Spanish look-alikes.
    'buen día',
    'basurero',
    'vamos',
  ])('%s has no abuse cue', (text) => {
    expect(hasAbuseCue(normalizeComment(text))).toBe(false);
  });
});

describe('isCopypasta (R33)', () => {
  const promo = 'subscribe to the channel and follow the link in the description';
  it.each([
    `${promo} ${promo} ${promo}`,
    'follow the link follow the link follow the link follow the link',
    'buy my merch today buy my merch today buy my merch today',
    'チャンネル登録とグッズ購入はこちらチャンネル登録とグッズ購入はこちらチャンネル登録とグッズ購入はこちら',
    // A leading laugh does not hide the slogan.
    `hahahahaha ${promo} ${promo} ${promo}`,
    `www ${promo}, ${promo}, ${promo}!`,
  ])('%s is copypasta', (text) => {
    expect(isCopypasta(normalizeComment(text))).toBe(true);
  });

  it.each([
    '草生える草生える草生える',
    'ナイスナイスナイス',
    'ナイス！ナイス！ナイス！',
    'かわいいかわいいかわいい',
    'がんばれがんばれがんばれ',
    'おめでとうおめでとうおめでとう',
    'きたきたきた',
    'キタキタキタ━',
    'すごいすごいすごい',
    'まってまってまって',
    'うおおおうおおおうおおお',
    'あははあははあはは',
    'うふふうふふうふふ',
    'www草www草www草',
    'やばいやばいやばい',
    'go go go',
    'no no no',
    'nice nice nice',
    'lets go lets go lets go',
    'LETS GOOOO LETS GOOOO LETS GOOOO',
    'omg omg omg',
    'jajaja',
    'rsrsrs',
    'hahahahahahahahahahahahaha',
    'hello hello',
    'ahahahahaha',
    'wkwkwkwk',
    'ok ok ok',
    'ははははは',
    '草草草草草',
    '!?!?!?!?',
    '123123123',
    'nice play, what game is this?',
    // A leading laugh does not make an ordinary comment copypasta.
    'hahahahahaha that was great',
    // A short cheer stays a cheer however often it repeats.
    'ナイス'.repeat(10),
    'かわいい'.repeat(8),
    'がんばれ！'.repeat(8),
    'go '.repeat(12),
    'nice! '.repeat(10),
    '',
  ])('%s is not', (text) => {
    expect(isCopypasta(normalizeComment(text))).toBe(false);
  });

  it('stays fast on the longest comment without any repeated phrase (worst case)', () => {
    const words = Array.from({ length: 200 }, (_unused, i) => `w${(i * 7919) % 1000}x`);
    const text = normalizeComment(words.join(' ')).slice(0, 1000);
    expect(text).toHaveLength(1000);
    const start = performance.now();
    expect(isCopypasta(text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('answers as the full search does (every start position tried), on random and constructed texts', () => {
    const random = seeded(20261030);
    const cases: string[] = [];
    for (let i = 0; i < 1500; i += 1) cases.push(randomText(random));
    for (let i = 0; i < 1500; i += 1) cases.push(pasted(random));
    const texts = cases.flatMap((text) => [text, normalizeComment(text)]);
    expect(texts.filter((text) => isCopypasta(text) !== fullSearch(text))).toEqual([]);
    // Both answers occur, so the comparison means something.
    expect(cases.some((text) => fullSearch(text))).toBe(true);
    expect(cases.some((text) => !fullSearch(text))).toBe(true);
  });

  it('answers as the full search does with lone surrogates, astral punctuation and wide spaces (R60)', () => {
    const random = seeded(20261102);
    const pieces = ['a', 'b', '😀', '\ud83d', '\ude00', ' ', '!', 'ー', '\u{10100}', '　'];
    const texts: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      const phrase = Array.from({ length: 3 + Math.floor(random() * 10) }, () =>
        pick(random, pieces),
      ).join('');
      const copies = Array.from({ length: 1 + Math.floor(random() * 4) }, () => phrase);
      const around = (): string =>
        Array.from({ length: Math.floor(random() * 8) }, () => pick(random, pieces)).join('');
      texts.push(
        around() + copies.reduce((text, copy) => text + pick(random, ['', ' ', '!', '　 ']) + copy),
      );
    }
    expect(texts.filter((text) => isCopypasta(text) !== fullSearch(text))).toEqual([]);
    expect(texts.some((text) => fullSearch(text))).toBe(true);
    expect(texts.some((text) => !fullSearch(text))).toBe(true);
  });

  it.each([
    // The unit fits 3 times in what follows its start, or it is no match (R60): at most a
    // third of it, counted in code points.
    { text: 'abcdefgabcdefgabcdefg', expected: true },
    { text: 'abcdefgabcdefgabcdef', expected: false },
    { text: 'ab😀cdefgab😀cdefgab😀cdefg', expected: true },
    { text: 'ab😀cdefgab😀cdefgab😀cdef', expected: false },
    { text: '😀😀😀abcdefg😀abcdefg😀abcdefg', expected: true },
    { text: 'xyz abcdefgabcdefgabcdefg', expected: true },
    { text: 'xyz abcdefgabcdefgabcdef', expected: false },
    { text: `${'xy'.repeat(10)}abcdefgabcdefgabcdefg`, expected: true },
    // Up to 2 spaces or marks between copies; a third one belongs to the unit.
    { text: 'abcdefg! abcdefg! abcdefg', expected: true },
    { text: 'abcdefg!  abcdefg!  abcdefg', expected: false },
    { text: 'abc defg abc defg abc defg', expected: true },
    { text: 'abcdefgh abcdefgh abcdefgh', expected: true },
    // 18 characters repeated, then a cut copy: under 20 in all.
    { text: 'abcdefabcdefabcdefab', expected: false },
    { text: 'abcdefabcdefabcdefabc', expected: false },
  ])(
    'answers $text as the full search does at the length bound: $expected',
    ({ text, expected }) => {
      expect(fullSearch(text)).toBe(expected);
      expect(isCopypasta(text)).toBe(expected);
    },
  );

  it('takes under 0.2 ms on 1,000 characters of English chat (R60)', () => {
    const random = seeded(60);
    const words = [
      ...['the', 'a', 'to', 'and', 'of', 'is', 'it', 'that', 'you', 'this', 'was', 'for', 'on'],
      ...['are', 'with', 'be', 'at', 'have', 'not', 'what', 'but', 'can', 'all', 'so', 'just'],
      ...['like', 'do', 'your', 'get', 'go', 'one', 'if', 'out', 'up', 'we', 'they', 'no', 'lol'],
      ...['when', 'how', 'time', 'good', 'know', 'there', 'great', 'game', 'play', 'nice', 'chat'],
      ...['boss', 'level', 'run', 'gg', 'wait', 'yeah', 'really', 'think', 'why', 'see', 'right'],
      ...['win', 'lose', 'fight', 'map', 'team', 'look', 'next', 'song', 'more', 'back', 'maybe'],
    ];
    let chat = '';
    while (chat.length < 1000) chat += `${pick(random, words)}${random() < 0.1 ? '. ' : ' '}`;
    const text = normalizeComment(chat).slice(0, 1000);
    expect(text).toHaveLength(1000);
    expect(isCopypasta(text)).toBe(fullSearch(text));
    // The fastest of 20 runs: the search over every unit length took 0.42 ms on this text, the
    // search over only the lengths a later copy allows, up to a third, 0.012 ms (R60).
    let fastest = Infinity;
    for (let run = 0; run < 20; run += 1) {
      const start = performance.now();
      isCopypasta(text);
      fastest = Math.min(fastest, performance.now() - start);
    }
    // The bound leaves room for a loaded runner and still fails the old search's 0.42 ms.
    expect(fastest).toBeLessThan(0.2);
  });

  it.each([
    { script: 'Latin', alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789' },
    {
      script: 'kana',
      alphabet: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも',
    },
  ])(
    'takes under half a millisecond on 1,000 $script characters with no repeated phrase',
    ({ alphabet }) => {
      const random = seeded(7);
      const text = Array.from({ length: 1000 }, () => pick(random, Array.from(alphabet))).join('');
      expect(fullSearch(text)).toBe(false);
      // The fastest of 20 runs: the full search took 2 ms (Latin) and 8.5 ms (kana) on these texts,
      // the counted search 0.04 ms (R45).
      let fastest = Infinity;
      for (let run = 0; run < 20; run += 1) {
        const start = performance.now();
        expect(isCopypasta(text)).toBe(false);
        fastest = Math.min(fastest, performance.now() - start);
      }
      expect(fastest).toBeLessThan(0.5);
    },
  );
});

describe('mayBeQuestion (R38)', () => {
  it.each([
    // A question mark anywhere, in any width, or the Spanish opening mark.
    'the boss has two phases?',
    'two phases? really',
    'two phases？',
    '¿la segunda fase',
    // A question word first (after any mentions).
    'what level is this',
    'how did you get past that',
    'Is this the last stage',
    'can you show the map again',
    'do you play ranked',
    'have you beaten it before',
    '@sample_viewer which route is faster',
    '@a @b why not left',
    // A question word within the first three words, after a vocative or an emote (R40).
    'chat can we try that',
    'guys what is this song',
    'bro how',
    'Chat, is this real',
    'PauseChamp is it time',
    'SpeedLaugh chat is this real',
    'so what happened',
    'ok so why left',
    'cómo se llama el juego',
    'dónde está la llave',
    'por qué no saltas',
    'quién ganó',
    'qué hora es',
    'cuándo empieza',
    // Not mostly Latin script: the guard never applies (Japanese, Korean, Russian).
    'このボスどうやって倒すの',
    '次の曲お願い',
    'GG ナイス判断どうやったの',
    '다음 곡 해주세요',
    'покажи карту',
    // Any Hiragana, Katakana or Han: never (R40).
    'Valorantやらないの',
    'Apex rankいくの',
    'next gameなに',
    '@fixture_viewer_one 何時まで配信するの',
    'Valorant什么时候玩',
    'Fixture Speedrun Any Percent ガチ',
    // Mention letters do not count as Latin.
    '@fixture_viewer_with_a_long_name 다음 곡 해주세요',
    // No letters to judge by.
    '2',
    // A question word, or more than one word, stays a question (R60).
    'why?',
    'WHY??',
    'who?',
    'where?',
    'how?!',
    'what is this?',
    'wait what?',
    'what happened',
    'huh? which map',
    '@sample_viewer what?',
  ])('%s may be a question', (text) => {
    expect(mayBeQuestion(text)).toBe(true);
  });

  it.each([
    'play the next song please',
    'switch to the desert map',
    'need more ammo',
    'try the left door',
    'that was amazing',
    'i think he goes left',
    'whatever you say',
    'island level next',
    'doesnt matter',
    "don't go there",
    'howdy chat',
    '@sample_viewer go left',
    'vamos',
    'que bonito',
    'como siempre',
    'chat look at this',
    'PauseChamp lets go',
    'KEKW KEKW',
    'he goes left now is fine',
    'guys guys guys',
    // One interjection with nothing but ? and ! after it, in any case or width, stretched (R60).
    'WHAT??',
    'what?',
    'what',
    'Whaaaat?!',
    'UM????',
    'umm?',
    'uh?',
    'huh?',
    'HUHHH?!?!',
    'eh?',
    'wtf??',
    'WTF!?',
    'omg?!',
    'OMGGG!!',
    'bruh?',
    'BRUHHHH??',
    'wait?',
    'waaait!?',
    'ＷＨＡＴ？？',
    ' what?? ',
  ])('%s is no question', (text) => {
    expect(mayBeQuestion(text)).toBe(false);
  });
});

describe('endsAsQuestion (R38)', () => {
  it.each([
    ['is this the last stage?', true],
    ['まだ？', true],
    ['really??  ', true],
    ['what?!', true],
    ['まだ？ｗ', true],
    ['まだ？ｗｗ笑', true],
    ['is it over?\u200b', true],
    ['really?! ', true],
    ['two phases? really', false],
    ['next song', false],
    ['why!', false],
  ] as const)('%s -> %s', (text, expected) => {
    expect(endsAsQuestion(text)).toBe(expected);
  });
});

describe('hasLink (R38)', () => {
  it.each([
    ['now playing → https://example.com/watch/fixture', true],
    ['rules at http://example.com', true],
    ['see www.example.com for more', true],
    ['short link https://youtu.be/fixture0001', true],
    // Only a scheme or www. makes a link (R40).
    ['clip: example.tv/fixture-clip', false],
    ['node.js/deno', false],
    ['Mr.Bean/joke', false],
    ['rate it 9/10', false],
    ['and/or', false],
    ['the score was 10.5/11', false],
    ['nice play', false],
  ] as const)('%s -> %s', (text, expected) => {
    expect(hasLink(text)).toBe(expected);
  });
});

describe('unstretched (R40)', () => {
  it.each([
    ['vamoooos', 'vamoos'],
    ['LETSGOOOO', 'LETSGOO'],
    ['VAMOOOOSSSS!!!!', 'VAMOOSS!!!!'],
    ['OOoo', 'OO'],
    ['かわいいいいい', 'かわいい'],
    ['wwwww', 'ww'],
    ['good', 'good'],
    ['100000', '100000'],
    ['nice play', 'nice play'],
    // Links and mentions reach the model as written, so the display can match its kept elements.
    ['see www.example.com nooooo', 'see www.example.com noo'],
    ['@Zooooey sooooo good', '@Zooooey soo good'],
    ['https://example.com/aaaa wooow', 'https://example.com/aaaa woow'],
  ])('%s -> %s', (text, expected) => {
    expect(unstretched(text)).toBe(expected);
  });

  it.each([
    'VAMOOOOOS',
    'vamooos',
    'LETS GOOOO',
    'ＬＥＴＳ　ＧＯＯＯＯＯ',
    'OOoo',
    'wwwwww',
    '草草草草',
    'yesss!!!!',
  ])('keeps the model input a function of the cache key: %s', (text) => {
    // Texts with the same cache key send the same model input (up to case and width).
    expect(normalizeComment(unstretched(text))).toBe(unstretched(normalizeComment(text)));
  });
});

describe('text cache', () => {
  it('keeps the 2000 most recently used texts', () => {
    const cache = createTextCache();
    for (let i = 0; i < 2001; i += 1)
      cache.set(`text ${i}`, { lang: 'und-Latn', category: 'chatter' });
    expect(cache.size()).toBe(2000);
    expect(cache.get('text 0')).toBeUndefined();
    expect(cache.get('text 2000')).toEqual({ lang: 'und-Latn', category: 'chatter' });
  });
});
