import type { AuthorRole } from '@chrome-toolbox/contracts';
import {
  byAttribute,
  ID_ATTRIBUTE,
  rawComment,
  strongestRole,
  type ChatDomAdapter,
} from './types.ts';

// Verified on a live channel on 2026-10-28: the message container (role="log") under
// #root, its children are wrapper divs around one .chat-line__message, which holds the
// display name ([data-a-target="chat-message-username"]) and the body
// ([data-a-target="chat-line-message-body"], text-fragment spans). Lines carry no message id,
// so each is stamped with one on first read. Mention, link and emote markup inside the body
// follows Twitch's known classes (unverified live); the reader only takes the body's text.
// Author badges, seen on live channels on 2026-10-29: each is an img.chat-badge inside a
// button[data-a-target="chat-badge"] in the line's .chat-line__username-container, its src the
// global badge's image (static-cdn.jtvnw.net/badges/v1/<id>/1) and its alt translated with the
// page ("Moderator badge" in English, "モデレーターバッジ" in Japanese). Moderator badges were
// seen on chat lines. The badge list the page itself loads (seen on 2026-10-29) names the ids
// and titles: broadcaster "Broadcaster" / "ストリーマー", lead_moderator "Lead Moderator" /
// "モデレーター責任者", moderator, and partner "Verified" / "認証済み". Broadcaster and Lead
// Moderator badges were not seen on a chat line (unverified there). A verified (Partner)
// account is no trusted role (R41).
const SELECTORS = {
  container:
    '[data-test-selector="chat-scrollable-area__message-container"], .chat-scrollable-area__message-container',
  scope: '#root',
  line: '.chat-line__message',
  author: '[data-a-target="chat-message-username"]',
  text: '[data-a-target="chat-line-message-body"]',
  keep: 'a, [data-a-target="chat-message-mention"], .mention-fragment',
  badge: '.chat-line__username-container img.chat-badge',
} as const;
/** Twitch's global badges by image id, the same in every page language. */
const BADGE_ROLES: ReadonlyMap<string, AuthorRole> = new Map([
  ['5527c58c-fb7d-422d-b71b-f309dcb85cc1', 'owner'],
  ['3267646d-33f0-4b17-b3df-f923a41db1d0', 'moderator'],
  ['0822047b-65e0-46f2-94a9-d1091d685d33', 'moderator'],
]);
/**
 * The same badges by their alt text (the title and "badge" / "バッジ") in English and Japanese,
 * should an image id change.
 */
const BADGE_ALTS: ReadonlyMap<string, AuthorRole> = new Map([
  ['Broadcaster badge', 'owner'],
  ['ストリーマーバッジ', 'owner'],
  ['Moderator badge', 'moderator'],
  ['モデレーターバッジ', 'moderator'],
  ['Lead Moderator badge', 'moderator'],
  ['モデレーター責任者バッジ', 'moderator'],
]);
const BADGE_ID = /\/badges\/v1\/([\da-f-]+)\//u;
/** The author's role in a chat line, by its badges. */
const roleOf = (line: Element): AuthorRole | undefined =>
  strongestRole(
    [...line.querySelectorAll(SELECTORS.badge)].map((badge) => {
      const id = BADGE_ID.exec(badge.getAttribute('src') ?? '')?.[1];
      return (
        (id === undefined ? undefined : BADGE_ROLES.get(id)) ??
        BADGE_ALTS.get(badge.getAttribute('alt') ?? '')
      );
    }),
  );
/**
 * Lines read whose element is kept by id, the newest: their annotations arrive within seconds,
 * while Twitch shows about 150 lines.
 */
const MAX_HELD = 500;
const LOGIN = /^\w{1,25}$/u;
/** Paths whose second segment is the channel: /popout/<login>/chat, /embed/<login>/chat … */
const NESTED = new Set(['popout', 'embed', 'moderator']);
/** First path segments of Twitch's own pages, never a channel. */
const RESERVED = new Set([
  'bits',
  'broadcast',
  'directory',
  'downloads',
  'drops',
  'friends',
  'inventory',
  'jobs',
  'login',
  'logout',
  'messages',
  'p',
  'payments',
  'prime',
  'search',
  'settings',
  'signup',
  'store',
  'subscriptions',
  'team',
  'turbo',
  'u',
  'videos',
  'wallet',
]);

/**
 * Twitch chat. `session` prefixes the ids stamped on lines; it must differ between page loads
 * so a reloaded page's lines are not taken for ones already answered.
 */
export function createTwitchChat(session: string): ChatDomAdapter {
  let next = 0;
  /**
   * The lines read, by stamped id, newest last: `messageElement` finds one without searching the
   * list (44 µs a comment on a live channel, R45). Weak, so a line Twitch removed is not kept.
   */
  const held = new Map<string, WeakRef<HTMLElement>>();
  function hold(id: string, line: Element): void {
    if (!(line instanceof HTMLElement)) return;
    held.delete(id);
    held.set(id, new WeakRef(line));
    if (held.size <= MAX_HELD) return;
    const [oldest] = held.keys();
    if (oldest !== undefined) held.delete(oldest);
  }
  return {
    site: 'twitch',
    matches: (url) => url.hostname === 'www.twitch.tv',
    channel(doc) {
      const [first, second] = (URL.parse(doc.URL)?.pathname ?? '').split('/').filter(Boolean);
      const login = first !== undefined && NESTED.has(first) ? second : first;
      if (login === undefined || !LOGIN.test(login)) return undefined;
      const lower = login.toLowerCase();
      return RESERVED.has(lower) ? undefined : lower;
    },
    container: (doc) => doc.querySelector(SELECTORS.container),
    scope: (doc) => doc.querySelector(SELECTORS.scope),
    read(node) {
      const line = node.matches(SELECTORS.line) ? node : node.querySelector(SELECTORS.line);
      if (!line) return undefined;
      let id = line.getAttribute(ID_ATTRIBUTE);
      if (id === null) {
        next += 1;
        id = `${session}-${next}`;
        line.setAttribute(ID_ATTRIBUTE, id);
      }
      hold(id, line);
      return rawComment(
        id,
        line.querySelector(SELECTORS.author)?.textContent ?? '',
        line.querySelector(SELECTORS.text)?.textContent ?? '',
        roleOf(line),
      );
    },
    messageElement(root, id) {
      const line = held.get(id)?.deref();
      if (line?.getAttribute(ID_ATTRIBUTE) === id && root.contains(line)) return line;
      // Not held any more, or moved: the list may still show it (a re-rendered copy).
      return root.querySelector<HTMLElement>(`${SELECTORS.line}${byAttribute(ID_ATTRIBUTE, id)}`);
    },
    textElement: (message) => message.querySelector<HTMLElement>(SELECTORS.text),
    keep: SELECTORS.keep,
  };
}
