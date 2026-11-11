import type { CommentRecord } from '@chrome-toolbox/extension-core';
import { MAX_COMMENT_TEXT, type AuthorRole, type RawComment } from '../protocol.ts';
import type { StreamInfo } from '../stream-context.ts';

export type Site = CommentRecord['site'];

/**
 * Reads one site's comments from the DOM the page already shows (no platform requests). Each
 * adapter keeps its selectors as constants at the top of its module.
 */
export type SiteAdapter = Readonly<{
  site: Site;
  /** Whether this adapter reads the page at `url`. */
  matches(this: void, url: URL): boolean;
  /** The store partition: the YouTube video id or the Twitch channel login. */
  channel(this: void, doc: Document): string | undefined;
  /** The element whose children are the comments. */
  container(this: void, doc: Document): Element | null;
  /**
   * An element present before the container and kept while it is replaced. Only while the
   * container is missing, its subtree is watched (childList) for the container to appear;
   * without one, only `body`'s own children are.
   */
  scope(this: void, doc: Document): Element | null;
  /** A child of the container as a comment; undefined for notices, stickers and the like. */
  read(this: void, node: Element): RawComment | undefined;
  /** The element of a comment read earlier, inside `root` (the container). */
  messageElement(this: void, root: Element, id: string): HTMLElement | null;
  /** The element holding the comment's own text inside its message element. */
  textElement(this: void, message: HTMLElement): HTMLElement | null;
  /**
   * Elements inside the text whose text a translation leaves as it is (links, mentions): the
   * translation goes into the comment's plain text only, so a link never looks like plain text.
   */
  keep: string;
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

/**
 * Marks an element read from a site without ids of its own (Twitch lines, YouTube comment
 * threads), so `messageElement` finds it again.
 */
export const ID_ATTRIBUTE = 'data-ca-id';
const MAX_ID = 256;
const MAX_AUTHOR = 256;

/** `[name="value"]` with the value escaped (`CSS.escape`, which also covers CR, LF and FF). */
export const byAttribute = (name: string, value: string): string =>
  `[${name}="${CSS.escape(value)}"]`;

/** At most `max` UTF-16 code units, never leaving half a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  // A high surrogate whose pair was cut off.
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * Collapses whitespace and cuts to `max` UTF-16 units without leaving half a surrogate pair,
 * so one long comment cannot make a whole ingest message invalid.
 */
export const clip = (text: string, max: number): string =>
  cut(text.replace(/\s+/gu, ' ').trim(), max);

/** A comment within the service worker's limits; ids it would refuse yield undefined. */
export function rawComment(
  id: string | null | undefined,
  author: string,
  text: string,
  role?: AuthorRole,
): RawComment | undefined {
  if (!id || id.length > MAX_ID) return undefined;
  return {
    id,
    author: clip(author, MAX_AUTHOR),
    text: clip(text, MAX_COMMENT_TEXT),
    at: Date.now(),
    ...(role === undefined ? {} : { role }),
  };
}

const ROLE_RANK: Readonly<Record<AuthorRole, number>> = { owner: 0, moderator: 1, verified: 2 };
/** The first role of an author with several badges: owner, then moderator, then verified. */
export function strongestRole(roles: Iterable<AuthorRole | undefined>): AuthorRole | undefined {
  let strongest: AuthorRole | undefined;
  for (const role of roles)
    if (role !== undefined && (strongest === undefined || ROLE_RANK[role] < ROLE_RANK[strongest]))
      strongest = role;
  return strongest;
}
