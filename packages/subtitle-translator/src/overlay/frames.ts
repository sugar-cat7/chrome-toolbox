export type FrameSync = {
  /** Whether frames are followed now. */
  running(this: void): boolean;
  /** Removes every listener and observer and cancels the frame request. */
  stop(this: void): void;
};

/** The video events after which playback may have started or stopped, besides `seeked`. */
const PLAYBACK_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied'] as const;

/**
 * Follows the playback position frame by frame (`requestVideoFrameCallback`'s `mediaTime`) while
 * the video plays in front of the viewer: not paused or ended, no ad (`#movie_player.ad-showing`,
 * whose time is the ad's) and the tab visible. Nothing runs otherwise; a video moved while paused
 * tells its new position once. `onRunning` gets each change of whether frames are followed. Driven
 * by events and the player's class only: no timer, no polling.
 */
export function syncFrames({
  doc,
  player,
  video,
  onFrame,
  onRunning,
}: {
  doc: Document;
  player: HTMLElement;
  video: HTMLVideoElement;
  /** The position of the frame shown, in ms. */
  onFrame: (positionMs: number) => void;
  onRunning: (running: boolean) => void;
}): FrameSync {
  let request: number | undefined;
  let running = false;
  let stopped = false;
  const ad = (): boolean => player.classList.contains('ad-showing');
  const visible = (): boolean => doc.visibilityState === 'visible';

  function frame(_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void {
    request = undefined;
    if (!running) return;
    onFrame(metadata.mediaTime * 1000);
    if (running && request === undefined) request = video.requestVideoFrameCallback(frame);
  }
  function update(): void {
    const next = !stopped && !video.paused && !video.ended && visible() && !ad();
    if (next === running) return;
    running = next;
    if (running) request = video.requestVideoFrameCallback(frame);
    else if (request !== undefined) {
      video.cancelVideoFrameCallback(request);
      request = undefined;
    }
    onRunning(running);
  }
  function onSeeked(): void {
    update();
    if (!running && !stopped && visible() && !ad()) onFrame(video.currentTime * 1000);
  }

  const observer = new MutationObserver(update);
  observer.observe(player, { attributes: true, attributeFilter: ['class'] });
  for (const type of PLAYBACK_EVENTS) video.addEventListener(type, update);
  video.addEventListener('seeked', onSeeked);
  doc.addEventListener('visibilitychange', update);
  update();

  return {
    running: () => running,
    stop() {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      for (const type of PLAYBACK_EVENTS) video.removeEventListener(type, update);
      video.removeEventListener('seeked', onSeeked);
      doc.removeEventListener('visibilitychange', update);
      if (request !== undefined) video.cancelVideoFrameCallback(request);
      request = undefined;
      running = false;
    },
  };
}
