import { captureSync } from '@chrome-toolbox/contracts';
import type { CommentCategory } from '@chrome-toolbox/extension-core';
import type { FilterMode } from '../../filters.ts';
import type { SummaryWindow } from '../../protocol.ts';

/** Category names as the side panel shows them (the order of the filter rows). */
export const CATEGORY_LABELS: Readonly<Record<CommentCategory, string>> = {
  question: '質問',
  important: '重要情報',
  abusive: '攻撃的（Clef）',
  spam: 'スパム・宣伝',
  spoiler: 'ネタバレ',
  chatter: '雑談',
};
/** Why a comment was hidden, in the hidden-comment list. */
export const REASON_LABELS: Readonly<Record<CommentCategory, string>> = {
  question: '質問',
  important: '重要情報',
  chatter: '雑談',
  abusive: '攻撃的',
  spam: 'スパム',
  spoiler: 'ネタバレ',
};
export const MODE_LABELS: Readonly<Record<FilterMode, string>> = {
  show: '表示',
  highlight: 'ハイライト',
  blur: '伏せる',
  // Removed from the chat; the 非表示 tab lists it and puts it back (R54).
  hide: '消す',
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
