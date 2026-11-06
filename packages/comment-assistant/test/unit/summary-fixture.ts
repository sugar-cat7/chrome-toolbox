// A made-up, varied chat for the summary equality test (summary.test.ts): every state, the hidden
// categories, translations present and absent, several languages, repeated texts in other widths
// and cases, over 35 minutes. Seeded, so the same records come out each time; the expected
// summaries in ../fixtures/summary-ca380e6.json were made from these records by the code of
// ca380e6, before R45.
import type { CommentRecord } from '@chrome-toolbox/extension-core';

export const SUMMARY_NOW = Date.UTC(2026, 9, 30, 12, 0, 30);
/** The model's reply when it answers: topics, a merged question and two burst headings. */
export const SUMMARY_REPLY = 'T ボス戦の話\nT 次の配信\nQ 1,2 ボスの順番\nP1 開幕\nP2 撃破\n';

const TEXTS = [
  'which boss is next?',
  'Which boss is next?',
  'what game is this?',
  '¿qué juego es?',
  'that dodge was clean',
  'THAT DODGE WAS CLEAN',
  'ｔｈａｔ ｄｏｄｇｅ ｗａｓ ｃｌｅａｎ',
  'LETS GOOOOOO',
  'lets gooo',
  'gg',
  'lol',
  '🔥🔥',
  '!!!',
  'stream starts at nine tomorrow',
  'the ending is the twin, made-up spoiler',
  'buy cheap made-up coins now',
  'you are a made-up insult',
  '初見です',
  '今のは上手い',
  '次はどのボスに行くの？',
  'お知らせ: 明日も配信',
] as const;
const CATEGORIES = ['chatter', 'question', 'important', 'spam', 'abusive', 'spoiler'] as const;
const STATES = ['done', 'done', 'done', 'skipped', 'pending', 'failed', 'stored'] as const;
const LANGS = ['en', 'ja', 'es', 'und'] as const;

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('nothing to pick');
  return item;
}

/** 420 records over the 35 minutes before `SUMMARY_NOW`, the newest last. */
export function variedRecords(): CommentRecord[] {
  let seed = 451;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((seed / 2_147_483_648) * n);
  };
  const records = Array.from({ length: 420 }, (_unused, i): CommentRecord => {
    const base = pick(TEXTS, next(TEXTS.length));
    const text = next(4) === 0 ? `${base} ${next(9)}` : base;
    const state = pick(STATES, next(STATES.length));
    const lang = pick(LANGS, next(LANGS.length));
    const record: CommentRecord = {
      id: `varied-${i}`,
      site: 'youtube',
      channel: 'fixtureSummary01',
      author: `@made-up-viewer-${next(30)}`,
      text,
      lang,
      // Busier near some minutes, so the bursts differ between windows.
      at: SUMMARY_NOW - (next(3) === 0 ? next(4) * 60_000 + next(60_000) : next(35 * 60_000)),
      state,
    };
    if (state === 'stored') return record;
    const category = pick(CATEGORIES, next(CATEGORIES.length));
    const translated = lang !== 'ja' && lang !== 'und' && next(3) !== 0;
    return {
      ...record,
      category,
      ...(translated ? { translation: `訳:${text}` } : {}),
      ...(category === 'abusive' ? { abusive: next(100) / 100 } : {}),
    };
  });
  return records.sort((a, b) => a.at - b.at);
}
