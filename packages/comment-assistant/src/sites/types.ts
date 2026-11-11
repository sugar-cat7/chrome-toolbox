import type { CommentRecord } from '@chrome-toolbox/extension-core';
import type { ChatDomAdapter } from '@chrome-toolbox/extension-core/chat-dom';
import type { StreamInfo } from '../stream-context.ts';

export {
  byAttribute,
  clip,
  cut,
  ID_ATTRIBUTE,
  rawComment,
  strongestRole,
} from '@chrome-toolbox/extension-core/chat-dom';

export type Site = CommentRecord['site'];

/** A portable DOM reader with the extension's stream context and foreground policy. */
export type SiteAdapter = ChatDomAdapter &
  Readonly<{
    /**
     * The streamer and title the page shows for `channel`'s stream, with what decides its genre
     * (R63: YouTube's game card and description rules, Twitch's category and tags), or undefined
     * while it still shows another stream's. Absent where the page does not show them (the live
     * chat frame: the service worker learns them from the watch page).
     */
    streamInfo?(this: void, doc: Document, channel: string): StreamInfo | undefined;
    /**
     * Calls `ready` each time the page shows more of the stream info of `channel` (YouTube fills
     * in the watch page's metadata after its navigation event and its description just after,
     * Twitch its stream information after the URL changed), then stops by itself; watches nothing
     * when nothing is missing. Returns the removal of what it registered. Watches one element of
     * the page at a time, never the whole app.
     */
    watchStreamInfo?(this: void, doc: Document, channel: string, ready: () => void): () => void;
    /**
     * Comments far down a long page (video comments): each is processed only once it comes within
     * this margin of the viewport (an IntersectionObserver `rootMargin`), and not read before.
     * Without it the chat is processed while its container is on screen in a visible page, and
     * only stored otherwise (R44).
     */
    nearMargin?: string;
    /**
     * The site moves between channels with the History API and no event of its own (Twitch): the
     * session re-reads its channel after each same-document navigation. YouTube announces its
     * navigations instead (`yt-navigate-finish`, which restarts the whole page).
     */
    followsHistory?: boolean;
  }>;
