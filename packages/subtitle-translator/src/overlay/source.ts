import type { SubtitleSettings } from '../settings.ts';

/** Where a page's subtitles come from: its caption track, the tab's audio, or nowhere. */
export type SubtitleSource = 'captions' | 'audio' | 'none';

/** The pill with no source, when the viewer has not chosen audio: speech subtitles are a key away. */
export const NO_SOURCE_MESSAGE = '字幕なし・Alt+Shift+S で音声字幕';
/** The pill with no source when the viewer chose audio, which starts only on their action. */
export const AUDIO_HINT_MESSAGE = 'Alt+Shift+S で音声字幕';
/** The pill when the server has no audio projector (mmproj): the side panel tells how to add it. */
export const AUDIO_UNSUPPORTED_MESSAGE = '音声入力が使えません（サイドパネルを見てください）';
/** The pill when the tab's audio could not be captured for another reason. */
export const AUDIO_FAILED_MESSAGE = '音声字幕を開始できませんでした';

/**
 * The source of a page's subtitles: the audio while the tab's audio is captured; nothing when the
 * viewer chose audio and has not started it (a caption track is not used then); otherwise the
 * caption track of a video that has one and is not live (a live stream never uses its tracks).
 */
export function pickSource({
  setting,
  tracks,
  live,
  capturing,
}: Readonly<{
  setting: SubtitleSettings['source'];
  tracks: number;
  live: boolean;
  capturing: boolean;
}>): SubtitleSource {
  if (capturing) return 'audio';
  if (setting === 'audio') return 'none';
  return tracks > 0 && !live ? 'captions' : 'none';
}

/** What the pill says when `pickSource` gives `none`. */
export const noSourceMessage = (setting: SubtitleSettings['source']): string =>
  setting === 'audio' ? AUDIO_HINT_MESSAGE : NO_SOURCE_MESSAGE;
