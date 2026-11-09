import { browser } from 'wxt/browser';
import { launch } from '@chrome-toolbox/contracts';
import { systemTimers, type StorageArea, type Timers } from '@chrome-toolbox/extension-core';
import {
  createCaptionFeeder,
  FEEDER_LIMITS,
  type CaptionFeeder,
  type TranslatedLine,
} from './captions/feeder.ts';
import {
  CONTENT_SOURCE,
  postToPage,
  readBridgeMessage,
  type BridgeMessage,
  type CuesMessage,
} from './captions/messages.ts';
import { toSentences } from './captions/sentences.ts';
import { pickSourceTrack, type CaptionTrack } from './captions/tracks.ts';
import { syncFrames, type FrameSync } from './overlay/frames.ts';
import {
  createLiveView,
  LIVE_VIEW_LIMITS,
  liveLineView,
  type LiveView,
} from './overlay/live-view.ts';
import { mountOverlay, type OverlayHandle, type OverlayView } from './overlay/overlay.ts';
import { noSourceMessage, pickSource } from './overlay/source.ts';
import { createTimeline, type Timeline } from './overlay/timeline.ts';
import type { PageInfo } from './page-context.ts';
import { addressed, subtitleProtocol } from './protocol.ts';
import {
  defaultSubtitleSettings,
  subtitleSettingsStore,
  type DisplayMode,
  type SubtitleSettings,
} from './settings.ts';

export type WatchPageOptions = Readonly<{
  /** Delivers a message to the service worker (`runtime.sendMessage`); the target is added. */
  send?: (message: unknown) => Promise<unknown>;
  /** Where the subtitle settings are (`storage.local`). */
  storage?: StorageArea;
  timers?: Timers;
  /** The overlay's shadow root mode: closed unless a test reads it. */
  mode?: ShadowRootMode;
}>;

/** The paths of a page that plays one video: `/watch` and `/live/<id>`. */
const WATCH_PATH = /^\/(?:watch$|live\/)/u;

/** One video of a visit and what draws its subtitles. */
type Shown = {
  readonly videoId: string;
  readonly settings: SubtitleSettings;
  /** The caption track translated; none when the video has no source. */
  readonly track: CaptionTrack | undefined;
  readonly timeline: Timeline;
  readonly live: LiveView;
  feeder: CaptionFeeder | undefined;
  sync: FrameSync | undefined;
  /** The playback position of the last frame, in ms. */
  position: number | undefined;
};

/** A watch page, from its load or navigation to the next navigation. */
type Visit = {
  readonly player: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly overlay: OverlayHandle;
  /** Read when the visit starts; the bridge is told `ready` once they are. */
  settings: SubtitleSettings | undefined;
  /** The latest cues the bridge posted before their video was named: its feeder may take them. */
  cues: CuesMessage | undefined;
  shown: Shown | undefined;
  ended: boolean;
};

type VideoMessage = Extract<BridgeMessage, { type: 'video' }>;

const sameTrack = (cues: CuesMessage, videoId: string, track: CaptionTrack): boolean =>
  cues.videoId === videoId && cues.languageCode === track.languageCode && cues.kind === track.kind;

function captionView(
  line: TranslatedLine | undefined,
  display: DisplayMode,
  lang: string,
): OverlayView {
  if (line === undefined) return { display };
  return {
    display,
    lang,
    source: line.source,
    ...(line.ja === undefined ? {} : { ja: line.ja }),
  };
}

/** What the service worker keeps of the video: the context and glossary key of its batches. */
function pageInfo(video: VideoMessage['video'], tracks: number): PageInfo {
  return {
    videoId: video.videoId,
    ...(video.channelId === undefined ? {} : { streamer: video.channelId }),
    ...(video.title === undefined ? {} : { title: video.title }),
    ...(video.author === undefined ? {} : { author: video.author }),
    live: video.live,
    tracks,
  };
}

/**
 * Runs the subtitles of YouTube's watch pages (`/watch`, `/live/`) in the content script: on each
 * page with a `#movie_player video`, checked again after every `yt-navigate-finish`, it mounts the
 * overlay, reads the subtitle settings and tells the MAIN-world bridge `ready`. For each video the
 * bridge names, it reports the page (`subs/page`) and picks the source (`pickSource`). With no
 * source, the pill tells the viewer how to start speech subtitles and nothing is translated. With
 * the caption track (`pickSourceTrack`), it asks the bridge for the track's cues unless they came
 * already, and makes the feeder from them; the feeder's lines go into the timeline, which is drawn
 * at the position of each video frame while the video plays in front (`syncFrames`), and the
 * feeder sends batches (`subs/translate`) only while frames are followed. A new video or
 * navigation starts over with a new timeline, live view and feeder. Returns the cleanup of every
 * listener, observer, timer and the overlay.
 */
export function startWatchPage(
  win: Window,
  {
    send = (message) => browser.runtime.sendMessage(message),
    storage = browser.storage.local,
    timers = systemTimers,
    mode,
  }: WatchPageOptions = {},
): () => void {
  const doc = win.document;
  const store = subtitleSettingsStore(storage);
  const deliver = (message: unknown): Promise<unknown> => send(addressed('background', message));
  let visit: Visit | undefined;

  function draw(at: Visit, shown: Shown): void {
    const line = shown.position === undefined ? undefined : shown.timeline.at(shown.position);
    at.overlay.render(captionView(line, shown.settings.display, shown.track?.languageCode ?? ''));
  }

  function pill(at: Visit, shown: Shown, running: boolean): void {
    at.overlay.status({
      source: 'captions',
      state: running ? 'active' : 'pause',
      display: shown.settings.display,
    });
  }

  /** Translates the cues of the chosen track, from the position of the frames on. */
  function feed(at: Visit, shown: Shown, cues: CuesMessage): void {
    const feeder = createCaptionFeeder({
      videoId: cues.videoId,
      sentences: toSentences(cues.cues, cues.languageCode),
      sourceLang: cues.languageCode,
      display: () => shown.settings.display,
      request: (batch) => subtitleProtocol.send(deliver, 'subs/translate', batch),
      onLines: (lines) => {
        shown.timeline.upsert(lines);
        if (shown.position !== undefined) shown.timeline.prune(shown.position);
        draw(at, shown);
      },
      timers,
    });
    shown.feeder = feeder;
    feeder.front(shown.sync?.running() ?? false);
  }

  /** Stops what draws the video's subtitles. */
  function close(at: Visit): void {
    const shown = at.shown;
    if (shown === undefined) return;
    at.shown = undefined;
    shown.sync?.stop();
    shown.feeder?.dispose();
    shown.live.reset();
    shown.timeline.reset();
  }

  function onVideo(at: Visit, settings: SubtitleSettings, { video, tracks }: VideoMessage): void {
    // The bridge names the video again on `ready` and after its own navigation event.
    if (at.shown?.videoId === video.videoId) return;
    close(at);
    const info = pageInfo(video, tracks.length);
    launch(
      async () => {
        // A refused report changes nothing on the page: batches go without the video's context.
        await subtitleProtocol.send(deliver, 'subs/page', { info });
      },
      () => undefined,
    );
    const picked = pickSource({
      setting: settings.source,
      tracks: tracks.length,
      live: video.live,
      capturing: false,
    });
    const track = picked === 'captions' ? pickSourceTrack(tracks) : undefined;
    const live = createLiveView({
      holdMs: LIVE_VIEW_LIMITS.holdMs,
      timers,
      onChange: () => at.overlay.render(liveLineView(live, settings.display)),
    });
    const shown: Shown = {
      videoId: video.videoId,
      settings,
      track,
      timeline: createTimeline({ keepMs: FEEDER_LIMITS.keepMs }),
      live,
      feeder: undefined,
      sync: undefined,
      position: undefined,
    };
    at.shown = shown;
    // Cues posted before this video was named are its feeder's, or nobody's.
    const held = at.cues;
    at.cues = undefined;
    draw(at, shown);
    if (track === undefined) {
      at.overlay.status({
        source: 'none',
        state: 'stopped',
        display: settings.display,
        message: noSourceMessage(settings.source),
      });
      return;
    }
    const sync = syncFrames({
      doc,
      player: at.player,
      video: at.video,
      onFrame: (ms) => {
        shown.position = ms;
        shown.feeder?.position(ms);
        draw(at, shown);
      },
      onRunning: (running) => {
        shown.feeder?.front(running);
        pill(at, shown, running);
      },
    });
    shown.sync = sync;
    pill(at, shown, sync.running());
    if (held !== undefined && sameTrack(held, video.videoId, track)) feed(at, shown, held);
    else
      postToPage(win, {
        source: CONTENT_SOURCE,
        type: 'load-track',
        languageCode: track.languageCode,
      });
  }

  function onCues(at: Visit, cues: CuesMessage): void {
    const shown = at.shown;
    if (shown === undefined || cues.videoId !== shown.videoId) {
      at.cues = cues;
      return;
    }
    if (
      shown.track !== undefined &&
      shown.feeder === undefined &&
      sameTrack(cues, shown.videoId, shown.track)
    )
      feed(at, shown, cues);
  }

  function onMessage(event: MessageEvent): void {
    const at = visit;
    const message = at === undefined ? undefined : readBridgeMessage(event, win);
    if (at === undefined || message === undefined) return;
    if (message.type === 'cues') onCues(at, message);
    else if (at.settings !== undefined) onVideo(at, at.settings, message);
  }

  function end(): void {
    const ending = visit;
    if (ending === undefined) return;
    visit = undefined;
    ending.ended = true;
    close(ending);
    ending.overlay.unmount();
  }

  function ready(started: Visit, settings: SubtitleSettings): void {
    if (started.ended) return;
    started.settings = settings;
    postToPage(win, { source: CONTENT_SOURCE, type: 'ready' });
  }

  function begin(): void {
    end();
    if (!WATCH_PATH.test(win.location.pathname)) return;
    const video = doc.querySelector('#movie_player video');
    const player = video?.closest('#movie_player');
    if (!(video instanceof HTMLVideoElement) || !(player instanceof HTMLElement)) return;
    const started: Visit = {
      player,
      video,
      overlay: mountOverlay(player, mode === undefined ? {} : { mode }),
      settings: undefined,
      cues: undefined,
      shown: undefined,
      ended: false,
    };
    visit = started;
    launch(
      async () => {
        const loaded = await store.load();
        // Unreadable settings: the defaults, as before the viewer saved any.
        ready(started, loaded.ok ? loaded.value : defaultSubtitleSettings);
      },
      () => ready(started, defaultSubtitleSettings),
    );
  }

  win.addEventListener('message', onMessage);
  doc.addEventListener('yt-navigate-finish', begin);
  begin();
  return () => {
    win.removeEventListener('message', onMessage);
    doc.removeEventListener('yt-navigate-finish', begin);
    end();
  };
}
