import { setTimeout as sleep } from 'node:timers/promises';
import type { CDPSession, Page } from '@playwright/test';
import { expect, heapSnapshotParts, test, usedHeap } from '@chrome-toolbox/extension-core/testing';
import { SOAK_WARM_UP, soakMinutes, soakTimeout } from '../../../../tools/quality/soak.ts';
import { PAGE_LIMITS } from '../../src/content/scheduler.ts';
import { FEED_URL, feedHtml } from './fixtures/feed.ts';
import { longText } from './fixtures/long.ts';
import {
  observerLive,
  progressOf,
  recordBatches,
  servePage,
  startTranslation,
  useServer,
} from './page.ts';

// R47 and §9 on a page that never stops growing: a feed adds 5 posts a second and drops the
// oldest past 200, and the viewer follows it to the bottom every second. The page script keeps
// its heap, its long tasks and its records bounded for SOAK_MINUTES (2 by default, 120 for the
// long run). Also the scheduler's refill with thousands of paragraphs near the viewport: its cost
// a batch stays flat (Task 6), with no long task.

test.use({ realVisibility: true });

const SOAK_MINUTES = soakMinutes();
const MB = 1024 * 1024;
/**
 * The warm-up's backlog: posts added (and followed) every 100 ms on top of the feed's own, until
 * the page's translation cache is full. At the feed's 5 a second, its 2,000 translations would
 * take 400 s; this fills them within the warm-up, as R47 has every bounded buffer filled before
 * the first measurement. (Measured without it: the snapshot's data grew 14% in 2 minutes, all of
 * it new cache entries, about 320 bytes each.)
 */
const BACKLOG = 4;

test('SOAK_MINUTES on a growing feed keeps heap and long tasks within budget', async ({
  context,
  serviceWorker,
  llama,
  longTasks,
}) => {
  test.setTimeout(soakTimeout(SOAK_MINUTES));
  await useServer(serviceWorker, llama.origin);
  await servePage(context, FEED_URL, feedHtml);
  const page = await context.newPage();
  await page.goto(FEED_URL);
  // From now on the page keeps every long task (those of its load are its own).
  const loading = (await longTasks(page)).length;
  const tabId = await startTranslation(context, page);
  const warming = Date.now();
  // The warm-up: a backlog of posts, followed as they come, until the cache is full.
  while ((await progressOf(serviceWorker, tabId)).cached < PAGE_LIMITS.cache) {
    expect(Date.now() - warming, 'the cache fills within the warm-up').toBeLessThan(
      SOAK_WARM_UP - 5_000,
    );
    await page.evaluate((count) => {
      (Reflect.get(window, 'fixturePost') as (count: number) => void)(count);
      window.scrollTo(0, document.scrollingElement?.scrollHeight ?? 0);
    }, BACKLOG);
    await sleep(100);
  }
  const filledMs = Date.now() - warming;
  // From now on the feed adds its 5 posts a second, and the viewer follows it every second.
  let following = true;
  const follow = (async (): Promise<void> => {
    while (following) {
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement?.scrollHeight ?? 0));
      await sleep(1_000);
    }
  })();
  const sample = async (minute: number) => {
    const { tracked, cached, done, failed, waiting } = await progressOf(serviceWorker, tabId);
    return { minute, heap: await usedHeap(page), tracked, cached, done, failed, waiting };
  };

  await sleep(Math.max(0, warming + SOAK_WARM_UP - Date.now()));
  const startParts = await heapSnapshotParts(page);
  const start = await sample(0);
  expect(start.cached).toBe(PAGE_LIMITS.cache);
  const samples = [start];
  // Minute k is sampled k minutes after this, by the clock.
  const began = Date.now();
  for (let minute = 1; minute <= SOAK_MINUTES; minute += 1) {
    await sleep(Math.max(0, began + minute * 60_000 - Date.now()));
    samples.push(await sample(minute));
  }
  const endParts = await heapSnapshotParts(page);
  following = false;
  await follow;
  const tasks = (await longTasks(page)).slice(loading);
  const posted = Number(await page.evaluate(() => Reflect.get(window, 'fixturePosted')));
  const report = {
    minutes: SOAK_MINUTES,
    filledMs,
    posted,
    longTasks: tasks,
    samples,
    parts: { start: startParts, end: endParts },
  };
  console.log(`soak ${JSON.stringify(report)}`);
  await test.info().attach('soak.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });

  // The feed kept being translated: the newest posts at the bottom are. Draining the queue
  // outlasts the default 5 s poll on a loaded runner.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.post p')]
            .slice(-5)
            .every((post) => post.textContent.startsWith('訳:')),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const end = samples.at(-1) ?? start;
  expect(end.failed).toBe(0);
  expect(endParts.data, `heap data grew from ${startParts.data}`).toBeLessThanOrEqual(
    startParts.data * 1.1,
  );
  for (const { minute, heap, tracked, cached } of samples) {
    expect(heap, `heap at minute ${minute}`).toBeLessThan(30 * MB);
    expect(heap, `heap at minute ${minute}`).toBeLessThan(start.heap * 2);
    expect(tracked, `tracked at minute ${minute}`).toBeLessThanOrEqual(PAGE_LIMITS.tracked);
    expect(cached, `cached at minute ${minute}`).toBeLessThanOrEqual(PAGE_LIMITS.cache);
  }
  expect(tasks.filter((duration) => duration > 50)).toEqual([]);
  await observerLive(page, longTasks);
});

/**
 * The page's main thread time so far, in ms of thread CPU time (CDP `Performance.getMetrics`):
 * `work`, its tasks apart from layout, style and the test's own DevTools commands (the scripts,
 * the extension's messages, the observers), and `layout`.
 */
async function threadMs(session: CDPSession): Promise<{ work: number; layout: number }> {
  const { metrics } = await session.send('Performance.getMetrics');
  const ms = (name: string): number =>
    (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return {
    work:
      ms('TaskDuration') -
      ms('LayoutDuration') -
      ms('RecalcStyleDuration') -
      ms('DevToolsCommandDuration'),
    layout: ms('LayoutDuration'),
  };
}

/** Paragraphs near the viewport at once: ten times the waiting list, so most are left out. */
const DENSE = 4_000;
const DENSE_URL = 'https://log.fixture.test/dense';
/**
 * `DENSE` paragraphs 1 px high (their text clipped), in a viewport tall enough that all of them
 * are within the near band at once.
 */
const denseHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Harbor log, dense</title>
    <style>body { margin: 0; } p { height: 1px; margin: 0; overflow: hidden; font: 1px/1px sans-serif; }</style>
  </head>
  <body>${Array.from({ length: DENSE }, (_, i) => `<p>${longText(i + 1)}</p>`).join('')}</body>
</html>`;
/** Parts the batches after the scan are cut into, to compare their cost from first to last. */
const PARTS = 4;

/**
 * A fixed DOM+JS workload in the page being measured: reading every paragraph's text and a
 * plain loop, the same mix of work the refill does. Its wall time scales with the host's
 * speed, so it calibrates the per-batch bound for shared CI runners.
 */
async function hostProbe(page: Page): Promise<number> {
  const { ms } = await page.evaluate(() => {
    const began = performance.now();
    let sink = 0;
    for (const p of document.querySelectorAll('p')) sink += p.textContent?.length ?? 0;
    for (let i = 0; i < 1_000_000; i += 1) sink += i % 13;
    return { ms: performance.now() - began, sink };
  });
  return ms;
}

test('thousands of paragraphs near the viewport are asked for at a flat cost a batch', async ({
  context,
  serviceWorker,
  llama,
  longTasks,
}) => {
  test.setTimeout(120_000);
  expect(DENSE).toBeGreaterThanOrEqual(10 * PAGE_LIMITS.waiting);
  await useServer(serviceWorker, llama.origin);
  const batches = recordBatches(llama);
  await servePage(context, DENSE_URL, denseHtml);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 2_700 });
  await page.goto(DENSE_URL);
  // Before the translation starts (so its tasks stay out of the long-task check below), probe
  // the host's speed for the per-batch bound further down.
  const probeMs = await hostProbe(page);
  const loading = (await longTasks(page)).length;
  const session = await context.newCDPSession(page);
  // Thread CPU time: what the page's thread spent, not how long a busy host made it wait.
  await session.send('Performance.enable', { timeDomain: 'threadTicks' });
  const tabId = await startTranslation(context, page);
  // Every paragraph comes near at once: 400 units wait and the rest are left out, put in the
  // waiting list a batch at a time. The main thread's work is read as the batches go.
  const points: { batches: number; found: number; work: number; layout: number }[] = [];
  for (;;) {
    const { found, done, failed } = await progressOf(serviceWorker, tabId);
    expect(failed).toBe(0);
    points.push({ batches: batches.asked.length, found, ...(await threadMs(session)) });
    if (done >= DENSE) break;
    await sleep(250);
  }
  const tasks = (await longTasks(page)).slice(loading);
  // From the first point after the scan took every paragraph in, each part's work a batch: from
  // the point nearest its first batch to the one nearest its last.
  const measured = points.slice(points.findIndex((point) => point.found === DENSE));
  const first = measured[0]?.batches ?? 0;
  const total = batches.asked.length;
  const at = (batch: number): (typeof points)[number] =>
    measured.reduce((best, point) =>
      Math.abs(point.batches - batch) < Math.abs(best.batches - batch) ? point : best,
    );
  const parts = Array.from({ length: PARTS }, (_, i) => {
    const from = at(first + (i * (total - first)) / PARTS);
    const to = at(first + ((i + 1) * (total - first)) / PARTS);
    const count = Math.max(1, to.batches - from.batches);
    return {
      batches: count,
      workMs: (to.work - from.work) / count,
      layoutMs: (to.layout - from.layout) / count,
    };
  });
  const report = { paragraphs: DENSE, batches: total, scanned: first, probeMs, parts, tasks };
  console.log(`refill ${JSON.stringify(report)}`);
  await test.info().attach('refill.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(total).toBe(Math.ceil(DENSE / PAGE_LIMITS.batchUnits));
  expect(total - first).toBeGreaterThan(total / 2);
  // A batch costs the same with 3,600 paragraphs left out as with a few: the refill goes on where
  // it stopped (Task 6). The refill before it, which sorted the near blocks and read their
  // paragraphs for each batch, took 21 ms a batch here at first and 6 ms at the end; this one
  // takes about 1.5 ms all along.
  const work = parts.map((part) => part.workMs);
  expect(Math.max(...work)).toBeLessThanOrEqual(2 * Math.min(...work));
  // Absolute milliseconds scale with the host (~1.5 ms a batch on the development machine,
  // ~12 ms on a shared CI runner), so the bound tracks the probe's cost, never under 5 ms.
  const bound = Math.max(5, probeMs * 3);
  for (const part of parts) expect(part.workMs).toBeLessThan(bound);
  // And no task of the page goes over 50 ms.
  expect(tasks.filter((duration) => duration > 50)).toEqual([]);
  await observerLive(page, longTasks);
});
