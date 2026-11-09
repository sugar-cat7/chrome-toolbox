import { setTimeout as sleep } from 'node:timers/promises';
import type { Page, Worker } from '@playwright/test';
import {
  defaultResponder,
  expect,
  STUB_PAGE_PREFIX,
  test,
  type StubReply,
} from '@chrome-toolbox/extension-core/testing';
import { DISPLAY_MODES, type DisplayMode } from '../../src/protocol.ts';
import { openArticle } from './fixtures/article.ts';
import { LONG_URL, longHtml } from './fixtures/long.ts';
import {
  fingerprint,
  NO_SERVER,
  progressOf,
  reloadExtension,
  servePage,
  startTranslation,
  tabIdOf,
  tell,
  untilTranslated,
  usePageSettings,
  useServer,
  type WorkerChrome,
} from './page.ts';

// Spec §8: a restored page is the page before translation, node for node (Global Constraints:
// kinds, names, attributes, text, open shadow roots, the same nodes), and a text the page itself
// rewrote keeps the page's value. Also the page script's life: pressing the button again (P18),
// a reloaded extension (P28), restoring while a batch is out or with a translate right behind it
// (P27), and the bfcache.

test.use({ realVisibility: true });

/**
 * Whether the text nodes the page's script kept at load are still in the page, in the same order,
 * each holding its data then.
 */
const refsAsLoaded = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const refs = Reflect.get(window, 'fixtureRefs') as { texts: Text[]; originals: string[] };
    const now: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
      if (node instanceof Text) now.push(node);
    const places = refs.texts.map((text) => now.indexOf(text));
    return (
      places.every((place, i) => place >= 0 && (i === 0 || place > (places[i - 1] ?? -1))) &&
      refs.texts.every((text, i) => text.data === refs.originals[i])
    );
  });

/** Restores the tab as the popup does and waits until the page script says it is done. */
async function restore(serviceWorker: Worker, tabId: number): Promise<void> {
  await tell(serviceWorker, tabId, { action: 'restore' });
  await expect.poll(async () => (await progressOf(serviceWorker, tabId)).state).toBe('restored');
}

/** Waits until every paragraph shows `mode`: boxes side by side, or none and the text replaced. */
async function shows(page: Page, mode: DisplayMode): Promise<void> {
  const heading = page.locator('h1').first();
  if (mode === 'pair') {
    await expect(page.locator('h1 > pt-ja')).toHaveCount(1);
    await expect.poll(() => heading.evaluate((h1) => h1.textContent)).toBe('Vesper the Tidebound');
  } else {
    await expect(page.locator('pt-ja')).toHaveCount(0);
    await expect
      .poll(() => heading.evaluate((h1) => h1.textContent))
      .toBe(`${STUB_PAGE_PREFIX}Vesper the Tidebound`);
  }
}

for (const mode of DISPLAY_MODES) {
  test(`restoring gives back the identical DOM after ${mode}`, async ({
    context,
    serviceWorker,
    llama,
  }) => {
    await useServer(serviceWorker, llama.origin);
    await usePageSettings(serviceWorker, { mode });
    const page = await openArticle(context);
    const before = await fingerprint(page);
    const tabId = await startTranslation(context, page);
    expect(await untilTranslated(serviceWorker, tabId)).toMatchObject({ mode, failed: 0 });
    await shows(page, mode);
    expect(await fingerprint(page)).not.toBe(before);

    await restore(serviceWorker, tabId);
    expect(await fingerprint(page)).toBe(before);
    expect(await refsAsLoaded(page)).toBe(true);
  });
}

test('switching modes back and forth still restores the identical DOM', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  await usePageSettings(serviceWorker, { mode: 'replace' });
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  await untilTranslated(serviceWorker, tabId);
  // The setting changes in every tab at once, as the popup's switch saves it.
  for (const mode of ['pair', 'replace', 'pair'] as const) {
    await usePageSettings(serviceWorker, { mode });
    await shows(page, mode);
  }
  await restore(serviceWorker, tabId);
  expect(await fingerprint(page)).toBe(before);
  expect(await refsAsLoaded(page)).toBe(true);
});

test('a text the page rewrote after translation keeps the page value on restore', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  await untilTranslated(serviceWorker, tabId);
  /** The page's own script sets the data of the text node that held `original` at load. */
  const rewrite = (original: string, data: string): Promise<void> =>
    page.evaluate(
      ({ original, data }) => {
        const refs = Reflect.get(window, 'fixtureRefs') as { texts: Text[]; originals: string[] };
        const text = refs.texts[refs.originals.indexOf(original)];
        if (text === undefined) throw new Error(`no text node held ${original}`);
        text.data = data;
      },
      { original, data },
    );
  // The comment count: the page's change is read (300 ms later) and translated in its turn.
  await rewrite('Comments', '4 comments');
  await expect(page.locator('#comments')).toHaveText(`${STUB_PAGE_PREFIX}4 comments`);
  await untilTranslated(serviceWorker, tabId);
  // A heading the page rewrites just before the restore, before its change is even read.
  await rewrite('Lore', 'Lore and legends');
  await restore(serviceWorker, tabId);
  await expect(page.locator('#comments')).toHaveText('4 comments');
  await expect(page.locator('#lore')).toHaveText('Lore and legends');
  const expected = before
    .replace(JSON.stringify('Comments'), JSON.stringify('4 comments'))
    .replace(JSON.stringify('Lore'), JSON.stringify('Lore and legends'));
  expect(expected).not.toBe(before);
  expect(await fingerprint(page)).toBe(expected);
});

test('pressing the button again keeps the translation and goes on (P18)', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  const first = await untilTranslated(serviceWorker, tabId);
  const translated = await fingerprint(page);
  // The second injection ends the first one's WXT context: the session carries on regardless.
  await startTranslation(context, page);
  for (let check = 0; check < 5; check += 1) {
    await sleep(200);
    expect(await fingerprint(page)).toBe(translated);
  }
  expect(await untilTranslated(serviceWorker, tabId)).toMatchObject({
    found: first.found,
    done: first.done,
  });
  await restore(serviceWorker, tabId);
  expect(await fingerprint(page)).toBe(before);
});

test('after the extension reloads, the old copy gives the page back as the new one starts (P28)', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  await untilTranslated(serviceWorker, tabId);
  const worker = await reloadExtension(context);
  // The new copy cannot translate (no server): whatever translation shows would be the old one's.
  await useServer(worker, NO_SERVER);
  await startTranslation(context, page);
  await expect.poll(() => fingerprint(page)).toBe(before);
  expect(await refsAsLoaded(page)).toBe(true);
  expect(await tabIdOf(worker, page)).toBe(tabId);
});

test('a batch answered after the restore writes nothing (P27)', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  // The stub holds every chat completion until the test lets it answer.
  let release = (): void => undefined;
  let held = 0;
  llama.respond = async (request): Promise<StubReply> => {
    if (request.path === '/v1/chat/completions') {
      held += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return defaultResponder(request);
  };
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  await expect.poll(() => held).toBe(1);
  // Restored while the first batch is out: the scheduler stops before the page is restored.
  await restore(serviceWorker, tabId);
  release();
  await sleep(500);
  expect(await fingerprint(page)).toBe(before);
  expect(held).toBe(1);
});

test('a translate sent with a restore of 1,200 paragraphs waits for it and reads the original (P27)', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const count = 1_200;
  await servePage(context, LONG_URL, longHtml({ count, height: 1 }));
  const page = await context.newPage();
  // Every paragraph near: 1,200 nodes to restore, 500 a slice.
  await page.setViewportSize({ width: 1280, height: 1_000 });
  await page.goto(LONG_URL);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  expect(await untilTranslated(serviceWorker, tabId)).toMatchObject({ found: count, done: count });
  // Both commands at once, as a viewer pressing 「原文に戻す」 then 「このページを翻訳」 quickly: the
  // translate comes while the restore's slices run, and waits for the last of them.
  await serviceWorker.evaluate((tabId) => {
    const { chrome } = globalThis as unknown as { chrome: WorkerChrome };
    const send = (action: string): Promise<unknown> =>
      chrome.tabs.sendMessage(tabId, { type: 'page/command', payload: { action } }, { frameId: 0 });
    return Promise.all([send('restore'), send('translate')]);
  }, tabId);
  expect(await untilTranslated(serviceWorker, tabId)).toMatchObject({ found: count, done: count });
  // Translated from the page's own text: no paragraph was read while it still held a translation.
  const texts = await page
    .locator('p')
    .evaluateAll((paragraphs) => paragraphs.map((paragraph) => paragraph.textContent));
  expect(texts.filter((text) => !/^訳:Harbor log \d+:/u.test(text))).toEqual([]);
  await restore(serviceWorker, tabId);
  expect(await fingerprint(page)).toBe(before);
});

test('a page that goes into the bfcache comes back with its original, then is translated again', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await startTranslation(context, page);
  await untilTranslated(serviceWorker, tabId);
  const next = 'https://wiki.fixture.test/areas/sunken-choir';
  await context.route(next, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Sunken Choir</title><p>The next made-up page.</p>',
    }),
  );
  await page.goto(next);
  // A page shown again from the bfcache does not load again: no load event to wait for.
  await page.goBack({ waitUntil: 'commit' });
  // Back from the bfcache: the same document, shown again.
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'fixtureShows')))
    .toEqual([false, true]);
  // It went in with its original (`pagehide`), so the new start reads the page's own text.
  const again = await untilTranslated(serviceWorker, tabId);
  expect(again.failed).toBe(0);
  await expect(page.locator('h1')).toHaveText(`${STUB_PAGE_PREFIX}Vesper the Tidebound`);
  expect(await page.locator('body').evaluate((body) => body.textContent)).not.toContain(
    `${STUB_PAGE_PREFIX}${STUB_PAGE_PREFIX}`,
  );
  await restore(serviceWorker, tabId);
  expect(await fingerprint(page)).toBe(before);
  expect(await refsAsLoaded(page)).toBe(true);
});
