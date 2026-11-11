import { captureSync } from '@chrome-toolbox/contracts';
import type { CommentCategory, StreamGenre } from '@chrome-toolbox/extension-core';
import type { FilterMode, FilterStrength } from '../../filters.ts';
import { CATEGORY_NAMES } from '../../labels.ts';
import type { SummaryWindow } from '../../protocol.ts';
import type { DetectedReason } from '../../stream-context.ts';

/** The filter rows, in the order the side panel lists them. */
export const FILTER_CATEGORIES: readonly CommentCategory[] = [
  'question',
  'important',
  'abusive',
  'spam',
  'spoiler',
  // The genre categories (R62).
  'instruction',
  'relay',
  'ghosting',
  'privacy',
  'sensitive',
  'chatter',
];
/** Where a filter row says more than the category's name: who judges abuse, what spam covers. */
const FILTER_NAMES: Readonly<Partial<Record<CommentCategory, string>>> = {
  abusive: '攻撃的（Clef）',
  spam: 'スパム・宣伝',
};
/** A category's filter row label: `CATEGORY_NAMES`, or what `FILTER_NAMES` adds. */
export const filterLabel = (category: CommentCategory): string =>
  FILTER_NAMES[category] ?? CATEGORY_NAMES[category];
export const MODE_LABELS: Readonly<Record<FilterMode, string>> = {
  show: '表示',
  highlight: 'ハイライト',
  blur: '伏せる',
  // Removed from the chat; the 非表示 tab lists it and puts it back (R54).
  hide: '消す',
};
/** The filter strength as its select names it (see `FilterStrength` for what each does). */
export const STRENGTH_LABELS: Readonly<Record<FilterStrength, string>> = {
  mild: '弱め',
  normal: 'ふつう',
  strict: '強め',
};
/** Each genre as the filter tab names it (R63). */
export const GENRE_LABELS: Readonly<Record<StreamGenre, string>> = {
  fps: 'FPS・対戦',
  story: 'ストーリー・RPG',
  horror: 'ホラー',
  puzzle_rta: 'パズル・RTA',
  chat: '雑談',
  singing: '歌枠',
  watchalong: '同時視聴',
  sports_viewing: '観戦',
  board: '麻雀・ボード・カード',
  deduction: '人狼・推理',
  other: 'その他',
};
/** What decided a detected genre, as the filter tab names it (R63). */
export const GENRE_REASON_LABELS: Readonly<Record<DetectedReason, string>> = {
  rules: '概要欄',
  title: 'タイトル',
  tags: 'タグ',
  game: 'ゲーム',
  guess: '推定',
  none: 'なし',
};

/** The switch that lets a new line into the chat only once it is judged (R52). */
export const HOLD_LABEL = '判定してから表示する（最大 2 秒）';

const ERRORS = new Map<string, string>([
  ['network_failed', 'llama.cpp に接続できません。サーバーの起動と URL を確認してください。'],
  ['storage_failed', '拡張機能の保存領域を読み書きできませんでした。'],
  ['ipc_failed', '拡張機能の内部通信に失敗しました。パネルを開き直してください。'],
  ['resource_missing', 'このコメントはもう一覧にありません。'],
  ['response_invalid', '想定外の応答がありました。'],
  ['clef_unavailable', 'Clef が使えません。'],
  ['queue_full', '処理が混み合っています。少し待ってからもう一度お試しください。'],
  ['operation_cancelled', '処理が中断されました。'],
]);
/** One sentence for a failure (an internal error code) the viewer may act on. */
export const explain = (code: string): string =>
  ERRORS.get(code) ?? `操作に失敗しました（${code}）。`;

/** A comment's time as the viewer's clock shows it (hh:mm:ss). */
export const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString('ja-JP', { hour12: false });
/** A minute as the viewer's clock shows it (hh:mm). */
export const minuteTime = (at: number): string =>
  new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });

/** The summary windows as their buttons name them. */
export const WINDOW_LABELS: Readonly<Record<SummaryWindow, string>> = {
  5: '5分',
  15: '15分',
  30: '30分',
};
export const SUMMARY_HEADINGS = {
  topics: '主な話題',
  questions: 'よくある質問',
  peaks: '盛り上がり',
  important: '重要コメント',
} as const;
/** In place of the topics when the model could not summarize them. */
export const MODEL_FAILED = '話題の要約に失敗しました（件数と盛り上がりは表示しています）';
/**
 * Under the summary when some comments of the window were not on screen (a background tab, the
 * chat closed, collapsed or scrolled away) and only stored (R44, R49): counted, but neither
 * translated nor classified.
 */
export const unprocessedNote = (count: number): string =>
  `画面に出ていなかった ${count.toLocaleString('ja-JP')} 件は未翻訳`;
/**
 * Language codes as the summary names them. The service worker guesses the language from the
 * script, so Latin-script languages share one code.
 */
const LANGUAGE_NAMES = new Map<string, string>([
  ['und-Latn', 'ラテン文字の言語'],
  ['und-Other', 'その他の文字の言語'],
]);
let languageNames: Intl.DisplayNames | undefined;
/** A language's name in Japanese (`ko` → 韓国語); the code itself when it has none. */
export function languageName(code: string): string {
  const known = LANGUAGE_NAMES.get(code);
  if (known !== undefined) return known;
  // DisplayNames rejects a malformed code.
  const named = captureSync(() => {
    languageNames ??= new Intl.DisplayNames('ja', { type: 'language' });
    return languageNames.of(code);
  }, 'input_invalid');
  return (named.ok ? named.value : undefined) ?? code;
}
