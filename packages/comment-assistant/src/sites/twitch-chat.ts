import { captureSync } from '@chrome-toolbox/contracts';
import type { AuthorRole } from '../protocol.ts';
import { MAX_GAME, MAX_TAG, MAX_TAGS, MAX_TITLE, type StreamInfo } from '../stream-context.ts';
import {
  byAttribute,
  clip,
  ID_ATTRIBUTE,
  rawComment,
  strongestRole,
  type SiteAdapter,
} from './types.ts';

// Verified on a live channel on 2026-10-28: the message container (role="log") under
// #root, its children are wrapper divs around one .chat-line__message, which holds the
// display name ([data-a-target="chat-message-username"]) and the body
// ([data-a-target="chat-line-message-body"], text-fragment spans). Lines carry no message id,
// so each is stamped with one on first read. Mention, link and emote markup inside the body
// follows Twitch's known classes (unverified live); the reader only takes the body's text.
// Verified on 2026-10-28: the stream information section (section#live-channel-stream-
// information) holds links to the channel's own page (/<login>) and the title
// (p[data-a-target="stream-title"]); on an in-app channel switch (History API, seen by the
// Navigation API's navigatesuccess in a content script) the URL changes first and the same
// section is re-rendered in place, so its title is the channel's only while it links to it.
// Verified on live channels on 2026-11-05 (R63): the same section holds the category link
// (a[data-a-target="stream-game-link"], /directory/category/<slug>; its text follows the page
// language, 雑談 or Just Chatting, the slug does not) and the tags (a.tw-tag,
// /directory/all/tags/<tag>, its aria-label translated with the page).
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
  info: '#live-channel-stream-information',
  title: '[data-a-target="stream-title"]',
  game: 'a[data-a-target="stream-game-link"][href]',
  tag: 'a[href^="/directory/all/tags/"]',
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
/**
 * Mutations of the stream information seen while waiting for a channel's title; the wait ends
 * there (a page that never shows it, such as an offline channel's other layout).
 */
const MAX_WAIT_MUTATIONS = 100;
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

/** Whether the stream information links to the channel's own page. */
const showsChannel = (info: Element, login: string): boolean =>
  [...info.querySelectorAll('a[href]')].some(
    (link) => link.getAttribute('href')?.toLowerCase() === `/${login}`,
  );
/** The stream information while it shows `login`; null while it shows another channel. */
function infoOf(doc: Document, login: string): Element | null {
  const info = doc.querySelector(SELECTORS.info);
  return info && showsChannel(info, login) ? info : null;
}
/** The title a stream information shows; empty without one. */
const titleIn = (info: Element | null): string =>
  clip(info?.querySelector(SELECTORS.title)?.textContent ?? '', MAX_TITLE);
/** The title the stream information shows for `login`; empty while it shows another channel. */
const titleOf = (doc: Document, login: string): string => titleIn(infoOf(doc, login));
const CATEGORY = /^\/directory\/category\/([^/?#]+)/u;
const TAG = /^\/directory\/all\/tags\/([^/?#]+)/u;
/** A path segment percent-decoded and cut; empty when malformed. */
function segment(href: string | null, pattern: RegExp, max: number): string {
  const raw = pattern.exec(href ?? '')?.[1];
  if (raw === undefined) return '';
  const decoded = captureSync(() => decodeURIComponent(raw), 'input_invalid');
  return decoded.ok ? clip(decoded.value, max) : '';
}
/** The category's slug and the tags the stream information shows (R63). */
function genreInfoOf(info: Element): Pick<StreamInfo, 'game' | 'tags'> {
  const game = segment(
    info.querySelector(SELECTORS.game)?.getAttribute('href') ?? null,
    CATEGORY,
    MAX_GAME,
  );
  const tags = [...info.querySelectorAll(SELECTORS.tag)]
    .map((link) => segment(link.getAttribute('href'), TAG, MAX_TAG))
    .filter((tag) => tag !== '')
    .slice(0, MAX_TAGS);
  return { ...(game === '' ? {} : { game }), ...(tags.length === 0 ? {} : { tags }) };
}

/**
 * Twitch chat. `session` prefixes the ids stamped on lines; it must differ between page loads
 * so a reloaded page's lines are not taken for ones already answered.
 */
export function createTwitchChat(session: string): SiteAdapter {
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
    // The channel login is the streamer; the title, category and tags only once the page shows
    // that channel's.
    streamInfo(doc, channel) {
      const info = infoOf(doc, channel);
      const title = titleIn(info);
      return {
        streamer: channel,
        ...(title === '' ? {} : { title }),
        ...(info ? genreInfoOf(info) : {}),
      };
    },
    watchStreamInfo(doc, channel, ready) {
      const info = doc.querySelector(SELECTORS.info);
      // Nothing to wait for: no section, or it shows the channel's title already.
      if (!info || titleOf(doc, channel) !== '') return () => undefined;
      const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
      let left = MAX_WAIT_MUTATIONS;
      const observer = new Observer(() => {
        left -= 1;
        const shown = titleOf(doc, channel) !== '';
        if (!shown && left > 0) return;
        observer.disconnect();
        if (shown) ready();
      });
      // Only the section, and only until it shows the channel's title.
      observer.observe(info, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['href'],
      });
      return () => observer.disconnect();
    },
    followsHistory: true,
  };
}
