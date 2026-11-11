import {
  createLruCache,
  type CommentCategory,
  type LruCache,
} from '@chrome-toolbox/extension-core';

/**
 * The text a comment is compared by: NFKC (full-width to half-width), lower case, single spaces,
 * and any run of one non-digit character cut to three (`wwwwww` → `www`, `LETS GOOOOO` →
 * `lets gooo`). Digit runs stay whole, so `100000` and `1000000` remain different texts.
 */
export function normalizeComment(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/(\P{N})\1{3,}/gu, '$1$1$1');
}

/** Short stock reactions; one comment made of them alone is chatter without a model call. */
const REACTIONS = [
  'lol',
  'lmao',
  'www',
  'w',
  '草',
  'gg',
  '888',
  'kekw',
  'omegalul',
  'pog',
  'poggers',
  'ez',
  'f',
] as const;
type Reaction = (typeof REACTIONS)[number];
/** Reactions a Japanese viewer would not read at a glance; the rest stay in the original. */
const REACTION_TRANSLATIONS: Partial<Record<Reaction, string>> = {
  lol: '（笑）',
  lmao: '（爆笑）',
  kekw: '（笑）',
  omegalul: '（爆笑）',
  pog: 'すごい',
  poggers: 'すごい',
  ez: '楽勝',
};
/** Longer comments always go to the model, which also bounds the work per comment here. */
const MAX_TRIVIAL_LENGTH = 32;
/** Punctuation, symbols (emoji), marks and format characters such as the emoji ZWJ. */
const SYMBOLS = /[\p{P}\p{S}\p{M}\p{Cf}]/gu;
const DIGITS = /^\p{N}+$/u;

/**
 * A tier or score vote: one tier letter (`s`, `a+`), the same letter twice (`ss`), `sss`, or a
 * number with `点` (`10点`). Bare numbers are already chatter below.
 */
const TIER_VOTE = /^(?:([a-fs])\1?[+-]?|sss[+-]?|\p{N}{1,3}点)$/u;
/**
 * Only Latin letter or digit hashtags, at most 16 characters (`#pr`, `＃pr` after NFKC): a meme.
 * A Japanese hashtag may carry an insult and goes the normal way.
 */
const SHORT_HASHTAGS = /^(?:#[a-z0-9]+\s?)+$/u;
const MAX_HASHTAG_LENGTH = 16;

/** Emote spellings of a stock reaction (`LUL`, `PogU`), in lower case and squeezed. */
const REACTION_ALIASES: ReadonlyMap<string, Reaction> = new Map([
  ['lul', 'lol'],
  ['lulw', 'lol'],
  ['lolw', 'lol'],
  ['kekl', 'kekw'],
  ['pogu', 'pog'],
  ['pogchamp', 'pog'],
]);
/** Laughter spelt longer than its stock reaction (`lolol`, `lmfao`). */
const LONGER_LAUGHTER: readonly (readonly [RegExp, Reaction])[] = [
  [/^l+(?:o+l+)+$/u, 'lol'],
  [/^l+m+f*a+o+$/u, 'lmao'],
];
/** Each run of one character cut to one (`lmaooo` → `lmao`, `gg` → `g`). */
const squeezed = (word: string): string => word.replace(/(.)\1+/gsu, '$1');

/**
 * The stock reaction a lower-case word is: one repeated (`ww`, `gggg`), stretched (`lmaooo`,
 * `kekwww`), laughter spelt longer (`lolol`, `lmfao`) or an emote spelling of one (`LUL`, `PogU`).
 */
function reactionOf(word: string): Reaction | undefined {
  const repeated = REACTIONS.find(
    (reaction) =>
      word.length % reaction.length === 0 &&
      word === reaction.repeat(word.length / reaction.length),
  );
  if (repeated !== undefined) return repeated;
  const squeeze = squeezed(word);
  return (
    REACTIONS.find((reaction) => squeezed(reaction) === squeeze) ??
    REACTION_ALIASES.get(squeeze) ??
    LONGER_LAUGHTER.find(([pattern]) => pattern.test(word))?.[1]
  );
}

/**
 * A rule verdict for a stock reaction (`lol`, `www`, `草`, `gg`, `888`, `kekw` …, repeats,
 * stretches and emote spellings of one, with trailing punctuation) or a comment of digits and
 * symbols only; `normalized` comes from `normalizeComment`. Reactions that all read the same
 * (`kekw lul`) get that translation. An @mention is a name, never a reaction. Anything else needs
 * the model.
 */
export function trivialVerdict(
  normalized: string,
): { category: CommentCategory; translation?: string } | undefined {
  if (normalized === '' || normalized.length > MAX_TRIVIAL_LENGTH) return undefined;
  if (
    TIER_VOTE.test(normalized) ||
    (normalized.length <= MAX_HASHTAG_LENGTH && SHORT_HASHTAGS.test(normalized))
  )
    return { category: 'chatter' };
  const reactions = new Set<Reaction>();
  for (const word of normalized.split(' ')) {
    const letters = word.replace(SYMBOLS, '');
    if (letters === '' || DIGITS.test(letters)) continue;
    const reaction = word.startsWith('@') ? undefined : reactionOf(letters);
    if (reaction === undefined) return undefined;
    reactions.add(reaction);
  }
  const translations = new Set([...reactions].map((reaction) => REACTION_TRANSLATIONS[reaction]));
  const [translation] = translations.size === 1 ? translations : [];
  return { category: 'chatter', ...(translation === undefined ? {} : { translation }) };
}

/**
 * Widely used emote names of Twitch and the BTTV, FFZ and 7TV extensions (R39), matched as whole
 * tokens with their case. Common variants are listed one by one (`KEKW`, `KEKL`, `KEKWait`);
 * nothing is matched by pattern, so a word that merely looks like an emote still goes to the model.
 */
export const TWITCH_EMOTES: ReadonlySet<string> = new Set([
  // Twitch globals.
  ...['Kappa', 'Keepo', 'Kreygasm', 'PogChamp', 'LUL', 'BibleThump', 'ResidentSleeper'],
  ...['NotLikeThis', 'SeemsGood', 'VoHiYo', 'WutFace', 'DansGame', 'SwiftRage', 'BabyRage'],
  ...['FailFish', 'HeyGuys', 'CoolStoryBob', '4Head', 'Jebaited', 'CoolCat', 'PJSalt'],
  ...['MrDestructoid', 'HotPokket', 'BloodTrail', 'SMOrc', 'PogBones', 'GlitchCat', 'EleGiggle'],
  // Laughing.
  ...['KEKW', 'KEKL', 'KEKWait', 'OMEGALUL', 'LULW', 'LOLW', 'PepeLaugh', 'haHAA', 'ICANT'],
  ...['xdd', 'xddd'],
  // Hype and surprise.
  ...['Pog', 'PogU', 'PogO', 'POGGERS', 'Poggers', 'PauseChamp', 'WeirdChamp', 'EZ', 'Clap'],
  ...['GIGACHAD', 'NOWAYING', 'WAYTOODANK', 'HACKERMANS', 'AYAYA', 'RAGEY'],
  // Pepe and friends.
  ...['monkaS', 'monkaW', 'monkaHmm', 'monkaGIGA', 'monkaOMEGA', 'Pepega', 'PepeHands'],
  ...['FeelsBadMan', 'FeelsGoodMan', 'FeelsStrongMan', 'FeelsOkayMan', 'FeelsWeirdMan'],
  ...['FeelsDankMan', 'PepoG', 'PepoThink', 'peepoHappy', 'peepoSad', 'peepoClap', 'peepoLeave'],
  ...['peepoArrive', 'widepeepoHappy', 'widepeepoSad', '5Head', '3Head', 'Kapp'],
  // The -ge family and other moods.
  ...['Sadge', 'SadgeCry', 'Madge', 'Bedge', 'Okayge', 'Gladge', 'Susge', 'Hmmge', 'Prayge'],
  ...['Copege', 'Deadge', 'Wokege', 'Shruge', 'Aware', 'Clueless', 'Copium', 'Hopium', 'Stare'],
  ...['NODDERS', 'NOPERS', 'modCheck', 'Chatting', 'Listening', 'Corpa'],
  // Dancing.
  ...['catJAM', 'ratJAM', 'pepeD', 'pepeJAM', 'PepePls'],
]);
/**
 * Laughter in Latin letters, lower case: `haha`, `ahaha`, `hehe`, `jaja`, `lolol`, `lmao`, `xd`,
 * `kkkk`, `rsrs`, `wkwk`. One `ha` or `he` is no laugh (`he` is a word).
 */
const LAUGHTER_WORD =
  /^(?:a?(?:h+a+){2,}h*|(?:h+e+){2,}h*|(?:j+a+){2,}j*|(?:j+e+){2,}j*|l+o+l+(?:o+l+)*|lmf?a+o+|rofl|x+d+|k{4,}|(?:rs){2,}|(?:wk){2,}|(?:hue){2,})$/u;
/** Marks and format characters some chat tools add to dodge duplicate filters (U+034F, U+200B). */
const INVISIBLE = /[\p{M}\p{Cf}]/gu;
const TRAILING_PUNCTUATION = /\p{P}+$/u;

/**
 * The comment is made only of listed emotes (`TWITCH_EMOTES`, trailing punctuation allowed),
 * laughter (`hahaha`, `LMAOOO`, `xD`) and stock reactions, with digits, emoji and symbols between
 * them (R39): chatter by rule, shown untranslated, without the model or Clef. An @mention is a
 * name whatever it spells (`@xdd`), so a comment with one needs the model.
 */
export function isEmoteChatter(text: string): boolean {
  let reacted = false;
  for (const token of text.normalize('NFKC').replace(INVISIBLE, '').split(/\s+/u)) {
    if (token === '') continue;
    if (token.startsWith('@')) return false;
    if (TWITCH_EMOTES.has(token.replace(TRAILING_PUNCTUATION, ''))) {
      reacted = true;
      continue;
    }
    const letters = token.toLowerCase().replace(SYMBOLS, '');
    if (letters === '' || DIGITS.test(letters)) continue;
    if (reactionOf(letters) === undefined && !LAUGHTER_WORD.test(letters)) return false;
    reacted = true;
  }
  return reacted;
}

/**
 * Words that send a comment to Clef (R43). This is a router for Clef, not a verdict: Clef still
 * decides whether a comment with a cue is abusive, and a comment without one goes to Clef only
 * when the model calls it abusive. Self-written; insults, calls for death or violence, sexual
 * insults and slurs.
 *
 * - `ja`: regular expression sources matched anywhere in the text, as written and once long marks
 *   (`ー`, `〜`) are removed (`ばーか`). A guard such as `ばか(?!り|でか)` keeps a common harmless
 *   word (`ばかり`, `ばかでかい`) out, also a stream format named after the word (`馬鹿凸`,
 *   `バカ凸`, `ばかとつ`, `バカとつ`, R60); `しね` after hiragana counts only at the end or before
 *   punctuation or a laugh (`はよしね`), and not after a particle or ending (`だしね`, `わたしね`).
 * - `en`, `es`: whole words (or phrases), compared without case, width or accents, each letter
 *   possibly stretched (`stuuupid`) and a plural `s` or `es` allowed. A Spanish word in `-o` also
 *   matches its `-a` form (`pendeja`), and one ending in a consonant other than `s` takes an `-a`
 *   (`cabrona`).
 */
const ABUSE_CUES = {
  ja: [
    ...['ばか(?!り|でか|とつ)', 'バカ(?!ンス|ラ|凸|とつ)', '馬鹿(?!凸)', 'あほ(?![んど])'],
    ...['アホ', '阿呆', '[じジ][じジ][いイぃィー]', '[ばバ][ばバ][あアぁァー]', 'ガキ', '餓鬼'],
    ...['ゴミ(?!箱)', 'ごみ(?!箱)', 'カス(?![タテトケ])', 'クズ', '屑', 'デブ(?!リ)', 'でぶ'],
    ...['くず(?![れさしすせそもゆ])', 'ブス', 'ぶす(?!っ)', 'ブサイク', 'ぶさいく', '不細工'],
    ...['ハゲ', 'はげ(?![しま])', '禿', 'キモ(?![チノ])', 'きも(?![ちのん])', 'キッモ'],
    ...['きっも', 'きしょ(?!う)', 'キショ', 'きっしょ', '(?<![こそゆ])うざ', 'ウザ', 'うっざ'],
    // `うぜ`, but not a volitional + ぜ (`やろうぜ`).
    ...['(?<![おこごそぞとどのほぼぽもよろょ])うぜ', 'ウゼ', '雑魚', 'ざこ', 'ザコ'],
    ...['無能', '低能', 'クソ(?!面白|おもしろ|オモロ)', 'くそ(?!面白|おもしろ)', '糞'],
    ...['お前(?!ら)', 'おまえ(?!ら)', 'てめ(?![っち])', 'テメ', '貴様', 'きさま', '黙れ'],
    ...['だまれ', '静かにしろ', 'しずかにしろ', 'うるさい', 'うるせ', 'うっせ'],
    // Death and violence.
    ...['(?<![ぁ-ゖ])しね', '(?<![いたすだかもな])しね(?=$|[\\p{P}\\p{S}\\swｗ笑])', 'シネ(?!マ)'],
    ...['死ね', '4ね(?!ん)', '氏ね', 'タヒね', 'くたばれ'],
    ...['消えろ', 'きえろ', '失せろ', 'うせろ', '殺す', '殺せ', 'ころす', 'ころせ', 'コロス'],
    // Sexual insults.
    ...['まんこ', 'マンコ', 'ちんこ', 'チンコ', 'ちんぽ', 'チンポ', 'やりまん', 'ヤリマン'],
    ...['ビッチ', '売女', '肉便器', '淫乱', '犯す', '犯せ', 'レイプ'],
    // Slurs.
    ...['池沼', 'ガイジ(?!ン)', 'がいじ(?!ん)', 'チョン(?!ボ|マゲ)', '支那', '土人'],
    ...['ホモ(?!サピ)', 'オカマ'],
  ],
  en: [
    ...['idiot', 'stupid', 'dumb', 'dumbass', 'retard', 'retarded', 'moron', 'imbecile'],
    ...['loser', 'ugly', 'trash', 'garbage', 'clown', 'schizo', 'pathetic', 'scum', 'scumbag'],
    ...['braindead', 'incel', 'fatass', 'fatty', 'bitch', 'ass', 'asshole', 'jackass', 'cunt'],
    ...['slut', 'whore', 'shit', 'shitty', 'bullshit', 'dipshit', 'fuck', 'fucking', 'fuckin'],
    ...['fucked', 'fucker', 'motherfucker', 'fk', 'fking', 'fkin', 'fkn', 'fuk', 'fuking'],
    ...['fcking', 'stfu', 'gtfo', 'suck', 'sucked', 'sucking', 'sucker'],
    ...['hate', 'hated', 'hater'],
    // Death and violence.
    ...['die', 'kys', 'kill yourself', 'kill urself', 'hang yourself', 'rape', 'raped'],
    // Slurs.
    ...['nigger', 'nigga', 'chink', 'gook', 'spic', 'kike', 'wetback', 'beaner', 'paki', 'coon'],
    ...['faggot', 'fag', 'dyke', 'tranny'],
    // Emotes posted as slurs (left out of `TWITCH_EMOTES`).
    ...['gayge', 'trihard', 'cmonbruh', 'kkona'],
  ],
  es: [
    ...['idiota', 'estupido', 'pendejo', 'basura', 'mierda', 'puto', 'cabron', 'imbecil'],
    ...['maricon', 'marica', 'tonto', 'gilipollas', 'subnormal', 'retrasado', 'perra', 'zorra'],
    ...['culero', 'malparido', 'muerete', 'matate', 'callate'],
  ],
} as const;

/** A cue word as a pattern: each letter may be stretched, a doubled one stays doubled (`ass`). */
const stretchable = (word: string): string =>
  word.replace(/(\p{L})\1*/gu, (run, letter: string) =>
    run.length === 1 ? `${letter}+` : `${letter}{${run.length},}`,
  );
/** A Spanish cue that also matches its other gender: `-o` as `-a`, `cabron` as `cabrona`. */
const gendered = (word: string): string => {
  if (word.endsWith('o')) return `${stretchable(word.slice(0, -1))}[oa]+`;
  return /[^aeious]$/u.test(word) ? `${stretchable(word)}a*` : stretchable(word);
};
const JAPANESE_CUE = new RegExp(ABUSE_CUES.ja.join('|'), 'u');
const LATIN_WORDS = [...ABUSE_CUES.en.map(stretchable), ...ABUSE_CUES.es.map(gendered)].join('|');
/** A whole cue word or phrase among space-separated words, a plural `s` or `es` allowed. */
const LATIN_CUE = new RegExp(`(?:^| )(?:${LATIN_WORDS})(?:e*s+)?(?= |$)`, 'u');
const LONG_MARKS = /[ー〜~]/gu;

/**
 * Whether the comment holds an abuse cue (`ABUSE_CUES`) outside its @mentions (R43): such a
 * comment goes to Clef while the model runs. `normalized` comes from `normalizeComment`
 * (full width, case, stretches cut to three), so every copy of a text is routed alike.
 */
export function hasAbuseCue(normalized: string): boolean {
  const text = normalized
    .split(' ')
    .filter((token) => !token.startsWith('@'))
    .join(' ');
  if (JAPANESE_CUE.test(text) || JAPANESE_CUE.test(text.replace(LONG_MARKS, ''))) return true;
  // Latin words only, without accents: `¡idiota!` → `idiota`, `estúpido` → `estupido`.
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{Script=Latin}]+/u)
    .filter((word) => word !== '')
    .join(' ');
  return LATIN_CUE.test(words);
}

const LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;
/** Japanese or Chinese script: the question guard never judges such a comment. */
const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/** A question mark in any width, or the Spanish opening one. */
const QUESTION_MARK = /[?？¿]/u;
/** English and Spanish question words (`por qué` counts by its `qué`). */
const QUESTION_WORDS: ReadonlySet<string> = new Set([
  ...['who', 'what', 'when', 'where', 'why', 'how', 'which', 'is', 'are', 'am', 'do', 'does'],
  ...['did', 'can', 'could', 'would', 'will', 'should', 'have', 'has'],
  ...['qué', 'cómo', 'cuándo', 'dónde', 'quién'],
]);
/** Words that address the chat before the comment says anything (`chat, is this real`). */
const VOCATIVES: ReadonlySet<string> = new Set(['chat', 'guys', 'bro']);
/** A token that looks like an emote name: a lower-case letter followed by a capital (`PauseChamp`). */
const EMOTE = /^[\p{L}\p{N}]*\p{Ll}\p{Lu}[\p{L}\p{N}]*$/u;
/** How many words after the leading vocatives and emotes may hold the question word. */
const QUESTION_WORD_REACH = 3;
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
/** The letters a token starts with, lower case (`What's` → `what`, `¿qué` → `qué`). */
const leadingWord = (token: string): string =>
  /^\P{L}*(\p{L}+)/u.exec(token.toLowerCase())?.[1] ?? '';
const skippable = (token: string): boolean =>
  token.startsWith('@') || VOCATIVES.has(leadingWord(token)) || EMOTE.test(token);

/** Latin interjections that read as a reaction, not a question, with `?` after them (R60). */
const INTERJECTIONS: ReadonlySet<string> = new Set([
  ...['what', 'huh', 'um', 'uh', 'eh', 'wtf', 'omg', 'bruh', 'wait'],
]);
/** One Latin word with nothing but `?` and `!` after it (after NFKC). */
const ONE_WORD = /^(\p{Script=Latin}+)[?!]*$/u;
/**
 * The comment is one interjection (`INTERJECTIONS`, any case, stretched letters collapsed) with
 * nothing but `?` and `!` after it (`WHAT??`, `UM????`, `huhhh?!`): a reaction (R60).
 */
const isInterjection = (normalized: string): boolean => {
  const word = ONE_WORD.exec(normalized)?.[1];
  return word !== undefined && INTERJECTIONS.has(squeezed(word.toLowerCase()));
};

/**
 * Whether a question verdict may stand for the comment (R38, R40). A comment mostly in Latin
 * script (mention letters aside) needs a question mark (`?`, `？`, `¿`) or a question word
 * (`what`, `do`, `cómo` …) within its first three words, after any leading @mentions,
 * vocatives (`chat`, `guys`, `bro`) and emote names (`PauseChamp`), and never is one
 * interjection with only `?` and `!` after it (`WHAT??`, R60; `why?` is a question word). A
 * comment with any Hiragana, Katakana or Han, one mostly in another script and one without
 * letters always may.
 */
export function mayBeQuestion(text: string): boolean {
  if (CJK.test(text)) return true;
  const normalized = text.normalize('NFKC').trim();
  if (isInterjection(normalized)) return false;
  const tokens = normalized.split(/\s+/u);
  const words = tokens.filter((token) => !token.startsWith('@')).join(' ');
  const letters = count(words, LETTER);
  if (letters === 0 || count(words, LATIN_LETTER) * 2 <= letters) return true;
  if (QUESTION_MARK.test(text)) return true;
  const start = tokens.findIndex((token) => !skippable(token));
  if (start === -1) return false;
  return tokens
    .slice(start, start + QUESTION_WORD_REACH)
    .some((token) => QUESTION_WORDS.has(leadingWord(token)));
}

/**
 * The comment ends with a question mark, in any width, perhaps followed by `!`, a laugh (`w`,
 * `笑`) and spaces or format characters (`what?!`, `まだ？ｗ`).
 */
export const endsAsQuestion = (text: string): boolean => /[?？][!！wWｗＷ笑\s\p{Cf}]*$/u.test(text);

/** A URL with a scheme or `www.`; a bare `name.tld/path` is too often something else. */
const LINK = /\bhttps?:\/\/\S|\bwww\.\S/iu;
/** The comment carries a link. */
export const hasLink = (text: string): boolean => LINK.test(text);

/**
 * The comment as the model reads it (R40): a letter written 3 or more times in a row, in any
 * case, is written twice (`vamoooos` → `vamoos`), so the model translates the word instead of
 * copying the stretch. `normalizeComment` cuts the same runs to three, so texts with one cache
 * key send one model input. Links and @mentions stay as written: the model copies them, and the
 * display removes them from the translation only when they match the page's own text.
 */
export const unstretched = (text: string): string =>
  text.replace(/\S+/gu, (token) =>
    token.startsWith('@') || LINK.test(token) ? token : token.replace(/(\p{L})\1{2,}/giu, '$1$1'),
  );

/** Characters laughter and elongation are made of, in any script (`www`, `草`, `ははは`, `jaja`, `ㅋㅋ`). */
const LAUGHTER = /^[wｗ草笑はハふフひヒへヘほホーｰ～〜━哈ㅋㅎhajrskeoxdu]+$/u;
const MIN_UNIT = 6;
const MIN_TOTAL = 20;
const IGNORED = /[\s\p{P}\p{S}\p{M}\p{Cf}]/gu;
/** Text without spaces and marks, each run of one character cut to one (`gooo` → `go`). */
const collapsed = (text: string): string => text.replace(IGNORED, '').replace(/(.)\1+/gsu, '$1');
/** The shortest piece the text repeats whole (`ナイスナイス` → `ナイス`), else the text. */
const rootOf = (text: string): string => /^(.+?)\1*$/su.exec(text)?.[1] ?? text;

/** What may stand between two copies of a phrase, up to 2 of them: a space or a mark. */
const SEPARATOR = /^[\s\p{P}]$/u;
const ASCII_SEPARATORS: readonly boolean[] = Array.from({ length: 128 }, (_unused, code) =>
  SEPARATOR.test(String.fromCharCode(code)),
);
const isSeparator = (point: number): boolean =>
  point < 128 ? ASCII_SEPARATORS[point] === true : SEPARATOR.test(String.fromCodePoint(point));
/** 31 to the power `MIN_UNIT - 1`: takes the oldest code unit out of a run's rolling hash. */
const OLDEST_FACTOR = 31 ** (MIN_UNIT - 1);

/**
 * The runs of `MIN_UNIT` UTF-16 code units (overlapping, by start), linked by a 32-bit hash: for
 * each, the next later run with the same hash, -1 for none. Undefined when no hash is had by 3
 * runs. Equal runs have equal hashes, so a run that occurs 3 times is always found; a collision
 * only adds a start to search.
 */
function linkedRuns(text: string): Int32Array | undefined {
  const runs = text.length - MIN_UNIT + 1;
  let bits = 3;
  while (1 << bits < runs * 2) bits += 1;
  const mask = (1 << bits) - 1;
  // An open-addressing table: per slot a hash, its latest run + 1 (0 when empty) and its runs.
  const table = new Int32Array(3 << bits);
  const next = new Int32Array(runs).fill(-1);
  let repeated = false;
  let hash = 0;
  for (let i = 0; i < MIN_UNIT - 1; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  for (let i = 0; i < runs; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i + MIN_UNIT - 1)) | 0;
    let slot = Math.imul(hash, 0x9e3779b1) >>> (32 - bits);
    while ((table[3 * slot + 1] ?? 0) !== 0 && table[3 * slot] !== hash) slot = (slot + 1) & mask;
    const latest = (table[3 * slot + 1] ?? 0) - 1;
    if (latest !== -1) next[latest] = i;
    const seen = (table[3 * slot + 2] ?? 0) + 1;
    if (seen >= 3) repeated = true;
    table[3 * slot] = hash;
    table[3 * slot + 1] = i + 1;
    table[3 * slot + 2] = seen;
    // The oldest code unit leaves the run.
    hash = (hash - Math.imul(text.charCodeAt(i), OLDEST_FACTOR)) | 0;
  }
  return repeated ? next : undefined;
}

/**
 * A text as code points, what the pattern `(.{6,}?)(?:[\s\p{P}]{0,2}\1){2,}` (sticky, `su`)
 * matches by: each point, the UTF-16 index where each starts (and the length after the last),
 * the point that starts at each UTF-16 index (-1 inside a surrogate pair) and which points are
 * separators (0 not yet known, 1 yes, 2 no).
 */
type Points = Readonly<{
  points: Int32Array;
  starts: Int32Array;
  pointAt: Int32Array;
  separators: Int8Array;
}>;
function pointsOf(text: string): Points {
  const points = new Int32Array(text.length);
  const starts = new Int32Array(text.length + 1);
  const pointAt = new Int32Array(text.length).fill(-1);
  let count = 0;
  for (let unit = 0; unit < text.length; count += 1) {
    const point = text.codePointAt(unit) ?? 0;
    points[count] = point;
    starts[count] = unit;
    pointAt[unit] = count;
    unit += point > 0xffff ? 2 : 1;
  }
  starts[count] = text.length;
  return {
    points: points.subarray(0, count),
    starts: starts.subarray(0, count + 1),
    pointAt,
    separators: new Int8Array(count),
  };
}
function separatorAt(text: Points, at: number): boolean {
  if (at >= text.points.length) return false;
  if (text.separators[at] === 0) text.separators[at] = isSeparator(text.points[at] ?? 0) ? 1 : 2;
  return text.separators[at] === 1;
}
/** `[\s\p{P}]{0,2}` at `at`: the separators it takes first (greedy). */
const gapAt = (text: Points, at: number): number =>
  separatorAt(text, at) ? (separatorAt(text, at + 1) ? 2 : 1) : 0;
/** The `size` points from `from` occur again at `at` (`\1`). */
function copyAt(text: Points, from: number, at: number, size: number): boolean {
  if (at + size > text.points.length) return false;
  for (let i = 0; i < size; i += 1) if (text.points[at + i] !== text.points[from + i]) return false;
  return true;
}
/**
 * Where the first 2 copies of the unit `[start, start + size)` end, each after up to 2
 * separators, the most first (`(?:[\s\p{P}]{0,2}\1){2}`, backtracking as it does); -1 when
 * they do not follow.
 */
function secondCopyEnd(text: Points, start: number, size: number): number {
  const first = start + size;
  for (let one = gapAt(text, first); one >= 0; one -= 1) {
    if (!copyAt(text, start, first + one, size)) continue;
    const second = first + one + size;
    for (let two = gapAt(text, second); two >= 0; two -= 1)
      if (copyAt(text, start, second + two, size)) return second + two + size;
  }
  return -1;
}
/** Where the copies after `end` stop, each after the most separators that let one follow (`{2,}`). */
function lastCopyEnd(text: Points, start: number, size: number, end: number): number {
  let at = end;
  for (;;) {
    let next = -1;
    for (let skip = gapAt(text, at); skip >= 0 && next === -1; skip -= 1)
      if (copyAt(text, start, at + skip, size)) next = at + skip + size;
    if (next === -1) return at;
    at = next;
  }
}
/**
 * The unit the lazy pattern takes at `start`: the fewest points, from 6 up to a third of the
 * points from `start` on (a longer one cannot fit 3 times), whose 2 copies follow. A copy starts
 * with the unit's first 6 code units, so a unit can only end where a later run equal to the one
 * at `start` starts (`linkedRuns`), or 1 or 2 separators before it; only those lengths are
 * tried.
 * Undefined when none fits.
 */
function lazyUnit(
  text: Points,
  next: Int32Array,
  start: number,
  most: number,
): { size: number; end: number } | undefined {
  let best: { size: number; end: number } | undefined;
  const run = text.starts[start] ?? 0;
  for (let at = next[run] ?? -1; at !== -1; at = next[at] ?? -1) {
    const copy = text.pointAt[at] ?? -1;
    if (copy === -1) continue;
    // The lengths this copy allows, shortest first; a later copy allows none shorter than these.
    const shortest = copy - 2 - start;
    if (shortest > most || (best !== undefined && shortest >= best.size)) break;
    for (let skip = 2; skip >= 0; skip -= 1) {
      const size = copy - skip - start;
      if (size < MIN_UNIT || size > most || (best !== undefined && size >= best.size)) continue;
      if (skip > 0 && !separatorAt(text, copy - 1)) continue;
      if (skip > 1 && !separatorAt(text, copy - 2)) continue;
      const end = secondCopyEnd(text, start, size);
      if (end === -1) continue;
      best = { size, end };
      break;
    }
  }
  return best;
}

/**
 * Copypasta: one phrase of at least 6 characters (elongations collapsed) repeated 3 or more
 * times in a row, 20 or more characters repeated in all, anywhere in the comment. Everyday
 * cheering (`ナイスナイスナイス`, `nice nice nice`) is a shorter word however often it repeats,
 * and laughter in any script never counts. Every start position may hold one, so a leading laugh
 * hides no pasted slogan and makes none; `normalized` comes from `normalizeComment`.
 *
 * The answer is that of the pattern `(.{6,}?)(?:[\s\p{P}]{0,2}\1){2,}` tried at every start
 * (R45), found faster (R60). A phrase found at a start has 6 or more code points there and twice
 * more after it, so the 6 code units at that start occur twice more later (`linkedRuns`, linear),
 * and only such starts are searched (a start inside a surrogate pair is searched from the pair's
 * first half, as the pattern is). There the phrase is at most a third of the code points from the
 * start on, and only lengths at which a later copy can start are tried (`lazyUnit`).
 */
export function isCopypasta(normalized: string): boolean {
  if (normalized.length < 3 * MIN_UNIT) return false;
  const runs = linkedRuns(normalized);
  if (runs === undefined) return false;
  const text = pointsOf(normalized);
  const count = text.points.length;
  for (let start = 0; start < count; start += 1) {
    const most = Math.floor((count - start) / 3);
    if (most < MIN_UNIT) return false;
    // The run at the start occurs twice more later.
    const later = runs[text.starts[start] ?? 0] ?? -1;
    if (later === -1 || (runs[later] ?? -1) === -1) continue;
    const unit = lazyUnit(text, runs, start, most);
    if (unit === undefined) continue;
    const from = text.starts[start] ?? 0;
    const letters = collapsed(normalized.slice(from, text.starts[start + unit.size]));
    if (rootOf(letters).length < MIN_UNIT || LAUGHTER.test(letters)) continue;
    const end = lastCopyEnd(text, start, unit.size, unit.end);
    if (collapsed(normalized.slice(from, text.starts[end])).length >= MIN_TOTAL) return true;
  }
  return false;
}

/**
 * A finished verdict reused for a later comment with the same normalized text. `category` is
 * the model's own: Clef's score and the channel's feedback decide the shown one each time.
 */
export type CachedVerdict = Readonly<{
  lang: string;
  category: CommentCategory;
  translation?: string | undefined;
  abusive?: number | undefined;
}>;
/** Normalized texts the model has answered; repeats and copy-paste skip the model and Clef. */
export const TEXT_CACHE_MAX = 2000;
export const createTextCache = (): LruCache<string, CachedVerdict> =>
  createLruCache<string, CachedVerdict>({ max: TEXT_CACHE_MAX });
