// A made-up YouTube watch page for the subtitle extension's browser tests: a `#movie_player` with
// YouTube's player API as the extension calls it (`getPlayerResponse`, `getOption`, `setOption`)
// around a `<video>`, and the player's way of reading a caption track as Task 6 saw it live: on
// `setOption('captions', 'track', …)` it fetches the track's json3 with an XMLHttpRequest
// (`/api/timedtext?…&fmt=json3&pot=…`), once per call. Every name, text and id is made up.

/** The made-up channel of every fixture video (S4). */
export const FIXTURE_CHANNEL = { channelId: 'UCfixture-channel-000000', author: 'Fixture Ch' };

export type FixtureTrack = Readonly<{ languageCode: string; kind: 'asr' | 'manual' }>;
export type FixtureCue = Readonly<{ startMs: number; endMs: number; text: string }>;

export type WatchPage = Readonly<{
  /** 11 characters, as YouTube's ids (`[\w-]{11}`). */
  videoId: string;
  title: string;
  live: boolean;
  tracks: readonly FixtureTrack[];
  /** The `<video>`'s source, on the platform's origin. */
  media: string;
  /** Plays the source over and over (the soak's tones). */
  loop?: boolean;
}>;

/** The player response the fake player gives, in YouTube's shape (Task 6 fixture). */
function playerResponse({ videoId, title, live, tracks }: WatchPage): unknown {
  return {
    playabilityStatus: { status: 'OK' },
    ...(tracks.length === 0
      ? {}
      : {
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: tracks.map(({ languageCode, kind }) => ({
                baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&caps=asr&signature=FIXTURE&lang=${languageCode}${kind === 'asr' ? '&kind=asr' : ''}`,
                name: { simpleText: `${languageCode} (fixture)` },
                vssId: `${kind === 'asr' ? 'a' : ''}.${languageCode}`,
                languageCode,
                ...(kind === 'asr' ? { kind: 'asr' } : {}),
              })),
            },
          },
        }),
    videoDetails: { videoId, title, ...FIXTURE_CHANNEL, isLive: live, isLiveContent: live },
  };
}

/** The watch page's HTML: the player fills the top of a 1280×720 viewport. */
export function watchHtml(page: WatchPage): string {
  const response = JSON.stringify(playerResponse(page)).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${page.title} - YouTube</title>
<style>
  body { margin: 0; background: #0f0f0f; }
  #movie_player { position: relative; width: 960px; height: 540px; background: #000; }
  #movie_player video { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="movie_player" class="html5-video-player">
  <video src="${page.media}" preload="auto"${page.loop === true ? ' loop' : ''}></video>
</div>
<script>
  const response = ${response};
  const player = document.getElementById('movie_player');
  let track = {};
  player.getPlayerResponse = () => response;
  player.getOption = (module, option) => (module === 'captions' && option === 'track' ? track : undefined);
  player.setOption = (module, option, value) => {
    if (module !== 'captions' || option !== 'track') return;
    track = value ?? {};
    if (typeof track.languageCode !== 'string') return;
    const query = new URLSearchParams({ v: response.videoDetails.videoId, lang: track.languageCode, fmt: 'json3', pot: 'fixture-pot' });
    if (track.kind === 'asr') query.set('kind', 'asr');
    const request = new XMLHttpRequest();
    request.open('GET', '/api/timedtext?' + query);
    request.send();
  };
</script>
</body>
</html>`;
}

/** A json3 timedtext body of the cues, one event a cue, as YouTube writes one. */
export function json3(cues: readonly FixtureCue[]): string {
  return JSON.stringify({
    wireMagic: 'pb3',
    events: cues.map(({ startMs, endMs, text }) => ({
      tStartMs: startMs,
      dDurationMs: endMs - startMs,
      segs: [{ utf8: text }],
    })),
  });
}
