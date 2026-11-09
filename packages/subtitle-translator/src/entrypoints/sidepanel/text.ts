import { PLAMO_TRANSLATE_MODEL } from '@chrome-toolbox/extension-core';
import { FRONT_REASONS } from '../../front.ts';
import { GLOSSARY_LIMITS } from '../../glossary.ts';
import type { FallbackReason, TranslatorStatus } from '../../line-translator.ts';
import type { SubtitleSource } from '../../overlay/source.ts';
import { SOURCE_LANGUAGES, type DisplayMode, type SubtitleSettings } from '../../settings.ts';

/** The display modes as the side panel names them (the pill uses shorter names). */
export const DISPLAY_CHOICES: Readonly<Record<DisplayMode, string>> = {
  ja: '日本語のみ',
  both: '原語と日本語',
  source: '原語のみ',
  off: 'オフ',
};
export const DISPLAY_HINT = 'プレイヤーの右上のボタンか Alt+Shift+J でも切り替えられます';

/** Where the subtitles of the shown tab come from. */
export const SOURCE_NAMES: Readonly<Record<SubtitleSource, string>> = {
  captions: '字幕トラック',
  audio: '音声認識',
  none: 'なし',
};
/** The viewer's choice of source. */
export const SOURCE_CHOICES: Readonly<Record<SubtitleSettings['source'], string>> = {
  auto: '自動',
  captions: '字幕トラック',
  audio: '音声',
};
/** In place of a spoken language: the speech decides it. */
export const AUTO_LANGUAGE = '自動';

/** Why the shown tab is not processed (R44). */
export const STOP_REASONS: Readonly<Record<(typeof FRONT_REASONS)[number], string>> = {
  paused: '一時停止中',
  muted: 'ミュート',
  hidden: '裏のタブ',
  ad: '広告',
  offscreen: 'プレイヤーが画面外',
  'display-off': '表示オフ',
};

/** Speech subtitles start from the toolbar icon or the shortcut only (S46). */
export const START_GUIDE = 'ツールバーのアイコンか Alt+Shift+S で開始';
export const AUDIO_READY = '音声入力: 使えます';
export const AUDIO_MISSING =
  '音声入力が使えません。llama.cpp のプリセットで mmproj を有効にして、サーバーを再起動してください（docs/llama-server.md）';
export const AUDIO_UNKNOWN = '音声入力: 確認できません（サーバーの答えがありません）';

/** The license asks for this English attribution as it is. */
export const PLAMO_ATTRIBUTION = 'Built with PLaMo';
export const PLAMO_LICENSE_NAME = 'PLaMo Community License';
export const PLAMO_SETUP = 'PLaMo は llama.cpp のサーバーに別に入れます（docs/llama-server.md）';

/** What each reason for Gemma says; `lines` is the count of that reason. */
const FALLBACK_TEXTS: Readonly<Record<FallbackReason, (lines: number) => string>> = {
  not_listed: () => `サーバーに ${PLAMO_TRANSLATE_MODEL} がないため、Gemma で訳しています`,
  refused: (lines) => `PLaMo がエラーを返した ${lines} 行を Gemma で訳しました`,
  language: (lines) => `PLaMo が対応していない言語の ${lines} 行を Gemma で訳しました`,
};
const FALLBACK_ORDER: readonly FallbackReason[] = ['not_listed', 'refused', 'language'];

/**
 * One line for each reason that sent lines to Gemma while PLaMo is chosen (S44), the latest
 * reason first: a server that does not list PLaMo (told by `/v1/models` or by a line), lines PLaMo
 * refused, and lines in a language PLaMo does not know.
 */
export function fallbackNotices(
  status: TranslatorStatus,
  plamoListed: boolean | undefined,
): string[] {
  const lines = status.fallback?.lines;
  const shown = FALLBACK_ORDER.filter((reason) =>
    reason === 'not_listed'
      ? plamoListed === false || (lines?.not_listed ?? 0) > 0
      : (lines?.[reason] ?? 0) > 0,
  );
  const latest = status.fallback?.latest;
  const ordered =
    latest !== undefined && shown.includes(latest)
      ? [latest, ...shown.filter((reason) => reason !== latest)]
      : shown;
  return ordered.map((reason) => FALLBACK_TEXTS[reason](lines?.[reason] ?? 0));
}

export const GLOSSARY_FULL = `用語集は ${GLOSSARY_LIMITS.entries} 件までです`;
export const GLOSSARY_UNKNOWN = '配信者が分からないため、用語集は使えません';
/** An entry with an empty target keeps the source as it is. */
export const KEEP_SOURCE = '原文のまま';

export const NO_VIDEO = 'このタブには YouTube の動画がありません';

const LANGUAGE_NAMES = new Map<string, string>(Object.entries(SOURCE_LANGUAGES));
/** A spoken language as the side panel names it; the code itself when it is not one of the 12. */
export const languageName = (code: string): string => LANGUAGE_NAMES.get(code) ?? code;

/** Seconds with one decimal, as the status shows a latency; none yet without one. */
export const seconds = (ms: number | undefined): string =>
  ms === undefined ? 'まだありません' : `${(ms / 1000).toFixed(1)} 秒`;

const ERRORS = new Map<string, string>([
  ['network_failed', 'llama.cpp に接続できません。サーバーの起動と URL を確認してください。'],
  ['storage_failed', '拡張機能の保存領域を読み書きできませんでした。'],
  ['ipc_failed', '拡張機能の内部通信に失敗しました。パネルを開き直してください。'],
  ['input_invalid', '入力の形式が正しくありません。'],
  ['queue_full', '処理が混み合っています。少し待ってからもう一度お試しください。'],
]);
/** One sentence for a failure (an internal error code) the viewer may act on. */
export const explain = (code: string): string =>
  ERRORS.get(code) ?? `操作に失敗しました（${code}）。`;
