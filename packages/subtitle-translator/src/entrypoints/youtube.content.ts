import { defineContentScript } from 'wxt/utils/define-content-script';
import { startWatchPage } from '../watch-page.ts';

export default defineContentScript({
  // Every YouTube page, because YouTube reaches watch pages without a reload: the subtitles start
  // on /watch and /live/ and start over after each in-app navigation. The top frame only.
  matches: ['https://www.youtube.com/*'],
  allFrames: false,
  runAt: 'document_idle',
  main(ctx) {
    ctx.onInvalidated(startWatchPage(window));
  },
});
