// Helpers shared by the subtitle extension's browser specs: the made-up watch page and its media
// (test/browser/fixtures), what the llama.cpp stub was asked, the overlay (in a closed shadow
// root, read over CDP) and the offscreen document's state.
import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import {
  defaultResponder,
  expect,
  type LlamaStub,
  type PlatformStub,
  type Responder,
} from '@chrome-toolbox/extension-core/testing';
import type { SessionState } from '../../src/protocol.ts';
import { toneWav, TONE_PERIOD_MS } from './fixtures/tones.ts';
import { silentVideo } from './fixtures/video.ts';
import { json3, watchHtml, type FixtureCue, type WatchPage } from './fixtures/watch.ts';

export const WATCH = 'https://www.youtube.com/watch';
export const TIMEDTEXT = 'https://www.youtube.com/api/timedtext';
const MEDIA = 'https://www.youtube.com/fixture';
export const watchUrl = (videoId: string): string => `${WATCH}?v=${videoId}`;

/** A property of a parsed JSON value, or undefined. */
export const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/** A chat completion as the stub got it. */
export type Chat = Readonly<{
  /** When it came (Date.now()). */
  at: number;
  model: string | undefined;
  slot: number | undefined;
  /** `input_audio` parts: 1 for a recognition, 0 for a translation. */
  audio: number;
  roles: readonly string[];
  grammar: boolean;
  /** The user turn's text. */
  user: string;
}>;

/**
 * Records every chat completion the stub gets, in order, and answers with `responder` (the
 * default stub unless given).
 */
export function recordChats(llama: LlamaStub, responder: Responder = defaultResponder): Chat[] {
  const chats: Chat[] = [];
  llama.respond = (request) => {
    const chat = request.chat;
    if (chat !== undefined)
      chats.push({
        at: Date.now(),
        model: chat.model,
        slot: chat.id_slot,
        audio: chat.audio,
        roles: chat.messages.map((message) => message.role),
        grammar: chat.grammar !== undefined,
        user: chat.messages.find((message) => message.role === 'user')?.content ?? '',
      });
    return responder(request);
  };
  return chats;
}

/** The line a subtitle translation asks for (`Line to translate (JSON string): …`), or PLaMo's. */
export function lineOf(chat: Chat): string {
  const encoded = /^Line to translate \(JSON string\): (.*)$/mu.exec(chat.user)?.[1];
  const line: unknown = encoded === undefined ? chat.user : JSON.parse(encoded);
  return typeof line === 'string' ? line : '';
}

/** `count` caption cues `Fixture line <n>.` from 1, the first at `firstMs`, one every `everyMs`. */
export function fixtureCues({
  count,
  firstMs,
  everyMs,
  lengthMs,
}: Readonly<{ count: number; firstMs: number; everyMs: number; lengthMs: number }>): FixtureCue[] {
  return Array.from({ length: count }, (_, index) => ({
    startMs: firstMs + index * everyMs,
    endMs: firstMs + index * everyMs + lengthMs,
    text: `Fixture line ${index + 1}.`,
  }));
}

/** The media the watch page plays: a silent video (caption path) or the tones (audio path). */
export type Media =
  | Readonly<{ kind: 'video'; durationMs: number }>
  | Readonly<{ kind: 'tones'; periods: number }>;

/**
 * Serves the watch page of `page` (its `media` is set here), its media and, with `cues`, the
 * json3 the fake player fetches for any track.
 */
export async function serveWatch(
  context: BrowserContext,
  platform: PlatformStub,
  page: Omit<WatchPage, 'media'>,
  media: Media,
  cues?: readonly FixtureCue[],
): Promise<void> {
  if (media.kind === 'video')
    platform.serve(
      `${MEDIA}/frames.webm`,
      await silentVideo(context, media.durationMs),
      'video/webm',
    );
  else platform.serve(`${MEDIA}/tones.wav`, toneWav(media.periods), 'audio/wav');
  const src = media.kind === 'video' ? '/fixture/frames.webm' : '/fixture/tones.wav';
  // The tones loop, so a capture never runs out of speech.
  platform.serve(WATCH, watchHtml({ ...page, media: src, loop: media.kind === 'tones' }));
  if (cues !== undefined) platform.serve(TIMEDTEXT, json3(cues), 'application/json');
}

/** Opens the watch page of `videoId` (served by `serveWatch`) in a new tab, in front. */
export async function openWatch(context: BrowserContext, videoId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(watchUrl(videoId));
  await page.bringToFront();
  return page;
}

/** Plays the watch page's video (the test's Chromium needs no gesture to play with sound). */
export const play = (page: Page): Promise<void> =>
  page.locator('#movie_player video').evaluate((video: HTMLVideoElement) => video.play());

/** The tones' audio: 10 periods (11 s), played in a loop. */
export const TONES: Media = { kind: 'tones', periods: 10 };
/** One period of the tones: a recognition about every 1.1 s while the tab plays. */
export const SPEECH_EVERY_MS = TONE_PERIOD_MS;

/** What the overlay shows: its rows, the pill and the latency of the last line (audio path). */
export type OverlayState = Readonly<{
  source: string;
  ja: string;
  /** The pill's label (`字幕: 併記`) and message. */
  pill: string;
  message: string;
  state: string | null;
  latency: string | null;
}>;
/** One change of the rows, at the video's position (ms). */
export type RowChange = Readonly<{ at: number; source: string; ja: string }>;

/** Runs in the overlay's shadow root: what it shows. */
function readOverlay(this: ShadowRoot): OverlayState {
  const shown = (selector: string): string => {
    const element = this.querySelector<HTMLElement>(selector);
    return element === null || element.hidden ? '' : (element.textContent ?? '');
  };
  const off = this.querySelector<HTMLElement>('.lines')?.hidden === true;
  const pill = this.querySelector<HTMLElement>('[data-pill]');
  return {
    source: off ? '' : shown('[data-row="source"]'),
    ja: off ? '' : shown('[data-row="ja"]'),
    pill: pill?.firstElementChild?.textContent ?? '',
    message: shown('[data-pill] .message'),
    state: pill?.getAttribute('data-state') ?? null,
    latency: this.host.getAttribute('data-st-latency'),
  };
}
/**
 * Runs in the overlay's shadow root: from now on keeps each change of the rows with the video's
 * position, in the shadow root (`Symbol.for('st-test.rows')`).
 */
function recordRows(this: ShadowRoot): void {
  const key = Symbol.for('st-test.rows');
  const store = this as unknown as Record<symbol, RowChange[] | undefined>;
  if (store[key] !== undefined) return;
  const changes: RowChange[] = [];
  store[key] = changes;
  const video = this.host.parentElement?.querySelector('video');
  const shown = (selector: string): string => {
    const element = this.querySelector<HTMLElement>(selector);
    const off = this.querySelector<HTMLElement>('.lines')?.hidden === true;
    return off || element === null || element.hidden ? '' : (element.textContent ?? '');
  };
  const note = (): void => {
    const source = shown('[data-row="source"]');
    const ja = shown('[data-row="ja"]');
    const last = changes.at(-1);
    if (last?.source === source && last.ja === ja) return;
    changes.push({ at: (video?.currentTime ?? 0) * 1000, source, ja });
  };
  new MutationObserver(note).observe(this, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  note();
}
function rowsRecorded(this: ShadowRoot): RowChange[] {
  const store = this as unknown as Record<symbol, RowChange[] | undefined>;
  return [...(store[Symbol.for('st-test.rows')] ?? [])];
}
/** Runs in the overlay's shadow root: the middle of the pill, in the page's coordinates. */
function pillCenter(this: ShadowRoot): { x: number; y: number } {
  const box = this.querySelector('[data-pill]')?.getBoundingClientRect();
  return box === undefined
    ? { x: -1, y: -1 }
    : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

type DomNode = Readonly<{
  attributes?: readonly string[];
  children?: readonly DomNode[];
  shadowRoots?: readonly DomNode[];
  backendNodeId: number;
}>;
/** The overlay host's shadow root in a pierced DOM tree. */
function overlayRoot(node: DomNode): DomNode | undefined {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2)
    if (attributes[index] === 'data-st-overlay') return node.shadowRoots?.[0];
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const found = overlayRoot(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

export type Overlay = {
  read(this: void): Promise<OverlayState>;
  /** Keeps every change of the rows from now on (see `changes`). */
  record(this: void): Promise<void>;
  changes(this: void): Promise<RowChange[]>;
  /** Clicks the pill with the mouse, as the viewer does. */
  clickPill(this: void): Promise<void>;
  detach(this: void): Promise<void>;
};

/**
 * The overlay of the watch page's player. Its shadow root is closed (as in production), so the
 * test finds it over CDP (`DOM.getDocument` with `pierce`) and runs its readers on it
 * (`Runtime.callFunctionOn`); the DOM domain is disabled again once it is found. Waits for the
 * overlay to mount.
 */
export async function overlayOf(page: Page): Promise<Overlay> {
  const session: CDPSession = await page.context().newCDPSession(page);
  let root: DomNode | undefined;
  await expect
    .poll(
      async () => {
        const document = await session.send('DOM.getDocument', { depth: -1, pierce: true });
        root = overlayRoot(document.root);
        return root !== undefined;
      },
      { message: 'the overlay mounts on the player' },
    )
    .toBe(true);
  const backendNodeId = root?.backendNodeId;
  if (backendNodeId === undefined) throw new Error('the overlay has no shadow root');
  const { object } = await session.send('DOM.resolveNode', { backendNodeId });
  await session.send('DOM.disable');
  const resolved = object.objectId;
  if (resolved === undefined) throw new Error('the overlay shadow root has no remote object');
  const objectId: string = resolved;
  async function call<T>(fn: (this: ShadowRoot) => T): Promise<T> {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn.toString(),
      returnByValue: true,
    });
    if (exceptionDetails !== undefined) throw new Error(JSON.stringify(exceptionDetails));
    return result.value as T;
  }
  return {
    read: () => call(readOverlay),
    record: () => call(recordRows),
    changes: () => call(rowsRecorded),
    clickPill: async () => {
      const { x, y } = await call(pillCenter);
      await page.mouse.click(x, y);
    },
    detach: () => session.detach(),
  };
}

/** Whether the extension has its offscreen document open (`chrome.offscreen.hasDocument`). */
export const hasOffscreen = (serviceWorker: Worker): Promise<boolean> =>
  serviceWorker.evaluate(() =>
    (
      globalThis as unknown as { chrome: { offscreen: { hasDocument(): Promise<boolean> } } }
    ).chrome.offscreen.hasDocument(),
  );

/** The offscreen document's session (`audio/state`), asked from the service worker. */
export async function sessionState(serviceWorker: Worker): Promise<SessionState> {
  const answer: unknown = await serviceWorker.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio/state', payload: {} }),
  );
  expect(field(answer, 'ok'), `audio/state: ${JSON.stringify(answer)}`).toBe(true);
  return field(answer, 'value') as SessionState;
}

/** Everything in `storage.session` (the service worker's per-tab state and capture record). */
export const sessionStorage = (serviceWorker: Worker): Promise<Record<string, unknown>> =>
  serviceWorker.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { storage: { session: { get(keys: null): Promise<Record<string, unknown>> } } };
      }
    ).chrome.storage.session.get(null),
  );

/**
 * The platform requests of a watch page visit, by kind: the documents, the media and the
 * timedtext requests; anything else is `other`.
 */
export function platformKinds(requests: readonly string[]): {
  documents: string[];
  media: string[];
  timedtext: string[];
  other: string[];
} {
  const kinds = {
    documents: [] as string[],
    media: [] as string[],
    timedtext: [] as string[],
    other: [] as string[],
  };
  for (const url of requests) {
    if (url.startsWith(`${WATCH}?`)) kinds.documents.push(url);
    else if (url.startsWith(`${MEDIA}/`)) kinds.media.push(url);
    else if (url.startsWith(`${TIMEDTEXT}?`)) kinds.timedtext.push(url);
    else kinds.other.push(url);
  }
  return kinds;
}

/**
 * Waits until no new chat came for `quietMs` (what was waiting finished), at most `timeoutMs`;
 * returns how many there are then.
 */
export async function settled(
  chats: readonly Chat[],
  quietMs = 1_500,
  timeoutMs = 6_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = chats.length;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    if (chats.length === count || Date.now() > deadline) return chats.length;
  }
}
