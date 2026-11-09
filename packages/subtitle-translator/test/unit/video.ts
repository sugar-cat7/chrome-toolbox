/**
 * A `<video>` whose playback the test drives: jsdom plays nothing and has no
 * `requestVideoFrameCallback`. `frame(ms)` presents one frame at that media time to the callbacks
 * waiting for it.
 */
export function fakeVideo() {
  const video = document.createElement('video');
  let paused = true;
  let ended = false;
  let currentTime = 0;
  let visibility: DocumentVisibilityState = 'visible';
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  let next = 1;
  Object.defineProperties(video, {
    paused: { get: () => paused, configurable: true },
    ended: { get: () => ended, configurable: true },
    currentTime: { get: () => currentTime, configurable: true },
  });
  Object.defineProperty(document, 'visibilityState', {
    get: () => visibility,
    configurable: true,
  });
  video.requestVideoFrameCallback = (callback) => {
    callbacks.set(next, callback);
    return next++;
  };
  video.cancelVideoFrameCallback = (handle) => {
    callbacks.delete(handle);
  };
  const fire = (type: string) => video.dispatchEvent(new Event(type));
  return {
    video,
    /** Frame requests not answered yet. */
    waiting: () => callbacks.size,
    play: () => {
      paused = false;
      ended = false;
      fire('play');
      fire('playing');
    },
    pause: () => {
      paused = true;
      fire('pause');
    },
    end: () => {
      paused = true;
      ended = true;
      fire('pause');
      fire('ended');
    },
    seek: (ms: number) => {
      currentTime = ms / 1000;
      ended = false;
      fire('seeking');
      fire('seeked');
    },
    frame: (ms: number) => {
      currentTime = ms / 1000;
      const due = [...callbacks.values()];
      callbacks.clear();
      const now = performance.now();
      for (const callback of due)
        callback(now, {
          mediaTime: ms / 1000,
          presentationTime: now,
          expectedDisplayTime: now + 16,
          presentedFrames: 1,
          width: 1280,
          height: 720,
        });
    },
    visibility: (state: DocumentVisibilityState) => {
      visibility = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}
