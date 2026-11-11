import type { Page, Worker } from '@playwright/test';
import { expect, STUB_PAGE_PREFIX, test, usedHeap } from '@chrome-toolbox/extension-core/testing';
import { LONG_URL, longHtml } from './fixtures/long.ts';
import {
  fingerprint,
  observerLive,
  progressOf,
  servePage,
  startTranslation,
  tell,
  usePageSettings,
  useServer,
} from './page.ts';

// §9: on a page of 5,000 paragraphs the extension keeps the main thread free (no task over 50 ms:
// scans in 8 ms slices, mode switches and the restore 500 nodes at a time) and its heap under
// 30 MB, while the viewer reads down a good part of it, jumps to the end and back, and switches
// to side by side. The stub answers at once.

test.use({ realVisibility: true });

const COUNT = 5_000;
/** One line a paragraph. */
const HEIGHT = 24;
/** Paragraphs read from the top, a step at a time. */
const READ = 1_500;
const MB = 1024 * 1024;

/** Whether every paragraph near the viewport shows its translation (`replace`) or box (`pair`). */
const nearShown = (page: Page): Promise<boolean> =>
  page.evaluate(
    ({ prefix }) => {
      const top = -window.innerHeight / 2;
      const bottom = window.innerHeight * 1.5;
      return [...document.querySelectorAll('body > p')]
        .filter((p) => {
          const rect = p.getBoundingClientRect();
          return rect.top < bottom && rect.bottom > top;
        })
        .every(
          (p) => p.textContent.startsWith(prefix) || p.querySelector(':scope > pt-ja') !== null,
        );
    },
    { prefix: STUB_PAGE_PREFIX },
  );

async function nearDone(page: Page, serviceWorker: Worker, tabId: number): Promise<void> {
  await expect
    .poll(
      async () => (await progressOf(serviceWorker, tabId)).waiting === 0 && (await nearShown(page)),
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
}

test('a 5,000-paragraph page translates, scrolls and restores without a long task', async ({
  context,
  serviceWorker,
  llama,
  longTasks,
}) => {
  test.setTimeout(120_000);
  await useServer(serviceWorker, llama.origin);
  await servePage(context, LONG_URL, longHtml({ count: COUNT, height: HEIGHT }));
  const page = await context.newPage();
  await page.goto(LONG_URL);
  const before = await fingerprint(page);
  // The page's own load is not the extension's: only the tasks from here on count.
  const loading = (await longTasks(page)).length;
  const heaps: number[] = [];

  const tabId = await startTranslation(context, page);
  await nearDone(page, serviceWorker, tabId);
  const { screen } = await page.evaluate(() => ({ screen: window.innerHeight }));
  // Down from the top as far as the near band allows without passing over a paragraph.
  const step = 2 * screen - HEIGHT - 1;
  for (let top = step; top < READ * HEIGHT; top += step) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
    await nearDone(page, serviceWorker, tabId);
  }
  heaps.push(await usedHeap(page));
  // To the end and back to the middle.
  for (const y of [COUNT * HEIGHT, (COUNT / 2) * HEIGHT]) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await nearDone(page, serviceWorker, tabId);
  }
  const read = await progressOf(serviceWorker, tabId);
  expect(read).toMatchObject({ found: COUNT, failed: 0, waiting: 0 });
  expect(read.done).toBeGreaterThan(READ);
  // Side by side: every translated paragraph gets its box, a slice at a time.
  await usePageSettings(serviceWorker, { mode: 'pair' });
  await expect
    .poll(() => page.locator('pt-ja').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(read.done);
  await nearDone(page, serviceWorker, tabId);
  heaps.push(await usedHeap(page));

  const shown = await progressOf(serviceWorker, tabId);
  await tell(serviceWorker, tabId, { action: 'restore' });
  await expect.poll(async () => (await progressOf(serviceWorker, tabId)).state).toBe('restored');
  expect(await fingerprint(page)).toBe(before);
  heaps.push(await usedHeap(page));

  const tasks = (await longTasks(page)).slice(loading);
  const report = { paragraphs: COUNT, translated: shown.done, cached: shown.cached, heaps, tasks };
  console.log(`perf ${JSON.stringify(report)}`);
  await test.info().attach('perf.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(tasks.filter((duration) => duration > 50)).toEqual([]);
  await observerLive(page, longTasks);
  for (const heap of heaps) expect(heap).toBeLessThan(30 * MB);
});
