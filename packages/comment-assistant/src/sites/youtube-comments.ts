import { captureSync } from '@chrome-toolbox/contracts';
import {
  COMMENTS_SUFFIX,
  MAX_STREAMER,
  MAX_TITLE,
  streamOf,
  type StreamInfo,
} from '../stream-context.ts';
import { byAttribute, clip, ID_ATTRIBUTE, rawComment, type SiteAdapter } from './types.ts';

// Verified on a watch page on 2026-10-28: thread renderers are the children of
// ytd-comments#comments #sections > #contents; the top-level comment is
// #comment-container > ytd-comment-view-model#comment (replies sit in #replies), with
// a#author-text, yt-attributed-string#content-text and a #published-time-text link whose `lc`
// parameter is the comment id. The section is empty until the viewer scrolls to it. Mentions
// and timestamps inside the text are links.
// Stream metadata, verified on live streams on 2026-10-28: there is no <meta
// itemprop="channelId"> any more, and the microformat (itemprop="author", "identifier") keeps
// the first video's values across in-page navigation. ytd-watch-flexy's `video-id` attribute
// changes to the new video about a second after yt-navigate-finish, in the same update as
// ytd-watch-metadata's title (#title h1) and owner link (ytd-video-owner-renderer a,
// /@handle).
// Verified on watch pages on 2026-10-29: the creator's own comment has
// ytd-author-comment-badge-renderer with a `creator` attribute in #author-comment-badge (its
// a#author-text stays, hidden). Verified channels get the same renderer without the attribute
// and no role here.
const SELECTORS = {
  container: 'ytd-comments#comments #sections > #contents',
  scope: 'ytd-comments#comments',
  thread: 'ytd-comment-thread-renderer',
  comment: ':scope > #comment-container > #comment',
  author: '#author-text',
  text: '#content-text',
  // An attribute, not #id: jsdom resolves an id before a combinator document-wide, and comment
  // ids repeat in every thread.
  link: '[id="published-time-text"] a',
  creator: 'ytd-author-comment-badge-renderer[creator]',
  keep: 'a',
  watch: 'ytd-watch-flexy',
  title: 'ytd-watch-metadata #title h1',
  owner: 'ytd-watch-metadata ytd-video-owner-renderer a[href]',
} as const;
/** The attribute of ytd-watch-flexy that names the video its metadata shows. */
const WATCH_VIDEO = 'video-id';
const VIDEO_ID = /^[\w-]{1,64}$/u;
/** Comment ids (`lc`): top-level `Ugx…`, replies `Ugx….Ugy…`. */
const COMMENT_ID = /^[\w.-]{1,256}$/u;
/** The top-level comment of a thread, not its replies. */
const commentOf = (thread: Element): Element | null => thread.querySelector(SELECTORS.comment);
const videoOf = (doc: Document): string | undefined => {
  const v = URL.parse(doc.URL)?.searchParams.get('v');
  return v && VIDEO_ID.test(v) ? v : undefined;
};
/**
 * The streamer key of an owner link: `@handle` for `/@handle` (percent-decoded), the channel
 * id for `/channel/<id>`; other links name no streamer.
 */
function streamerOf(href: string, doc: Document): string | undefined {
  const url = URL.parse(href, doc.URL);
  if (url?.hostname !== 'www.youtube.com') return undefined;
  const [first, second] = url.pathname.split('/').filter(Boolean);
  const raw = first?.startsWith('@') ? first : first === 'channel' ? second : undefined;
  if (raw === undefined) return undefined;
  const decoded = captureSync(() => decodeURIComponent(raw), 'input_invalid');
  const streamer = clip(decoded.ok ? decoded.value : raw, MAX_STREAMER);
  return streamer.length > 1 ? streamer : undefined;
}

/** Comments under a YouTube video (top-level only). */
export const youtubeComments: SiteAdapter = {
  site: 'youtube',
  matches: (url) => url.hostname === 'www.youtube.com' && url.pathname === '/watch',
  channel(doc) {
    const v = videoOf(doc);
    return v === undefined ? undefined : `${v}${COMMENTS_SUFFIX}`;
  },
  container: (doc) => doc.querySelector(SELECTORS.container),
  scope: (doc) => doc.querySelector(SELECTORS.scope),
  read(node) {
    if (!node.matches(SELECTORS.thread)) return undefined;
    const comment = commentOf(node);
    const link = comment?.querySelector<HTMLAnchorElement>(SELECTORS.link);
    const lc = link && URL.parse(link.href, node.ownerDocument.URL)?.searchParams.get('lc');
    const read = rawComment(
      lc && COMMENT_ID.test(lc) ? lc : undefined,
      comment?.querySelector(SELECTORS.author)?.textContent ?? '',
      comment?.querySelector(SELECTORS.text)?.textContent ?? '',
      comment?.querySelector(SELECTORS.creator) ? 'owner' : undefined,
    );
    if (read) node.setAttribute(ID_ATTRIBUTE, read.id);
    return read;
  },
  messageElement: (root, id) =>
    root.querySelector<HTMLElement>(`${SELECTORS.thread}${byAttribute(ID_ATTRIBUTE, id)}`),
  textElement: (message) => commentOf(message)?.querySelector<HTMLElement>(SELECTORS.text) ?? null,
  keep: SELECTORS.keep,
  // A thread is processed once it is within one viewport height of the screen (R44).
  nearMargin: '100% 0px',
  streamInfo(doc, channel) {
    // The session's own video: the URL may already name the next one.
    const v = streamOf(channel);
    if (doc.querySelector(SELECTORS.watch)?.getAttribute(WATCH_VIDEO) !== v) return undefined;
    const href = doc.querySelector(SELECTORS.owner)?.getAttribute('href');
    const streamer = href ? streamerOf(href, doc) : undefined;
    const title = clip(doc.querySelector(SELECTORS.title)?.textContent ?? '', MAX_TITLE);
    const info: StreamInfo = {
      ...(streamer === undefined ? {} : { streamer }),
      ...(title === '' ? {} : { title }),
    };
    return info;
  },
  watchStreamInfo(doc, channel, ready) {
    const watch = doc.querySelector(SELECTORS.watch);
    if (!watch) return () => undefined;
    const v = streamOf(channel);
    const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
    // One element, one attribute: the metadata of the session's video arrives with it.
    const observer = new Observer(() => {
      if (watch.getAttribute(WATCH_VIDEO) !== v) return;
      observer.disconnect();
      ready();
    });
    observer.observe(watch, { attributes: true, attributeFilter: [WATCH_VIDEO] });
    return () => observer.disconnect();
  },
};
