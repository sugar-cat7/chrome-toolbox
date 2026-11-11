import type { Page, Worker } from '@playwright/test';
import { expect, STUB_PAGE_PREFIX, test } from '@chrome-toolbox/extension-core/testing';
import { LONG_COUNT, LONG_HEIGHT, LONG_URL, longHtml, longNumberOf } from './fixtures/long.ts';
import {
  progressOf,
  recordBatches,
  servePage,
  startTranslation,
  useServer,
  type Batches,
} from './page.ts';

// Spec §8: a long page never sends what is off screen in one go. Paragraphs are asked for as they
// come within half a screen of the viewport (`rootMargin: '50% 0px'`), one batch of at most 6 at a
// time, and each text once.

test.use({ realVisibility: true });

/** The stub answers each batch this long after it was asked. */
const DELAY_MS = 300;

/** The numbers of the paragraphs asked for, batch by batch from `from`. */
const askedFrom = (batches: Batches, from = 0): number[] =>
  batches.asked.slice(from).flatMap(({ texts }) => texts.map((text) => longNumberOf(text) ?? 0));

/**
 * The paragraphs within half a screen of the viewport now, which the page script asks for: all
 * those whose box meets the band from half a screen above the viewport to half a screen below.
 */
const nearNow = (page: Page): Promise<number[]> =>
  page.evaluate(
    ({ count, height }) => {
      const top = window.scrollY - window.innerHeight / 2;
      const bottom = window.scrollY + window.innerHeight * 1.5;
      return Array.from({ length: count }, (_, i) => i + 1).filter(
        (n) => (n - 1) * height < bottom && n * height > top,
      );
    },
    { count: LONG_COUNT, height: LONG_HEIGHT },
  );

/** Waits until the paragraphs near the viewport are translated and nothing waits. */
async function nearDone(page: Page, serviceWorker: Worker, tabId: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const near = await nearNow(page);
        const texts = await page.evaluate(
          (numbers) => numbers.map((n) => document.getElementById(`p${n}`)?.textContent ?? ''),
          near,
        );
        const { waiting } = await progressOf(serviceWorker, tabId);
        return waiting === 0 && texts.every((text) => text.startsWith(STUB_PAGE_PREFIX));
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('a long page sends no off-screen burst', async ({ context, serviceWorker, llama }) => {
  test.setTimeout(90_000);
  await useServer(serviceWorker, llama.origin);
  const batches = recordBatches(llama, DELAY_MS);
  await servePage(context, LONG_URL, longHtml());
  const page = await context.newPage();
  await page.goto(LONG_URL);

  // At the top: only the paragraphs near the first screen.
  const tabId = await startTranslation(context, page);
  await nearDone(page, serviceWorker, tabId);
  const first = askedFrom(batches);
  expect(first.length).toBeGreaterThan(0);
  for (const n of first) expect(n).toBeGreaterThanOrEqual(1);
  for (const n of first) expect(n).toBeLessThanOrEqual(16);
  expect(new Set(first)).toEqual(new Set(await nearNow(page)));
  for (const batch of batches.asked) expect(batch.texts.length).toBeLessThanOrEqual(6);
  expect(batches.mostAtOnce).toBe(1);

  // A jump to paragraph 150: only the paragraphs around it, none of those it passed over.
  const jumped = batches.asked.length;
  await page.evaluate((top) => window.scrollTo(0, top), 149 * LONG_HEIGHT);
  await nearDone(page, serviceWorker, tabId);
  const around = askedFrom(batches, jumped);
  expect(around.length).toBeGreaterThan(0);
  for (const n of around) expect(n).toBeGreaterThanOrEqual(135);
  for (const n of around) expect(n).toBeLessThanOrEqual(166);
  const passed = new Set(range(17, 134));
  expect(askedFrom(batches).filter((n) => passed.has(n))).toEqual([]);

  // Down the whole page from the top, as far as the near band (two screens) allows without
  // passing over a paragraph: each paragraph is asked for once.
  const { screen, bottom } = await page.evaluate(() => ({
    screen: window.innerHeight,
    bottom: (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight,
  }));
  const step = 2 * screen - LONG_HEIGHT - 1;
  for (let top = 0; ; top = Math.min(top + step, bottom)) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
    await nearDone(page, serviceWorker, tabId);
    if (top === bottom) break;
  }
  const all = askedFrom(batches);
  const report = {
    screen,
    first: first.toSorted((a, b) => a - b),
    around: around.toSorted((a, b) => a - b),
    batches: batches.asked.length,
    largest: Math.max(...batches.asked.map((batch) => batch.texts.length)),
    mostAtOnce: batches.mostAtOnce,
  };
  console.log(`scroll ${JSON.stringify(report)}`);
  expect(all.toSorted((a, b) => a - b)).toEqual(range(1, LONG_COUNT));
  for (const batch of batches.asked) expect(batch.texts.length).toBeLessThanOrEqual(6);
  expect(batches.mostAtOnce).toBe(1);
  const progress = await progressOf(serviceWorker, tabId);
  expect(progress).toMatchObject({ found: LONG_COUNT, done: LONG_COUNT, failed: 0 });
});
