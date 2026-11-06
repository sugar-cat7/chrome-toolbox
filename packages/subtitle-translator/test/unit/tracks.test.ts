import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_LIMITS } from '../../src/page-context.ts';
import {
  CAPTION_LIMITS,
  listTracks,
  parseJson3,
  pickSourceTrack,
  readVideo,
  type CaptionTrack,
} from '../../src/captions/tracks.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, '../fixtures', name), 'utf8'));

const track = (kind: CaptionTrack['kind'], languageCode: string): CaptionTrack => ({
  languageCode,
  kind,
  baseUrl: `https://www.youtube.com/api/timedtext?v=fixture-v01&lang=${languageCode}`,
  name: languageCode,
  vssId: `${kind === 'asr' ? 'a' : ''}.${languageCode}`,
});
const asr = (languageCode: string) => track('asr', languageCode);
const manual = (languageCode: string) => track('manual', languageCode);

const rawTrack = (over: Record<string, unknown> = {}) => ({
  baseUrl: 'https://www.youtube.com/api/timedtext?v=fixture-v01&lang=en',
  name: { simpleText: 'English' },
  vssId: '.en',
  languageCode: 'en',
  isTranslatable: true,
  trackName: '',
  ...over,
});
const withTracks = (captionTracks: unknown) => ({
  videoDetails: { videoId: 'fixture-v01' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks } },
});

describe('caption tracks', () => {
  it('lists the tracks of a player response', () => {
    const tracks = listTracks(fixture('player-response.json'));

    expect(tracks).toMatchObject({ ok: true });
    if (!tracks.ok) return;
    expect(tracks.value.map(({ kind, languageCode }) => `${kind}:${languageCode}`)).toEqual([
      'manual:es-419',
      'asr:es',
      'manual:ja',
    ]);
    expect(tracks.value[1]).toEqual({
      languageCode: 'es',
      kind: 'asr',
      baseUrl: expect.stringMatching(
        /^https:\/\/www\.youtube\.com\/api\/timedtext\?.*&kind=asr&lang=es$/u,
      ),
      name: 'スペイン語 (自動生成)',
      vssId: 'a.es',
    });
  });

  it('lists no tracks for a response without captions, such as a live stream', () => {
    expect(listTracks({ videoDetails: { videoId: 'fixture-v02', isLive: true } })).toEqual({
      ok: true,
      value: [],
    });
  });

  it('reads a name given as runs and leaves out tracks of an unknown kind', () => {
    const tracks = listTracks(
      withTracks([
        rawTrack({
          name: { runs: [{ text: 'English' }, { text: ' (UK)' }] },
          languageCode: 'en-GB',
        }),
        rawTrack({ kind: 'forced', languageCode: 'fr' }),
        rawTrack({ kind: '', languageCode: 'de' }),
      ]),
    );

    expect(tracks).toMatchObject({ ok: true });
    if (!tracks.ok) return;
    expect(tracks.value.map(({ kind, languageCode, name }) => [kind, languageCode, name])).toEqual([
      ['manual', 'en-GB', 'English (UK)'],
      ['manual', 'de', 'English'],
    ]);
  });

  it.each([
    { name: 'an empty object', value: {} },
    { name: 'not an object', value: 'player' },
    { name: 'tracks that are not a list', value: withTracks({}) },
    { name: 'a track without baseUrl', value: withTracks([rawTrack({ baseUrl: undefined })]) },
    { name: 'a malformed language code', value: withTracks([rawTrack({ languageCode: 'en us' })]) },
    {
      name: `${CAPTION_LIMITS.tracks + 1} tracks`,
      value: withTracks(Array.from({ length: CAPTION_LIMITS.tracks + 1 }, () => rawTrack())),
    },
  ])('rejects a malformed player response with input_invalid: $name', ({ value }) => {
    expect(listTracks(value)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
  });

  it('reads videoId, channelId, title and live from videoDetails', () => {
    expect(readVideo(fixture('player-response.json'))).toEqual({
      ok: true,
      value: {
        videoId: 'fixture-v01',
        channelId: 'UCfixture-channel-000000',
        author: 'Fixture Ch',
        title: 'Fixture Quest day 3',
        live: false,
      },
    });
    expect(readVideo({ videoDetails: { videoId: 'fixture-v02', isLive: true } })).toEqual({
      ok: true,
      value: { videoId: 'fixture-v02', live: true },
    });
  });

  it('bounds the video names like the page context does', () => {
    expect(CAPTION_LIMITS).toMatchObject({
      title: PAGE_LIMITS.title,
      author: PAGE_LIMITS.author,
      channelId: PAGE_LIMITS.streamer,
    });
  });

  it('cuts long names and leaves out empty ones', () => {
    const video = readVideo({
      videoDetails: {
        videoId: 'fixture-v01',
        title: 't'.repeat(300),
        author: '',
        channelId: 'c'.repeat(300),
      },
    });

    expect(video).toMatchObject({ ok: true });
    if (!video.ok) return;
    expect(video.value.title).toHaveLength(CAPTION_LIMITS.title);
    expect(video.value.channelId).toHaveLength(CAPTION_LIMITS.channelId);
    expect(video.value).not.toHaveProperty('author');
  });

  it.each([
    { name: 'no videoDetails', value: {} },
    { name: 'a short video id', value: { videoDetails: { videoId: 'abc' } } },
  ])('rejects a video with input_invalid: $name', ({ value }) => {
    expect(readVideo(value)).toMatchObject({ ok: false, error: { internalCode: 'input_invalid' } });
  });

  it.each([
    {
      name: '原語の manual を優先',
      tracks: [asr('en'), manual('en'), manual('ja')],
      expected: 'manual:en',
    },
    { name: '原語は asr だけ', tracks: [asr('id'), manual('ja')], expected: 'asr:id' },
    {
      name: '原語が分からなければ日本語の manual',
      tracks: [manual('ko'), manual('ja')],
      expected: 'manual:ja',
    },
    { name: '先頭の manual', tracks: [manual('ko'), manual('es')], expected: 'manual:ko' },
    { name: 'トラックなし', tracks: [], expected: undefined },
    {
      name: '原語の地域つきの manual',
      tracks: [manual('ja'), manual('es-419'), asr('es')],
      expected: 'manual:es-419',
    },
    {
      name: '同じ地域の manual を先に',
      tracks: [manual('en-GB'), manual('en-US'), asr('en-US')],
      expected: 'manual:en-US',
    },
  ])('pickSourceTrack: $name', ({ tracks, expected }) => {
    const picked = pickSourceTrack(tracks);
    expect(picked && `${picked.kind}:${picked.languageCode}`).toBe(expected);
  });

  it('parses json3 events into trimmed cues and drops empty ones', () => {
    const cues = parseJson3(fixture('timedtext.json3.json'));

    expect(cues).toMatchObject({ ok: true });
    if (!cues.ok) return;
    expect(cues.value).toHaveLength(4);
    expect(cues.value[0]).toEqual({ startMs: 120, endMs: 3000, text: 'Okay chat,' });
    expect(cues.value.map(({ text }) => text)).toEqual([
      'Okay chat,',
      "we're going in.",
      'Fixturo found the old gate.',
      "Let's cross the bridge!",
    ]);
  });

  it('caps cues at 20,000 and a cue text at 500 characters', () => {
    const events = Array.from({ length: CAPTION_LIMITS.cues + 1 }, (_, index) => ({
      tStartMs: index * 1000,
      dDurationMs: 900,
      segs: [{ utf8: index === 0 ? `${'a'.repeat(499)}😀tail` : `line ${index}` }],
    }));
    const cues = parseJson3({ events });

    expect(CAPTION_LIMITS).toMatchObject({ cues: 20_000, text: 500 });
    expect(cues).toMatchObject({ ok: true });
    if (!cues.ok) return;
    expect(cues.value).toHaveLength(20_000);
    expect(cues.value.at(-1)?.text).toBe('line 19999');
    // A cut never leaves half of a surrogate pair.
    expect(cues.value[0]?.text).toBe('a'.repeat(499));
  });

  it('skips malformed events and rejects a body without events', () => {
    expect(
      parseJson3({
        events: [{ segs: [{ utf8: 'no start' }] }, { tStartMs: 5, segs: [{ utf8: 'ok' }] }],
      }),
    ).toEqual({ ok: true, value: [{ startMs: 5, endMs: 5, text: 'ok' }] });
    expect(parseJson3({ wireMagic: 'pb3' })).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
  });
});
