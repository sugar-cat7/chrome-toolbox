import { expect, test, usedHeap } from '@chrome-toolbox/extension-core/testing';
import { LONG_URL } from './fixtures/long.ts';
import { progressOf, servePage, startTranslation, usePageSettings, useServer } from './page.ts';

// Task 12 Step 2 (controller-run, real server): first-screen timing of the page translator
// against the live llama.cpp router, once per translator model. Not part of CI: it needs
// MEASURE_REAL=1 and a reachable router at MEASURE_SERVER (default 127.0.0.1:18083).
// Paragraph texts are unique per round so the extension's translation cache cannot answer.

const REAL = process.env.MEASURE_REAL === '1';
const SERVER = process.env.MEASURE_SERVER ?? 'http://127.0.0.1:18083';
const ROUNDS = 5;
const COUNT = 300;
const HEIGHT = 100;

const ENDINGS = [
  'the night crew counted the boats twice.',
  'a gull stole the last biscuit of the cook.',
  'fog rolled in before the lamps were lit, and the bell rang for an hour.',
  'nobody wrote down the name of the trawler.',
  'the tide came in early and soaked the nets.',
] as const;

function roundHtml(round: number): string {
  const paragraphs = Array.from({ length: COUNT }, (_, i) => {
    const n = i + 1 + round * 100_000;
    return `<p id="p${i + 1}">Harbor log ${n}: ${ENDINGS[n % ENDINGS.length]}</p>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Harbor log</title>
<style>body{margin:0;font:16px/20px sans-serif}p{height:${HEIGHT}px;margin:0;overflow:hidden}</style>
</head><body>${paragraphs}</body></html>`;
}

/** Whether every paragraph touching the viewport lost its English marker text. */
const screenTranslated = (page: import('@playwright/test').Page): Promise<boolean> =>
  page.evaluate(() => {
    const top = 0;
    const bottom = window.innerHeight;
    return [...document.querySelectorAll('body > p')].every((p) => {
      const rect = p.getBoundingClientRect();
      if (rect.bottom <= top || rect.top >= bottom) return true;
      return !p.textContent.includes('Harbor log');
    });
  });

test.use({ realVisibility: true, headless: false });
test.setTimeout(30 * 60 * 1000);

test.describe('real-server measurement', () => {
  test.skip(!REAL, 'set MEASURE_REAL=1 with a reachable llama.cpp router');

  test('first-screen timing per translator, 5 rounds each', async ({ context, serviceWorker }) => {
    await useServer(serviceWorker, SERVER);
    const results: Record<
      string,
      { first: number[]; screen: number[]; heapStart: number; heapEnd: number }
    > = {};

    for (const translator of ['gemma', 'plamo'] as const) {
      await usePageSettings(serviceWorker, { translator });
      results[translator] = { first: [], screen: [], heapStart: 0, heapEnd: 0 };
      for (let round = 0; round < ROUNDS + 1; round++) {
        const warmup = round === 0;
        const url = `${LONG_URL}?r=${translator}-${round}`;
        await servePage(context, url, roundHtml(round));
        const page = await context.newPage();
        await page.goto(url);
        const heapStart = await usedHeap(page);
        const t0 = Date.now();
        const tabId = await startTranslation(context, page);
        // First paragraph done: poll progress until one unit completes.
        let tFirst = -1;
        const deadline = t0 + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          const progress = await progressOf(serviceWorker, tabId);
          if (progress.done >= 1) {
            tFirst = Date.now() - t0;
            break;
          }
          await page.waitForTimeout(50);
        }
        // First screen fully translated.
        let tScreen = -1;
        while (Date.now() < deadline) {
          if (await screenTranslated(page)) {
            tScreen = Date.now() - t0;
            break;
          }
          await page.waitForTimeout(100);
        }
        const heapEnd = await usedHeap(page);
        const progress = await progressOf(serviceWorker, tabId);
        console.log(
          `MEASURE ${translator} round=${round} warmup=${warmup} first=${tFirst}ms screen=${tScreen}ms ` +
            `done=${progress.done} waiting=${progress.waiting} failed=${progress.failed} ` +
            `translator=${progress.translator ?? '-'} heap=${heapStart}->${heapEnd}`,
        );
        if (!warmup) {
          results[translator].first.push(tFirst);
          results[translator].screen.push(tScreen);
          results[translator].heapStart = heapStart;
          results[translator].heapEnd = heapEnd;
        }
        await page.close();
      }
      const pick = (xs: number[]) => [...xs].sort((a, b) => a - b);
      const p50 = (xs: number[]) => pick(xs)[Math.floor(xs.length / 2)];
      const max = (xs: number[]) => Math.max(...xs);
      console.log(
        `MEASURE-SUMMARY ${translator} first-p50=${p50(results[translator].first)}ms ` +
          `first-max=${max(results[translator].first)}ms screen-p50=${p50(results[translator].screen)}ms ` +
          `screen-max=${max(results[translator].screen)}ms`,
      );
    }
    expect(true).toBe(true);
  });
});
