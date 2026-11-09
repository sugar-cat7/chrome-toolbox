import { setTimeout as sleep } from 'node:timers/promises';
import { defaultSettings } from '@chrome-toolbox/extension-core';
import { FEEDER_LIMITS } from '../../src/captions/feeder.ts';
import { DISPLAY_LABELS } from '../../src/settings.ts';
import { NO_SOURCE_MESSAGE } from '../../src/overlay/source.ts';
import type { FixtureCue } from './fixtures/watch.ts';
import { expect, setServer, test } from './server.ts';
import {
  fixtureCues,
  lineOf,
  openWatch,
  overlayOf,
  platformKinds,
  play,
  recordChats,
  serveWatch,
  settled,
  TONES,
  watchUrl,
  type RowChange,
} from './subtitles.ts';

// The caption track path (Tasks 6–10) on the made-up watch page: the fake player fetches the
// track's json3 once when the extension asks (`setOption`), the content script reads it through
// the MAIN-world bridge, the service worker translates sentences ahead of the position, and the
// overlay follows the video frame by frame. Video ids are 11 characters, as YouTube's.

const STUB_JA = '訳:';
/** How far a row may change from its cue's time: the overlay follows video frames (100 ms). */
const SYNC_MS = 200;

/** The first change at or after index `from` for which `test` holds. */
const changeWhere = (
  changes: readonly RowChange[],
  test: (change: RowChange) => boolean,
  from = 0,
): number => changes.findIndex((change, index) => index >= from && test(change));

test('caption path shows source and Japanese lines in sync with playback', async ({
  context,
  platform,
  llama,
  serviceWorker,
}) => {
  const videoId = 'fixtureCap1';
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  const cues = fixtureCues({ count: 8, firstMs: 3_000, everyMs: 1_500, lengthMs: 1_000 });
  await serveWatch(
    context,
    platform,
    {
      videoId,
      title: 'Fixture Quest day 3',
      live: false,
      tracks: [{ languageCode: 'en', kind: 'manual' }],
    },
    { kind: 'video', durationMs: 30_000 },
    cues,
  );
  const page = await openWatch(context, videoId);
  const overlay = await overlayOf(page);
  await overlay.record();
  await play(page);
  const last = cues.at(-1);
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime), {
      timeout: 20_000,
    })
    .toBeGreaterThan(((last?.endMs ?? 0) + 500) / 1000);
  const changes = await overlay.changes();
  await overlay.detach();

  // Each cue is one sentence: both rows show it from its start to its end, within 200 ms.
  const timings = cues.map((cue: FixtureCue) => {
    const shown = changeWhere(changes, (change) => change.source === cue.text);
    const translated = changeWhere(changes, (change) => change.ja === `${STUB_JA}${cue.text}`);
    const gone = changeWhere(changes, (change) => change.source !== cue.text, shown);
    return {
      text: cue.text,
      start: cue.startMs,
      end: cue.endMs,
      shown: changes[shown]?.at,
      translated: changes[translated]?.at,
      gone: changes[gone]?.at,
    };
  });
  for (const timing of timings) {
    const where = JSON.stringify(timing);
    expect(
      Math.abs((timing.shown ?? Infinity) - timing.start),
      `source row: ${where}`,
    ).toBeLessThanOrEqual(SYNC_MS);
    expect(
      Math.abs((timing.translated ?? Infinity) - timing.start),
      `Japanese row: ${where}`,
    ).toBeLessThanOrEqual(SYNC_MS);
    expect(
      Math.abs((timing.gone ?? Infinity) - timing.end),
      `line cleared: ${where}`,
    ).toBeLessThanOrEqual(SYNC_MS);
  }
  // Every translation went to slot 0 of the translation model, as text.
  expect(chats.length).toBeGreaterThanOrEqual(cues.length);
  for (const chat of chats)
    expect(chat).toMatchObject({ model: defaultSettings.models.translate, slot: 0, audio: 0 });
  expect(chats.map(lineOf).toSorted()).toEqual(cues.map((cue) => cue.text).toSorted());
  // The platform saw the document, the media and one timedtext request: the player's own.
  const kinds = platformKinds(platform.requests);
  expect(kinds.documents).toEqual([watchUrl(videoId)]);
  expect(kinds.media.length).toBeGreaterThan(0);
  expect(kinds.timedtext).toHaveLength(1);
  expect(new URL(kinds.timedtext[0] ?? '').searchParams.get('fmt')).toBe('json3');
  expect(kinds.other).toEqual([]);
});

test('seeking restarts the prefetch at the new position', async ({
  context,
  platform,
  llama,
  serviceWorker,
}) => {
  const videoId = 'fixtureSeek';
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  // Ten minutes of lines, one every 2 s.
  const cues = fixtureCues({ count: 300, firstMs: 1_000, everyMs: 2_000, lengthMs: 1_500 });
  const startOf = new Map(cues.map((cue) => [cue.text, cue.startMs]));
  await serveWatch(
    context,
    platform,
    {
      videoId,
      title: 'Fixture Quest day 4',
      live: false,
      tracks: [{ languageCode: 'en', kind: 'manual' }],
    },
    { kind: 'video', durationMs: 610_000 },
    cues,
  );
  const page = await openWatch(context, videoId);
  const overlay = await overlayOf(page);
  await play(page);
  await expect.poll(async () => (await overlay.read()).ja).toBe(`${STUB_JA}Fixture line 1.`);
  // The minute ahead was translated; nothing waits.
  await expect.poll(() => chats.length).toBeGreaterThanOrEqual(25);
  const before = await settled(chats);
  const seekMs = 400_000;
  await page.locator('video').evaluate((video: HTMLVideoElement, to) => {
    video.currentTime = to / 1000;
  }, seekMs);

  // The line shown after the seek is the one at the new position, translated.
  await expect
    .poll(async () => (await overlay.read()).ja, { timeout: 10_000 })
    .toMatch(/^訳:Fixture line \d+\.$/u);
  const shown = (await overlay.read()).source;
  const shownStart = startOf.get(shown) ?? 0;
  expect(shownStart, `${shown} after a seek to ${seekMs} ms`).toBeGreaterThanOrEqual(
    seekMs - FEEDER_LIMITS.behindMs,
  );
  expect(shownStart, `${shown} after a seek to ${seekMs} ms`).toBeLessThanOrEqual(
    seekMs + FEEDER_LIMITS.aheadMs,
  );
  // The prefetch went on from the new position: every sentence asked for after the seek is in
  // the range around it.
  await expect.poll(() => chats.length - before).toBeGreaterThanOrEqual(20);
  const after = chats.slice(before).map((chat) => startOf.get(lineOf(chat)) ?? -1);
  for (const start of after) {
    expect(start).toBeGreaterThanOrEqual(seekMs - FEEDER_LIMITS.behindMs - 2_000);
    expect(start).toBeLessThanOrEqual(seekMs + FEEDER_LIMITS.aheadMs + 10_000);
  }
  await overlay.detach();
});

test('a video without caption tracks shows the audio hint and sends no model request', async ({
  context,
  platform,
  llama,
  serviceWorker,
}) => {
  const videoId = 'fixtureNone';
  await setServer(serviceWorker, llama.origin);
  await serveWatch(
    context,
    platform,
    { videoId, title: 'Fixture Talk', live: false, tracks: [] },
    TONES,
  );
  const page = await openWatch(context, videoId);
  const overlay = await overlayOf(page);
  await play(page);
  await expect.poll(async () => (await overlay.read()).message).toBe(NO_SOURCE_MESSAGE);
  await sleep(5_000);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    false,
  );
  expect((await overlay.read()).message).toBe(NO_SOURCE_MESSAGE);
  expect(
    llama.requests.filter((request) => request.startsWith('POST /v1/chat/completions')),
  ).toEqual([]);
  expect(platformKinds(platform.requests).timedtext).toEqual([]);
  await overlay.detach();
});

/** The translated lines (`訳:Fixture line <n>.`) the page's heap holds, by a heap snapshot. */
async function translationsHeld(page: import('@playwright/test').Page): Promise<number> {
  const session = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  session.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
    chunks.push(chunk);
  });
  await session.send('HeapProfiler.enable');
  await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await session.detach();
  const snapshot = JSON.parse(chunks.join('')) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const typeAt = fields.indexOf('type');
  const nameAt = fields.indexOf('name');
  const held = new Set<string>();
  for (let node = 0; node < snapshot.nodes.length; node += fields.length) {
    if (types[snapshot.nodes[node + typeAt] ?? -1] !== 'string') continue;
    const name = snapshot.strings[snapshot.nodes[node + nameAt] ?? -1] ?? '';
    if (/^訳:Fixture line \d+\.$/u.test(name)) held.add(name);
  }
  return held.size;
}

test('a 30-minute caption track at 16x keeps the timeline bounded with no long task', async ({
  context,
  platform,
  llama,
  serviceWorker,
  longTasks,
}) => {
  test.setTimeout(180_000);
  const videoId = 'fixtureLong';
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  const minutes = 30;
  const cues = fixtureCues({
    count: (minutes * 60_000) / 1_500,
    firstMs: 0,
    everyMs: 1_500,
    lengthMs: 1_200,
  });
  await serveWatch(
    context,
    platform,
    {
      videoId,
      title: 'Fixture Marathon',
      live: false,
      tracks: [{ languageCode: 'en', kind: 'manual' }],
    },
    { kind: 'video', durationMs: minutes * 60_000 },
    cues,
  );
  const page = await openWatch(context, videoId);
  await longTasks(page);
  const position = (): Promise<number> =>
    page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime * 1000);
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    video.playbackRate = 16;
    await video.play();
  });
  // Five sixths of the way (25 minutes in, at about 94 s): the timeline holds the lines around
  // the position only. Paused while it is counted, so the position stays.
  await expect
    .poll(position, { timeout: 120_000, intervals: [1_000] })
    .toBeGreaterThan(25 * 60_000);
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  const at = await position();
  const near = cues.filter(
    (cue) => cue.endMs >= at - FEEDER_LIMITS.keepMs && cue.startMs <= at + FEEDER_LIMITS.keepMs,
  ).length;
  const held = await translationsHeld(page);
  const asked = chats.length;
  console.log(
    `16x: at ${Math.round(at)} ms, ${held} translations held, ${near} lines within 10 minutes, ${asked} translated`,
  );
  expect(asked, 'lines translated so far').toBeGreaterThan(near);
  expect(held, `translations held at ${at} ms`).toBeLessThanOrEqual(near);
  // On to the end of the track (the rest of the 2 minutes).
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.play());
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.ended), {
      timeout: 40_000,
      intervals: [1_000],
    })
    .toBe(true);
  const tasks = await longTasks(page);
  console.log(`16x: long tasks ${JSON.stringify(tasks)}`);
  expect(tasks.filter((duration) => duration > 50)).toEqual([]);
});

test('the player button and the side panel switch the display everywhere', async ({
  context,
  platform,
  llama,
  serviceWorker,
  sidePanel,
}) => {
  const videoId = 'fixtureDisp';
  await setServer(serviceWorker, llama.origin);
  const cues = fixtureCues({ count: 40, firstMs: 500, everyMs: 1_500, lengthMs: 1_400 });
  await serveWatch(
    context,
    platform,
    {
      videoId,
      title: 'Fixture Quest day 5',
      live: false,
      tracks: [{ languageCode: 'en', kind: 'manual' }],
    },
    { kind: 'video', durationMs: 70_000 },
    cues,
  );
  const first = await openWatch(context, videoId);
  const second = await openWatch(context, videoId);
  const overlays = [await overlayOf(first), await overlayOf(second)];
  await play(first);
  await play(second);
  for (const overlay of overlays) {
    await expect.poll(async () => (await overlay.read()).pill).toBe(`字幕: ${DISPLAY_LABELS.both}`);
    await expect.poll(async () => (await overlay.read()).ja).toMatch(/^訳:Fixture line \d+\.$/u);
  }

  // The pill of the first tab: both → source, in both tabs at once.
  await first.bringToFront();
  await overlays[0]?.clickPill();
  for (const overlay of overlays) {
    await expect
      .poll(async () => (await overlay.read()).pill)
      .toBe(`字幕: ${DISPLAY_LABELS.source}`);
    await expect.poll(async () => (await overlay.read()).ja).toBe('');
    await expect.poll(async () => (await overlay.read()).source).toMatch(/^Fixture line \d+\.$/u);
  }

  // The side panel's radio: Japanese only, in both tabs.
  await sidePanel.reload();
  await sidePanel.getByRole('radio', { name: '日本語のみ' }).check();
  for (const overlay of overlays) {
    await expect.poll(async () => (await overlay.read()).pill).toBe(`字幕: ${DISPLAY_LABELS.ja}`);
    await expect.poll(async () => (await overlay.read()).source).toBe('');
    await expect.poll(async () => (await overlay.read()).ja).toMatch(/^訳:Fixture line \d+\.$/u);
  }
  for (const overlay of overlays) await overlay.detach();
});
