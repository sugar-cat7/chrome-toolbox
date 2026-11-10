import { expect, test, usedHeap } from '@chrome-toolbox/extension-core/testing';
import { LONG_URL, longHtml } from './fixtures/long.ts';
import { progressOf, servePage, startTranslation, useServer } from './page.ts';

// Task 12 Step 2 helper (controller-run): translate the long made-up page with the real
// router and scroll to the bottom, so a concurrent bench:slots run measures subtitle
// latency under page-translation load. MEASURE_REAL=1 only; not part of CI.

const REAL = process.env.MEASURE_REAL === '1';
const SERVER = process.env.MEASURE_SERVER ?? 'http://127.0.0.1:18083';

test.use({ realVisibility: true, headless: false });
test.setTimeout(10 * 60 * 1000);

test.describe('real-server load', () => {
  test.skip(!REAL, 'set MEASURE_REAL=1 with a reachable llama.cpp router');

  test('translates the long page while scrolling to the bottom', async ({
    context,
    serviceWorker,
  }) => {
    await useServer(serviceWorker, SERVER);
    await servePage(context, `${LONG_URL}?load=1`, longHtml());
    const page = await context.newPage();
    await page.goto(`${LONG_URL}?load=1`);
    const heapStart = await usedHeap(page);
    const t0 = Date.now();
    const tabId = await startTranslation(context, page);
    // Scroll the whole page over ~70 s so every paragraph enters the viewport batch.
    const height = await page.evaluate(() => document.body.scrollHeight);
    const steps = 40;
    for (let i = 1; i <= steps; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), (height * i) / steps);
      await page.waitForTimeout(1_700);
    }
    // Let the tail of the page finish.
    const deadline = Date.now() + 120_000;
    let progress = await progressOf(serviceWorker, tabId);
    while (Date.now() < deadline && progress.waiting > 0) {
      await page.waitForTimeout(1_000);
      progress = await progressOf(serviceWorker, tabId);
    }
    const heapEnd = await usedHeap(page);
    console.log(
      `LOAD ${Date.now() - t0}ms done=${progress.done} waiting=${progress.waiting} ` +
        `failed=${progress.failed} translator=${progress.translator ?? '-'} ` +
        `heap=${heapStart}->${heapEnd}`,
    );
    expect(progress.failed).toBe(0);
  });
});
