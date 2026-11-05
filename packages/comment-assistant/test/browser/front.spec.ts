import { setTimeout as sleep } from 'node:timers/promises';
import type { Frame, Page } from '@playwright/test';
import {
  defaultResponder,
  expect,
  test,
  type LlamaStub,
  type StubReply,
  type StubRequest,
} from '@chrome-toolbox/extension-core/testing';
import { filterKey } from '../../src/filters.ts';
import { connect, linesAfter, newest, openChat, statsOf, summaryOf, type Line } from './chat.ts';

// Only the chat in front of the viewer is processed (R44): a chat in a background tab, collapsed
// or closed is read and stored without the model or Clef, and when it is in front again the
// lines on screen are processed, the newest first. The made-up chat (test/browser/fixtures)
// scrolls like YouTube's, so the lines on screen are the newest ones.

/** The fixture line a comment text came from (`… 12`, `… 13?`); none for `lol`. */
const numberOf = (text: unknown): number[] => {
  const found = typeof text === 'string' ? /(\d+)\??$/u.exec(text)?.[1] : undefined;
  return found === undefined ? [] : [Number(found)];
};
/** A property of a parsed JSON value, or undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
type Asked = { batches: number[][]; clef: number[][] };
/**
 * Records the fixture lines of every comment batch and Clef call, in order, and answers as the
 * default stub after `delay` (a slow server lets comments wait).
 */
function recordAsked(llama: LlamaStub, delay = (_request: StubRequest) => 0): Asked {
  const asked: Asked = { batches: [], clef: [] };
  llama.respond = async (request): Promise<StubReply> => {
    if (request.path === '/v1/chat/completions') {
      const user = request.chat?.messages.find((message) => message.role === 'user')?.content;
      // Comment lines are the JSON lines of a batch's user turn; a summary has none.
      const lines = (user ?? '').split('\n').filter((line) => line.startsWith('{'));
      if (lines.length > 0)
        asked.batches.push(lines.flatMap((line) => numberOf(field(JSON.parse(line), 'text'))));
    }
    if (request.path === '/v1/systemone') {
      const state = field(request.body, 'state');
      // Clef's state lists the comments as `<n>: "<text>"`.
      asked.clef.push(
        (typeof state === 'string' ? state : '').split('\n').flatMap((line) => {
          const text = /^\d+: (".*")$/u.exec(line)?.[1];
          return text === undefined ? [] : numberOf(JSON.parse(text));
        }),
      );
    }
    const wait = delay(request);
    if (wait > 0) await sleep(wait);
    return defaultResponder(request);
  };
  return asked;
}
const annotated = (lines: readonly Line[]): Line[] => lines.filter((line) => line.mode !== null);
/**
 * The fixture lines the viewer sees now, oldest first: inside the chat's scroller and inside the
 * part of the frame that the watch page's viewport shows.
 */
const onScreen = (chat: Frame): Promise<number[]> =>
  chat.evaluate(() => {
    const box = document.getElementById('item-scroller')?.getBoundingClientRect();
    const frame = window.frameElement?.getBoundingClientRect();
    if (box === undefined || frame === undefined || window.top === null) return [];
    const top = Math.max(box.top, -frame.top);
    const bottom = Math.min(box.bottom, window.top.innerHeight - frame.top);
    return [...document.querySelectorAll('#items > yt-live-chat-text-message-renderer')]
      .filter((line) => {
        const rect = line.getBoundingClientRect();
        return rect.bottom > top && rect.top < bottom;
      })
      .map((line) => Number(line.id.replace('fixture-line-', '')));
  });

/**
 * While the chat is away (`away` started it), lines keep coming for `ms`: no batch and no Clef
 * call, every comment waiting for the model stored at once, the new lines stored and shown as
 * they are. Returns the newest line posted before it came back.
 */
async function staysStored(
  { sidePanel, chat, video, asked }: { sidePanel: Page; chat: Frame; video: string; asked: Asked },
  left: number,
  ms: number,
): Promise<number> {
  // Batches already with the model finish; nothing waits for it any more.
  await expect.poll(async () => (await statsOf(sidePanel, video)).pending).toBe(0);
  const before = {
    batches: asked.batches.length,
    clef: asked.clef.length,
    stored: (await statsOf(sidePanel, video)).stored,
  };
  await sleep(ms);
  const last = await newest(chat);
  expect(last - left, 'the chat kept posting').toBeGreaterThanOrEqual(15);
  expect(asked.batches.length, 'comment batches while away').toBe(before.batches);
  expect(asked.clef.length, 'Clef calls while away').toBe(before.clef);
  expect((await statsOf(sidePanel, video)).pending).toBe(0);
  // Every line read meanwhile is stored ('lol' too: no rule answers either), sent as a hidden
  // tab's throttled timer allows.
  await expect
    .poll(async () => (await statsOf(sidePanel, video)).stored - before.stored, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(last - left - 10);
  const meanwhile = (await linesAfter(chat, left)).filter((line) => line.n <= last);
  expect(annotated(meanwhile), 'lines shown as they are').toEqual([]);
  return last;
}

/**
 * Conceals the stream's abusive lines as bars (伏せる) instead of removing them (消す, the default,
 * R54), for the streamer and the video alike: a removed line gives up its box while the test reads
 * which lines are on screen, and older lines would scroll into view after the chat looked.
 */
async function keepPlaces(sidePanel: Page, video: string): Promise<void> {
  await sidePanel.evaluate(
    async (keys) => {
      const { chrome } = globalThis as unknown as {
        chrome: { storage: { local: { set(items: object): Promise<void> } } };
      };
      const blur = { translate: true, showOriginal: false, modes: { abusive: 'blur' } };
      await chrome.storage.local.set(Object.fromEntries(keys.map((key) => [key, blur])));
    },
    [filterKey('youtube', video), filterKey('youtube', '@FixtureStreamer')],
  );
}

/** Stops or resumes the fixture's posting (`window.fixturePaused`), holding the screen still. */
const pause = (chat: Frame, paused: boolean): Promise<void> =>
  chat.evaluate((value) => {
    Object.assign(window, { fixturePaused: value });
  }, paused);
/** The fixture lines that are stock reactions (`lol`): answered by rule, never batched. */
const isReaction = (n: number): boolean => n % 10 === 4;

/**
 * Brings the chat back with `back` while the fixture holds the screen still: the lines on screen
 * get their display, the newest first, and lines stored while it was away that are not on
 * screen stay as they are.
 */
async function processesScreen(
  { chat, asked }: { chat: Frame; asked: Asked },
  left: number,
  back: () => Promise<void>,
): Promise<void> {
  await pause(chat, true);
  const batchesBefore = asked.batches.length;
  await back();
  // Nothing is posted meanwhile: what the viewer sees now is what the chat saw coming back.
  const screen = await onScreen(chat);
  expect(screen.length, 'a screenful of lines').toBeGreaterThanOrEqual(8);
  expect(screen[0], 'lines posted while away fill the screen').toBeGreaterThan(left);
  await expect
    .poll(async () => annotated(await linesAfter(chat, left)).map((line) => line.n))
    .toEqual(screen);
  // Newest first: the first batch holds the three newest lines on screen.
  expect(asked.batches[batchesBefore]).toEqual(screen.filter((n) => !isReaction(n)).slice(-3));
  // Lines stored while away and not on screen are never processed.
  await sleep(1_000);
  expect(annotated(await linesAfter(chat, left)).map((line) => line.n)).toEqual(screen);
  expect(
    asked.batches
      .slice(batchesBefore)
      .flat()
      .sort((a, b) => a - b),
  ).toEqual(screen.filter((n) => !isReaction(n)));
  // New lines are processed as before.
  await pause(chat, false);
  await expect
    .poll(async () => annotated(await linesAfter(chat, screen.at(-1))).length)
    .toBeGreaterThan(3);
}

test.describe('a chat in a background tab', () => {
  // A background tab is `hidden` only without Playwright's focus emulation.
  test.use({ realVisibility: true });

  test('is stored without the model or Clef, and the lines on screen are processed when it is in front again', async ({
    context,
    sidePanel,
    platform,
    llama,
  }) => {
    const video = 'fixtureFront01';
    const asked = recordAsked(llama);
    await connect(sidePanel, llama.origin);
    await keepPlaces(sidePanel, video);
    const { watch, chat } = await openChat(context, platform, { video, rate: 10 });
    await expect.poll(async () => annotated(await linesAfter(chat)).length).toBeGreaterThan(10);

    // Another tab comes to the front: the watch page and its chat frame are hidden.
    const other = await context.newPage();
    await other.bringToFront();
    await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('hidden');
    const left = await newest(chat);
    await staysStored({ sidePanel, chat, video, asked }, left, 4_000);

    await processesScreen({ chat, asked }, left, async () => {
      await watch.bringToFront();
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');
    });
    // `stored` counts what is still only stored (R50): the lines processed on return no longer
    // count, so it is what the summary finds unprocessed.
    await expect
      .poll(async () => {
        const { unprocessed } = await summaryOf(sidePanel, video);
        const { stored } = await statsOf(sidePanel, video);
        return stored > 0 && stored === unprocessed;
      })
      .toBe(true);
  });
});

test('stores a collapsed chat and processes new lines once it opens again', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  const video = 'fixtureFront02';
  const asked = recordAsked(llama);
  await connect(sidePanel, llama.origin);
  await keepPlaces(sidePanel, video);
  const { watch, chat } = await openChat(context, platform, { video, rate: 10 });
  await expect.poll(async () => annotated(await linesAfter(chat)).length).toBeGreaterThan(10);

  // The chat column collapses (as on Twitch): an ancestor of the chat is not displayed.
  const host = watch.locator('ytd-live-chat-frame');
  await host.evaluate((element: HTMLElement) => element.style.setProperty('display', 'none'));
  const left = await newest(chat);
  const last = await staysStored({ sidePanel, chat, video, asked }, left, 3_000);

  // An undisplayed frame lays nothing out, so its list scrolled nowhere meanwhile: only the
  // lines that come after it opens are checked here.
  await host.evaluate((element: HTMLElement) => element.style.removeProperty('display'));
  await expect
    .poll(async () => annotated(await linesAfter(chat, last + 10)).length)
    .toBeGreaterThan(5);
});

test('stores a chat scrolled out of view and processes the lines on screen when it is back', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  const video = 'fixtureFront03';
  const asked = recordAsked(llama);
  await connect(sidePanel, llama.origin);
  await keepPlaces(sidePanel, video);
  const { watch, chat } = await openChat(context, platform, { video, rate: 10 });
  await expect.poll(async () => annotated(await linesAfter(chat)).length).toBeGreaterThan(10);

  // The viewer scrolls the watch page down past the chat (to the description, say).
  await watch.evaluate(() => {
    const below = document.createElement('div');
    below.style.height = '3000px';
    document.body.append(below);
    window.scrollTo(0, 2000);
  });
  const left = await newest(chat);
  await staysStored({ sidePanel, chat, video, asked }, left, 3_000);

  await processesScreen({ chat, asked }, left, async () => {
    await watch.evaluate(() => window.scrollTo(0, 0));
  });
});

test('stores the waiting comments of a chat that is closed, letting the running batch finish', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  const video = 'fixtureFront04';
  // A slow model: comments wait for it.
  const asked = recordAsked(llama, (request) =>
    request.path === '/v1/chat/completions' ? 1_500 : 0,
  );
  await connect(sidePanel, llama.origin);
  await keepPlaces(sidePanel, video);
  const { watch } = await openChat(context, platform, { video, rate: 10 });
  await expect.poll(async () => (await statsOf(sidePanel, video)).pending).toBeGreaterThan(10);
  // The chat in front stored nothing so far.
  const before = await statsOf(sidePanel, video);
  expect(before.stored).toBe(0);
  // The viewer closes the chat: YouTube navigates its frame to about:blank (seen live).
  await watch.evaluate(() => {
    document.querySelector('iframe#chatframe')?.setAttribute('src', 'about:blank');
  });
  // The comments waiting for the model are stored at once: all but the batch of 3 with it (one
  // more batch may have started before the chat closed).
  await expect
    .poll(async () => (await statsOf(sidePanel, video)).stored)
    .toBeGreaterThanOrEqual(before.pending - 6);
  await expect.poll(async () => (await statsOf(sidePanel, video)).pending).toBe(0);
  // Nothing waits any more, so no batch starts.
  const batches = asked.batches.length;
  await sleep(2_000);
  expect(asked.batches.length).toBe(batches);
});
