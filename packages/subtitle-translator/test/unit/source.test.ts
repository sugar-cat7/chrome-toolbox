import { describe, expect, it } from 'vitest';
import {
  AUDIO_HINT_MESSAGE,
  NO_SOURCE_MESSAGE,
  noSourceMessage,
  pickSource,
} from '../../src/overlay/source.ts';

describe('subtitle source', () => {
  it.each([
    {
      name: '字幕トラックのあるアーカイブ',
      setting: 'auto',
      tracks: 2,
      live: false,
      capturing: false,
      expected: 'captions',
    },
    {
      name: '字幕トラックなし',
      setting: 'auto',
      tracks: 0,
      live: false,
      capturing: false,
      expected: 'none',
    },
    { name: 'ライブ', setting: 'auto', tracks: 1, live: true, capturing: false, expected: 'none' },
    {
      name: '取得元が音声',
      setting: 'audio',
      tracks: 2,
      live: false,
      capturing: false,
      expected: 'none',
    },
    {
      name: '音声を取得中',
      setting: 'auto',
      tracks: 2,
      live: false,
      capturing: true,
      expected: 'audio',
    },
    {
      name: '取得元が字幕トラック',
      setting: 'captions',
      tracks: 1,
      live: false,
      capturing: false,
      expected: 'captions',
    },
    {
      name: '取得元が字幕トラックでライブ',
      setting: 'captions',
      tracks: 1,
      live: true,
      capturing: false,
      expected: 'none',
    },
  ] as const)('pickSource: $name', ({ expected, name: _name, ...input }) => {
    expect(pickSource(input)).toBe(expected);
  });

  it.each([
    { setting: 'auto', message: '字幕なし・Alt+Shift+S で音声字幕' },
    { setting: 'captions', message: '字幕なし・Alt+Shift+S で音声字幕' },
    { setting: 'audio', message: 'Alt+Shift+S で音声字幕' },
  ] as const)(
    'tells the viewer how to start speech subtitles: $setting',
    ({ setting, message }) => {
      expect(noSourceMessage(setting)).toBe(message);
    },
  );

  it('names the messages as the player shows them', () => {
    expect(NO_SOURCE_MESSAGE).toBe('字幕なし・Alt+Shift+S で音声字幕');
    expect(AUDIO_HINT_MESSAGE).toBe('Alt+Shift+S で音声字幕');
  });
});
