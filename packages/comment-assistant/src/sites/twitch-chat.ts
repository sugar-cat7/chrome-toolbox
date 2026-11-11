import { captureSync } from '@chrome-toolbox/contracts';
import { clip, createTwitchChat as createChatDom } from '@chrome-toolbox/extension-core/chat-dom';
import { MAX_GAME, MAX_TAG, MAX_TAGS, MAX_TITLE, type StreamInfo } from '../stream-context.ts';
import type { SiteAdapter } from './types.ts';

// Verified on 2026-10-28: the stream information section (section#live-channel-stream-
// information) holds links to the channel's own page (/<login>) and the title
// (p[data-a-target="stream-title"]); on an in-app channel switch (History API, seen by the
// Navigation API's navigatesuccess in a content script) the URL changes first and the same
// section is re-rendered in place, so its title is the channel's only while it links to it.
// Verified on live channels on 2026-11-05 (R63): the same section holds the category link
// (a[data-a-target="stream-game-link"], /directory/category/<slug>; its text follows the page
// language, 雑談 or Just Chatting, the slug does not) and the tags (a.tw-tag,
// /directory/all/tags/<tag>, its aria-label translated with the page).
const SELECTORS = {
  info: '#live-channel-stream-information',
  title: '[data-a-target="stream-title"]',
  game: 'a[data-a-target="stream-game-link"][href]',
  tag: 'a[href^="/directory/all/tags/"]',
} as const;
/** Mutations to wait for metadata before disconnecting. */
const MAX_WAIT_MUTATIONS = 100;

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

/** Twitch's shared chat reader with the extension's stream metadata hooks. */
export function createTwitchChat(session: string): SiteAdapter {
  return {
    ...createChatDom(session),
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
