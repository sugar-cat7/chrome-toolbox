import { expect, test } from '@chrome-toolbox/extension-core/testing';
import { fingerprint, progressOf, startTranslation, tell, useServer } from './page.ts';

const REAL = process.env.MEASURE_REAL === '1';
const SERVER = process.env.MEASURE_SERVER ?? 'http://127.0.0.1:18083';
const URL = process.env.MEASURE_URL ?? 'https://news.ycombinator.com';

test.use({ realVisibility: true, headless: false });
test.setTimeout(10 * 60 * 1000);

test.describe('restore diff', () => {
  test.skip(!REAL, 'set MEASURE_REAL=1');

  test('shows which fingerprint lines differ after restore', async ({ context, serviceWorker }) => {
    await useServer(serviceWorker, SERVER);
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3_000);
    const before = (await fingerprint(page)).split('\n');
    const tabId = await startTranslation(context, page);
    const deadline = Date.now() + 90_000;
    let progress = await progressOf(serviceWorker, tabId);
    while (Date.now() < deadline && progress.done < 5) {
      await page.waitForTimeout(500);
      progress = await progressOf(serviceWorker, tabId);
    }
    await page.waitForTimeout(5_000);
    await tell(serviceWorker, tabId, { action: 'restore' });
    await expect
      .poll(async () => (await progressOf(serviceWorker, tabId)).state, { timeout: 30_000 })
      .toBe('restored');
    await page.waitForTimeout(1_000);
    const after = (await fingerprint(page)).split('\n');
    const setAfter = new Set(after);
    const missing = before.filter((line) => !setAfter.has(line));
    const setBefore = new Set(before);
    const added = after.filter((line) => !setBefore.has(line));
    console.log(`DIFF missing=${missing.length} added=${added.length}`);
    console.log('MISSING-SAMPLE\n' + missing.slice(0, 15).join('\n'));
    console.log('ADDED-SAMPLE\n' + added.slice(0, 15).join('\n'));
  });
});
