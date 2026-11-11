import { expect, test } from '@chrome-toolbox/extension-core/testing';
import { fingerprint, progressOf, startTranslation, tell, useServer } from './page.ts';
import { mkdirSync } from 'node:fs';

// Task 12 Step 2 layout check (controller-run): five kinds of public English page through the
// real router. Records only pass/issues per kind — no URLs' content or translations are kept.
// MEASURE_REAL=1 only; not part of CI. Screenshots land in artifacts/public-pages/ for review.

const REAL = process.env.MEASURE_REAL === '1';
const SERVER = process.env.MEASURE_SERVER ?? 'http://127.0.0.1:18083';
const SHOTS = 'artifacts/public-pages';

const SITES: readonly { kind: string; url: string }[] = [
  { kind: 'wiki', url: 'https://en.wikipedia.org/wiki/Main_Page' },
  { kind: 'docs', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
  { kind: 'news', url: 'https://www.bbc.com/news' },
  { kind: 'blog', url: 'https://blog.cloudflare.com/' },
  { kind: 'board', url: 'https://news.ycombinator.com' },
];

test.use({ realVisibility: true, headless: false });
test.setTimeout(20 * 60 * 1000);

test.describe('public pages', () => {
  test.skip(!REAL, 'set MEASURE_REAL=1 with a reachable llama.cpp router');

  test('translates, keeps links and forms, and restores five page kinds', async ({
    context,
    serviceWorker,
  }) => {
    await useServer(serviceWorker, SERVER);
    mkdirSync(SHOTS, { recursive: true });
    const report: string[] = [];

    for (const { kind, url } of SITES) {
      const issues: string[] = [];
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error).slice(0, 120)));
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(3_000);
        const before = await fingerprint(page);
        const linksBefore = await page.locator('a[href]').count();
        const formsBefore = await page.locator('input, select, textarea, button').count();
        const tabId = await startTranslation(context, page);
        // Wait for the first units, then a settle window for the viewport batch.
        const deadline = Date.now() + 90_000;
        let progress = await progressOf(serviceWorker, tabId);
        while (Date.now() < deadline && progress.done < 5) {
          await page.waitForTimeout(500);
          progress = await progressOf(serviceWorker, tabId);
        }
        await page.waitForTimeout(5_000);
        progress = await progressOf(serviceWorker, tabId);
        const translated = await page.locator('pt-ja').count();
        const linksAfter = await page.locator('a[href]').count();
        const formsAfter = await page.locator('input, select, textarea, button').count();
        if (progress.done < 5) issues.push(`only ${progress.done} units done`);
        if (translated === 0 && progress.mode === 'pair') issues.push('no pt-ja nodes');
        if (linksAfter !== linksBefore) issues.push(`links ${linksBefore}->${linksAfter}`);
        if (formsAfter !== formsBefore) issues.push(`forms ${formsBefore}->${formsAfter}`);
        if (errors.length > 0) issues.push(`pageerrors: ${errors.slice(0, 2).join(' | ')}`);
        await page.screenshot({ path: `${SHOTS}/${kind}-translated.png`, fullPage: false });
        await tell(serviceWorker, tabId, { action: 'restore' });
        await expect
          .poll(async () => (await progressOf(serviceWorker, tabId)).state, { timeout: 30_000 })
          .toBe('restored');
        const after = await fingerprint(page);
        if (after !== before) issues.push('fingerprint changed after restore');
        await page.screenshot({ path: `${SHOTS}/${kind}-restored.png`, fullPage: false });
        report.push(
          `${kind}: ${issues.length === 0 ? 'ok' : 'ISSUES: ' + issues.join('; ')} ` +
            `(done=${progress.done} failed=${progress.failed} mode=${progress.mode})`,
        );
      } catch (error) {
        report.push(`${kind}: FAILED ${String(error).slice(0, 160)}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    console.log('PUBLIC-REPORT\n' + report.join('\n'));
    expect(report.every((line) => !line.includes('FAILED'))).toBe(true);
  });
});
