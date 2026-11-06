import { captureSync } from '@chrome-toolbox/contracts';
import { authorRoleSchema, type AuthorRole } from '../protocol.ts';
import { byAttribute, rawComment, strongestRole, type SiteAdapter } from './types.ts';

// Verified on a live stream on 2026-10-28 (popout and the watch page's iframe#chatframe): the
// path to #items, the text message renderer with its `id`, #author-name (its own text node
// plus #chip-badges) and #message (text nodes, emoji as <img>). Switching Top chat ↔ Live chat
// replaces yt-live-chat-item-list-renderer under div#item-list. Paid messages share
// #author-name and #message but were not seen live (unverified).
// Author roles, seen on live streams on 2026-10-29: the renderer's `author-type` is "member" or
// "moderator" (empty for other viewers, absent on paid messages), and the author chip holds
// yt-live-chat-author-badge-renderer[type] badges: "moderator" and "member" in #chat-badges, a
// verified channel's "verified" inside #author-name > #chip-badges (with author-type empty).
// author-type="owner" for the stream's own channel was not seen live (unverified).
const SELECTORS = {
  container: 'yt-live-chat-item-list-renderer #items',
  scope: 'yt-live-chat-app',
  message: 'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer',
  keep: 'a',
  badge: 'yt-live-chat-author-chip yt-live-chat-author-badge-renderer[type]',
} as const;
/**
 * Ids inside a line, found by walking its children (`#content` → `#message`, and on to the
 * author chip's `#author-name`): every line repeats them, and a query for a repeated id costs
 * 25-29 µs a line on the live page, 69 % of the content script's time (R45).
 */
const IDS = { author: 'author-name', text: 'message' } as const;
/** How deep a line's ids sit at most (a paid message's author name is 7 levels down). */
const MAX_DEPTH = 8;
/**
 * The element with `id` nearest below `line` (fewest levels down), within `MAX_DEPTH`. Where the
 * walk finds none (a layout YouTube changed), a query: the old cost, paid only then.
 */
function byId(line: Element, id: (typeof IDS)[keyof typeof IDS]): HTMLElement | null {
  let level: readonly Element[] = [line];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const next: Element[] = [];
    for (const parent of level)
      for (const child of parent.children) {
        if (child.id === id) return child instanceof HTMLElement ? child : null;
        next.push(child);
      }
    level = next;
  }
  const found = line.querySelector(`[id="${id}"]`);
  return found instanceof HTMLElement ? found : null;
}
const ROLES: ReadonlySet<string> = new Set(authorRoleSchema.options);
const isRole = (type: string | null): type is AuthorRole => type !== null && ROLES.has(type);
/** An author-type or badge type that is a role (`member` is none). */
const roleNamed = (type: string | null): AuthorRole | undefined =>
  isRole(type) ? type : undefined;
/** The author's role: the renderer's author-type and the badges of the author chip. */
const roleOf = (node: Element): AuthorRole | undefined =>
  strongestRole([
    roleNamed(node.getAttribute('author-type')),
    ...[...node.querySelectorAll(SELECTORS.badge)].map((badge) =>
      roleNamed(badge.getAttribute('type')),
    ),
  ]);
const PATHS = new Set(['/live_chat', '/live_chat_replay']);
const VIDEO_ID = /^[\w-]{1,64}$/u;

function videoOf(url: string | undefined): string | undefined {
  const v = (url && URL.parse(url)?.searchParams.get('v')) || undefined;
  return v !== undefined && VIDEO_ID.test(v) ? v : undefined;
}
/** The embedding watch page's URL; a cross-origin parent cannot be read. */
function parentUrl(doc: Document): string | undefined {
  const view = doc.defaultView;
  if (!view || view.parent === view) return undefined;
  const read = captureSync(() => view.parent.location.href, 'unexpected_failure');
  return read.ok ? read.value : undefined;
}
/** The name's own text: #chip-badges inside #author-name holds badges, not the name. */
function ownText(element: Element | null): string {
  let text = '';
  for (const node of element?.childNodes ?? []) if (node.nodeType === 3) text += node.textContent;
  return text;
}

/** The YouTube live chat (popout, watch page iframe, and chat replay). */
export const youtubeLiveChat: SiteAdapter = {
  site: 'youtube',
  matches: (url) => url.hostname === 'www.youtube.com' && PATHS.has(url.pathname),
  // The popout has `v`; the watch page's iframe only has a continuation token, so its video
  // comes from the page that embeds it.
  channel: (doc) => videoOf(doc.URL) ?? videoOf(parentUrl(doc)) ?? videoOf(doc.referrer),
  container: (doc) => doc.querySelector(SELECTORS.container),
  scope: (doc) => doc.querySelector(SELECTORS.scope),
  read(node) {
    if (!node.matches(SELECTORS.message)) return undefined;
    return rawComment(
      node.id,
      ownText(byId(node, IDS.author)),
      byId(node, IDS.text)?.textContent ?? '',
      roleOf(node),
    );
  },
  messageElement(root, id) {
    // getElementById is the fast path; the page may hold another element with the same id
    // outside the chat list, so a miss there falls back to a search inside the list.
    const first = root.ownerDocument.getElementById(id);
    const element =
      first && root.contains(first)
        ? first
        : root.querySelector<HTMLElement>(byAttribute('id', id));
    return element?.matches(SELECTORS.message) ? element : null;
  },
  textElement: (message) => byId(message, IDS.text),
  keep: SELECTORS.keep,
};
