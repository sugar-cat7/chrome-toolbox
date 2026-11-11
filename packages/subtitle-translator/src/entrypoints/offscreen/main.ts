import { browser } from 'wxt/browser';
import { systemTimers } from '@chrome-toolbox/extension-core';
import { startCapture } from '../../audio/capture.ts';
import { startOffscreen } from '../../offscreen.ts';

// The offscreen document (reason USER_MEDIA) lives as long as the capture: the service worker
// closes it, which ends the capture, its AudioContext and this listener.
const root = browser.runtime.getURL('/');
startOffscreen({
  runtime: {
    id: browser.runtime.id,
    getURL: (path) => `${root}${path.replace(/^\//u, '')}`,
    onMessage: browser.runtime.onMessage,
    sendMessage: (message) => browser.runtime.sendMessage(message),
  },
  startCapture,
  fetch: (input, init) => fetch(input, init),
  timers: systemTimers,
  now: () => performance.timeOrigin + performance.now(),
});
