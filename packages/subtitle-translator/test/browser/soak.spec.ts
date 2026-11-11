import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import {
  heapSnapshotParts,
  offscreenTarget,
  triggerAction,
  usedHeap,
  type DocumentTarget,
} from '@chrome-toolbox/extension-core/testing';
import { SOAK_WARM_UP, soakMinutes, soakTimeout } from '../../../../tools/quality/soak.ts';
import { expect, setServer, test } from './server.ts';
import { openWatch, play, recordChats, serveWatch, sessionState, TONES } from './subtitles.ts';

// Speech subtitles left running (R47): the tones play on a watch page whose audio is captured for
// SOAK_MINUTES (2 by default, 120 for the long run), and neither the watch page nor the offscreen
// document grows, blocks its thread or falls behind the stub.
test.use({ captureAudio: true });

const SOAK_MINUTES = soakMinutes();
/**
 * Before the first measurement the bounded buffers fill: the pipeline's queues and sentence
 * context, the live view and its timers, the translator's status.
 */
const WARM_UP_MS = SOAK_WARM_UP;
const MB = 1024 * 1024;
const VIDEO = 'fixtureSoak';

/** An 80 ms task of the document's own, which its long task observer must see. */
const BUSY_80_MS = `new Promise((resolve) => setTimeout(() => {
  const begin = performance.now();
  while (performance.now() - begin < 80);
  resolve(undefined);
}, 0))`;

test('SOAK_MINUTES of audio subtitles keeps heap and long tasks within budget', async ({
  context,
  platform,
  llama,
  serviceWorker,
  longTasks,
}) => {
  test.setTimeout(soakTimeout(SOAK_MINUTES));
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  await serveWatch(
    context,
    platform,
    { videoId: VIDEO, title: 'Fixture Talk', live: true, tracks: [] },
    TONES,
  );
  const watch: Page = await openWatch(context, VIDEO);
  // From now on the watch page keeps every long task (and those since it loaded).
  await longTasks(watch);
  await play(watch);
  await triggerAction(context, watch);
  const offscreen: DocumentTarget = await offscreenTarget(context, '/offscreen.html');
  await offscreen.longTasks();
  await expect.poll(() => chats.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await sleep(WARM_UP_MS);

  const start = { watch: await usedHeap(watch), offscreen: await offscreen.usedHeap() };
  const parts = { watch: await heapSnapshotParts(watch), offscreen: await offscreen.heapParts() };
  // Minute k is sampled k minutes after this, by the clock (see the comment assistant's soak).
  const began = Date.now();
  let end = { minute: 0, ...start, stats: (await sessionState(serviceWorker)).stats };
  const samples = [end];
  for (let minute = 1; minute <= SOAK_MINUTES; minute += 1) {
    await sleep(Math.max(0, began + minute * 60_000 - Date.now()));
    end = {
      minute,
      watch: await usedHeap(watch),
      offscreen: await offscreen.usedHeap(),
      stats: (await sessionState(serviceWorker)).stats,
    };
    samples.push(end);
  }
  const partsEnd = {
    watch: await heapSnapshotParts(watch),
    offscreen: await offscreen.heapParts(),
  };
  const tasks = { watch: await longTasks(watch), offscreen: await offscreen.longTasks() };
  const report = {
    minutes: SOAK_MINUTES,
    chats: chats.length,
    recognitions: chats.filter((chat) => chat.audio > 0).length,
    longTasks: tasks,
    samples,
    parts: { start: parts, end: partsEnd },
  };
  console.log(`soak ${JSON.stringify(report)}`);
  await test.info().attach('soak.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });

  for (const sample of samples) {
    expect(sample.watch, `watch page heap at minute ${sample.minute}`).toBeLessThan(30 * MB);
    expect(sample.offscreen, `offscreen heap at minute ${sample.minute}`).toBeLessThan(30 * MB);
    expect(sample.watch, `watch page heap at minute ${sample.minute}`).toBeLessThan(
      start.watch * 2,
    );
    expect(sample.offscreen, `offscreen heap at minute ${sample.minute}`).toBeLessThan(
      start.offscreen * 2,
    );
  }
  // What a leak grows (objects, strings, closures; not the code V8 compiles) stays within 1.1×.
  expect(
    partsEnd.watch.data,
    `watch page objects grew from ${parts.watch.data}`,
  ).toBeLessThanOrEqual(parts.watch.data * 1.1);
  expect(
    partsEnd.offscreen.data,
    `offscreen objects grew from ${parts.offscreen.data}`,
  ).toBeLessThanOrEqual(parts.offscreen.data * 1.1);
  expect(tasks.watch.filter((duration) => duration > 50)).toEqual([]);
  expect(tasks.offscreen.filter((duration) => duration > 50)).toEqual([]);
  // The stub answers at once: every utterance was recognized and every sentence translated.
  expect(end.stats.segments).toBeGreaterThan(SOAK_MINUTES * 30);
  expect(end.stats).toMatchObject({ dropped: 0, expired: 0, skipped: 0, failed: 0 });

  // Both observers are live: a task of the document's own over 50 ms shows up.
  await watch.evaluate(BUSY_80_MS);
  await expect
    .poll(async () => (await longTasks(watch)).filter((duration) => duration > 50).length)
    .toBe(1);
  await offscreen.evaluate(BUSY_80_MS);
  await expect
    .poll(async () => (await offscreen.longTasks()).filter((duration) => duration > 50).length)
    .toBe(1);
  await offscreen.detach();
});
