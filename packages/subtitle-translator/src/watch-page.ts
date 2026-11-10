import { browser } from 'wxt/browser';
import { Err, launch, Ok } from '@chrome-toolbox/contracts';
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
import { watchFront, type FrontState, type FrontWatch } from './front.ts';
import { syncFrames, type FrameSync } from './overlay/frames.ts';
import {
  createLiveView,
  LIVE_VIEW_LIMITS,
  liveLineView,
  type LiveView,
} from './overlay/live-view.ts';
import { mountOverlay, type OverlayHandle, type OverlayView } from './overlay/overlay.ts';
import { noSourceMessage, pickSource, type SubtitleSource } from './overlay/source.ts';
import { createTimeline, type Timeline } from './overlay/timeline.ts';
import type { PageInfo } from './page-context.ts';
import {
  addressed,
  contentProtocol,
  isFor,
  subtitleProtocol,
  type AudioStatus,
  type LiveLine,
} from './protocol.ts';
import {
  defaultSubtitleSettings,
  subtitleSettingsStore,
  watchSubtitleSettings,
  type DisplayMode,
  type StorageEvents,
  type SubtitleSettings,
} from './settings.ts';

type PageMessageListener = (
  message: unknown,
  sender: Readonly<{ id?: string | undefined }>,
  sendResponse: (response: unknown) => void,
) => true | undefined;
/** `chrome.runtime` as the page receives the service worker's messages (`tabs.sendMessage`). */
export type PageRuntime = {
  readonly id: string;
  onMessage: {
    addListener(listener: PageMessageListener): void;
    removeListener(listener: PageMessageListener): void;
  };
};

export type WatchPageOptions = Readonly<{
  /** Delivers a message to the service worker (`runtime.sendMessage`); the target is added. */
  send?: (message: unknown) => Promise<unknown>;
  /** Where the service worker's messages for the page arrive. */
  runtime?: PageRuntime;
  /** Where the subtitle settings are, and their changes (`storage.local`). */
  storage?: StorageArea & StorageEvents;
  timers?: Timers;
  /** The overlay's shadow root mode: closed unless a test reads it. */
  mode?: ShadowRootMode;
}>;

/** The paths of a page that plays one video: `/watch` and `/live/<id>`. */
const WATCH_PATH = /^\/(?:watch$|live\/)/u;

/** One video of a visit and what draws its subtitles. */
type Shown = {
  readonly videoId: string;
  /** Where its subtitles come from: the caption track, the captured tab audio, or nowhere. */
  readonly source: SubtitleSource;
  /** The caption track translated; none when the video has no source. */
  readonly track: CaptionTrack | undefined;
  /** What the pill says with no source: how to start speech subtitles. */
  readonly hint: string | undefined;
  readonly timeline: Timeline;
  readonly live: LiveView;
  feeder: CaptionFeeder | undefined;
  sync: FrameSync | undefined;
  /** The playback position of the last frame, in ms; none during an ad. */
  position: number | undefined;
  /** An ad cleared the line and no frame came since. */
  cleared: boolean;
};

/** A watch page, from its load or navigation to the next navigation. */
type Visit = {
  readonly player: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly overlay: OverlayHandle;
  /** Follows the front once the settings are read; the bridge is told `ready` then. */
  front: FrontWatch | undefined;
  /** What `front` reported last. */
  state: FrontState | undefined;
  /** The latest cues the bridge posted before their video was named: its feeder may take them. */
  cues: CuesMessage | undefined;
  /** What the bridge said of the video shown, to show it again from another source. */
  named: VideoMessage | undefined;
  shown: Shown | undefined;
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
 * overlay, follows whether the video is in front of the viewer (`watchFront`, reported with
 * `subs/front` at the start and on each change) and tells the MAIN-world bridge `ready`, once the
 * subtitle settings are read. For each video the bridge names, it reports the page (`subs/page`)
 * and picks the source (`pickSource`). With no source, the pill tells the viewer how to start
 * speech subtitles and nothing is translated. With the caption track (`pickSourceTrack`), it asks
 * the bridge for the track's cues unless they came already, and makes the feeder from them; the
 * feeder's lines go into the timeline, which is drawn at the position of each video frame while
 * the video plays (`syncFrames`), and the feeder sends batches (`subs/translate`) only while the
 * page is `active`. An ad clears the line until the video's frames come back, or until the ad
 * ends on a paused video (drawn from its `currentTime`). A new video or navigation starts over
 * with a new timeline, live view and feeder; leaving the watch page reports it `away`. The display mode is read live: a change saved anywhere (the pill, which sends
 * `subs/display`, the shortcut, the side panel) redraws every tab at once, and the position
 * setting moves the lines the same way.
 *
 * While the service worker captures this tab's audio (`subs/status`, from this extension's service
 * worker only, target `content`), the audio is the source: the caption feeder stops, the lines of
 * `subs/lines` go to the live view and the pill shows the capture's state; when the capture stops
 * the video is shown from its caption track again. Why the audio did not start shows on the pill
 * until the next video. Returns the cleanup of every listener, observer, timer and the overlay.
 */
export function startWatchPage(
  win: Window,
  {
    send = (message) => browser.runtime.sendMessage(message),
    runtime = browser.runtime,
    storage = browser.storage.local,
    timers = systemTimers,
    mode,
  }: WatchPageOptions = {},
): () => void {
  const doc = win.document;
  const store = subtitleSettingsStore(storage);
  const deliver = (message: unknown): Promise<unknown> => send(addressed('background', message));
  /** The saved settings, once read; then each change. */
  let settings: SubtitleSettings | undefined;
  let visit: Visit | undefined;
  let stopped = false;
  /** The capture of this tab's audio, as the service worker last told; it outlives navigations. */
  let audio: AudioStatus | undefined;
  const display = (): DisplayMode => settings?.display ?? defaultSubtitleSettings.display;
  const capturing = (): boolean =>
    audio !== undefined && audio.state !== 'stopped' && audio.state !== 'error';

  /** A refused report changes nothing on the page: the service worker learns the next one. */
  function report(state: FrontState): void {
    launch(
      async () => {
        await subtitleProtocol.send(deliver, 'subs/front', state);
      },
      () => undefined,
    );
  }

  /** Asks for the mode the viewer chose with the pill; it shows once saved, in every tab. */
  function choose(next: DisplayMode): void {
    launch(
      async () => {
        await subtitleProtocol.send(deliver, 'subs/display', { mode: next });
      },
      () => undefined,
    );
  }

  function draw(at: Visit, shown: Shown): void {
    if (shown.track === undefined) {
      at.overlay.render(liveLineView(shown.live, display()));
      return;
    }
    const line = shown.position === undefined ? undefined : shown.timeline.at(shown.position);
    at.overlay.render(captionView(line, display(), shown.track.languageCode));
  }

  /** The pill; why the audio did not start replaces the hint and shows on a caption track. */
  function pill(at: Visit, shown: Shown): void {
    const failed = audio?.state === 'error' ? audio.message : undefined;
    if (shown.source === 'audio')
      at.overlay.status({ source: 'audio', state: audio?.state ?? 'away', display: display() });
    else if (shown.track === undefined) {
      const message = failed ?? shown.hint;
      at.overlay.status({
        source: 'none',
        state: failed === undefined ? 'stopped' : 'error',
        display: display(),
        ...(message === undefined ? {} : { message }),
      });
    } else
      at.overlay.status({
        source: 'captions',
        state: failed === undefined ? (at.state?.state ?? 'pause') : 'error',
        display: display(),
        ...(failed === undefined ? {} : { message: failed }),
      });
  }

  function onFront(at: Visit, state: FrontState): void {
    at.state = state;
    report(state);
    const shown = at.shown;
    if (shown === undefined) return;
    shown.feeder?.front(state.state === 'active');
    // An ad has a time of its own: the video's line does not stay over it.
    if (state.reason === 'ad') {
      shown.cleared = true;
      if (shown.position !== undefined) {
        shown.position = undefined;
        draw(at, shown);
      }
    } else if (shown.cleared && at.video.paused && !at.player.classList.contains('ad-showing')) {
      // The ad is over on a paused video, which sends no frame: its line is drawn from where it
      // stands. A playing video's next frame draws it.
      shown.cleared = false;
      moveTo(at, shown, at.video.currentTime * 1000);
    }
    pill(at, shown);
  }

  /** Draws the line at `ms`, which the feeder follows too. */
  function moveTo(at: Visit, shown: Shown, ms: number): void {
    shown.position = ms;
    shown.feeder?.position(ms);
    draw(at, shown);
  }

  /** Translates the cues of the chosen track, from the position of the frames on. */
  function feed(at: Visit, shown: Shown, cues: CuesMessage): void {
    const feeder = createCaptionFeeder({
      videoId: cues.videoId,
      sentences: toSentences(cues.cues, cues.languageCode),
      sourceLang: cues.languageCode,
      display,
      request: (batch) => subtitleProtocol.send(deliver, 'subs/translate', batch),
      onLines: (lines) => {
        shown.timeline.upsert(lines);
        if (shown.position !== undefined) shown.timeline.prune(shown.position);
        draw(at, shown);
      },
      timers,
    });
    shown.feeder = feeder;
    feeder.front(at.state?.state === 'active');
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

  function onVideo(at: Visit, current: SubtitleSettings, message: VideoMessage): void {
    const { video, tracks } = message;
    // The bridge names the video again on `ready` and after its own navigation event.
    if (at.shown?.videoId === video.videoId) return;
    close(at);
    at.named = message;
    // Why the audio did not start was about the last video.
    if (audio?.state === 'error') audio = undefined;
    const info = pageInfo(video, tracks.length);
    launch(
      async () => {
        // A refused report changes nothing on the page: batches go without the video's context.
        await subtitleProtocol.send(deliver, 'subs/page', { info });
      },
      () => undefined,
    );
    show(at, current, message);
  }

  /** Shows the video's subtitles from its source: the captured audio, its caption track, none. */
  function show(at: Visit, current: SubtitleSettings, { video, tracks }: VideoMessage): void {
    const picked = pickSource({
      setting: current.source,
      tracks: tracks.length,
      live: video.live,
      capturing: capturing(),
    });
    const track = picked === 'captions' ? pickSourceTrack(tracks) : undefined;
    const source: SubtitleSource = picked === 'captions' && track === undefined ? 'none' : picked;
    const live = createLiveView({
      holdMs: LIVE_VIEW_LIMITS.holdMs,
      timers,
      onChange: () => at.overlay.render(liveLineView(live, display())),
    });
    const shown: Shown = {
      videoId: video.videoId,
      source,
      track,
      hint: source === 'none' ? noSourceMessage(current.source) : undefined,
      timeline: createTimeline({ keepMs: FEEDER_LIMITS.keepMs }),
      live,
      feeder: undefined,
      sync: undefined,
      position: undefined,
      cleared: false,
    };
    at.shown = shown;
    // Cues posted before this video was named are its feeder's, or nobody's.
    const held = at.cues;
    at.cues = undefined;
    draw(at, shown);
    pill(at, shown);
    if (track === undefined) return;
    shown.sync = syncFrames({
      doc,
      player: at.player,
      video: at.video,
      onFrame: (ms) => {
        shown.cleared = false;
        moveTo(at, shown, ms);
      },
    });
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

  /**
   * The service worker told how the capture of this tab's audio stands. When the audio becomes the
   * source, or stops being it, the video is shown again from its new source: the caption feeder
   * stops while the audio is captured (only this tab), and starts over after.
   */
  function onAudio(next: AudioStatus): void {
    const was = capturing();
    audio = next;
    const at = visit;
    const shown = at?.shown;
    if (at === undefined || shown === undefined) return;
    if (was !== capturing() && at.named !== undefined && settings !== undefined) {
      close(at);
      show(at, settings, at.named);
    } else pill(at, shown);
  }

  function onLines(lines: readonly LiveLine[]): void {
    const shown = visit?.shown;
    if (shown?.source !== 'audio') return;
    for (const line of lines) shown.live.upsert(line);
  }

  const routeFromBackground = contentProtocol.route({
    'subs/lines': ({ lines }) => {
      onLines(lines);
      return Promise.resolve(Ok({}));
    },
    'subs/status': ({ status }) => {
      onAudio(status);
      return Promise.resolve(Ok({}));
    },
  });
  /** Takes only what this extension's service worker addressed to the page. */
  function onRuntimeMessage(
    message: unknown,
    sender: Readonly<{ id?: string | undefined }>,
    sendResponse: (response: unknown) => void,
  ): true | undefined {
    if (!isFor('content', message) || sender.id !== runtime.id) return undefined;
    launch(
      async () => {
        sendResponse(await routeFromBackground(message));
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }

  function onMessage(event: MessageEvent): void {
    const at = visit;
    const message = at === undefined ? undefined : readBridgeMessage(event, win);
    if (at === undefined || message === undefined) return;
    if (message.type === 'cues') onCues(at, message);
    else if (at.front !== undefined && settings !== undefined) onVideo(at, settings, message);
  }

  /** The display changed: what it shows and whether the page is in front. */
  function onDisplay(at: Visit): void {
    at.front?.displayChanged();
    const shown = at.shown;
    if (shown === undefined) return;
    // While paused no frame comes: the feeder shows the line it skipped while the display was off.
    if (shown.position !== undefined) shown.feeder?.position(shown.position);
    draw(at, shown);
    pill(at, shown);
  }

  /** The settings were read or saved anew. */
  function onSettings(next: SubtitleSettings): void {
    const before = settings;
    settings = next;
    const at = visit;
    if (at === undefined) return;
    if (before?.position !== next.position) at.overlay.position(next.position);
    if (at.front === undefined) ready(at);
    else if (before?.display !== next.display) onDisplay(at);
  }

  function ready(at: Visit): void {
    at.front = watchFront({
      doc,
      player: at.player,
      video: at.video,
      display,
      onChange: (state) => onFront(at, state),
    });
    postToPage(win, { source: CONTENT_SOURCE, type: 'ready' });
  }

  function end(): void {
    const ending = visit;
    if (ending === undefined) return;
    visit = undefined;
    ending.front?.stop();
    close(ending);
    ending.overlay.unmount();
  }

  function begin(): void {
    const left = visit?.state;
    end();
    // The page no longer shows the video it reported in front.
    if (left !== undefined && left.state !== 'away') report({ state: 'away', reason: 'offscreen' });
    if (!WATCH_PATH.test(win.location.pathname)) return;
    const video = doc.querySelector('#movie_player video');
    const player = video?.closest('#movie_player');
    if (!(video instanceof HTMLVideoElement) || !(player instanceof HTMLElement)) return;
    const started: Visit = {
      player,
      video,
      overlay: mountOverlay(player, { ...(mode === undefined ? {} : { mode }), onDisplay: choose }),
      front: undefined,
      state: undefined,
      cues: undefined,
      named: undefined,
      shown: undefined,
    };
    visit = started;
    if (settings !== undefined) {
      started.overlay.position(settings.position);
      ready(started);
    }
  }

  /** The first read; a change seen meanwhile is newer and stays. */
  function loaded(read: SubtitleSettings): void {
    if (!stopped && settings === undefined) onSettings(read);
  }

  win.addEventListener('message', onMessage);
  runtime.onMessage.addListener(onRuntimeMessage);
  doc.addEventListener('yt-navigate-finish', begin);
  const unwatch = watchSubtitleSettings(storage, onSettings);
  begin();
  launch(
    async () => {
      const read = await store.load();
      // Unreadable settings: the defaults, as before the viewer saved any.
      loaded(read.ok ? read.value : defaultSubtitleSettings);
    },
    () => loaded(defaultSubtitleSettings),
  );
  return () => {
    stopped = true;
    unwatch();
    win.removeEventListener('message', onMessage);
    runtime.onMessage.removeListener(onRuntimeMessage);
    doc.removeEventListener('yt-navigate-finish', begin);
    end();
  };
}
