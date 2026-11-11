import { defineContentScript } from 'wxt/utils/define-content-script';
import { startPage } from '../chat.ts';
import { createTwitchChat } from '../sites/twitch-chat.ts';
import { youtubeComments } from '../sites/youtube-comments.ts';
import { youtubeLiveChat } from '../sites/youtube-live-chat.ts';

export default defineContentScript({
  // Every YouTube page, because YouTube reaches watch pages without a reload (R28): only a
  // watch page gets the comments adapter, and the live chat runs in its own frame
  // (/live_chat, /live_chat_replay: the watch page's iframe and the popout).
  matches: ['https://www.youtube.com/*', 'https://www.twitch.tv/*'],
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    const stop = startPage(
      document,
      [
        youtubeLiveChat,
        youtubeComments,
        // Twitch lines have no ids: this page load's own prefix keeps stamped ids unique.
        createTwitchChat(crypto.randomUUID()),
      ],
      { isInvalid: () => ctx.isInvalid },
    );
    ctx.onInvalidated(stop);
  },
});
