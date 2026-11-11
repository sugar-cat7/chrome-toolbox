import type { BrowserContext, Page } from '@playwright/test';
import { expect, STUB_PAGE_PREFIX, test } from '@chrome-toolbox/extension-core/testing';
import { DISPLAY_MODES } from '../../src/protocol.ts';
import { ARTICLE_URL, openArticle, SUBMIT_URL } from './fixtures/article.ts';
import {
  recordBatches,
  startTranslation,
  untilTranslated,
  usePageSettings,
  useServer,
} from './page.ts';

// Spec §8: translating keeps the layout, the links and the forms working, both ways of showing a
// translation. The made-up wiki page has a flex navigation row, buttons of a fixed height and a
// card link holding blocks; in `pair` the button and the card get no box (P26).

test.use({ realVisibility: true });

const SITE = new URL(ARTICLE_URL);
/** A link of a translated paragraph, and the page it leads to. */
const LINK = '/areas/sunken-choir';
const LINKED = `${SITE.origin}${LINK}`;
/** Blocks in the page's flow, whose width their container decides (not their text). */
const FLOW_BLOCKS =
  '.site-nav, main > h1, main > h2, main > p, main li, main > .note, .card, .card > div, footer p';
/** Elements whose text is never translated. */
const UNTRANSLATED =
  'code, pre, kbd, samp, svg, [translate="no"], .notranslate, .material-icons, [contenteditable], option, textarea';

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;
/** What the test compares before and after translating. */
type Layout = Readonly<{
  flowWidths: number[];
  scroll: Readonly<{ width: number; client: number }>;
  nav: Readonly<{ links: Box[]; scrollWidth: number; clientWidth: number }>;
  buttons: number[];
  hrefs: (string | null)[];
  untranslated: (string | null)[];
}>;

const layoutOf = (page: Page): Promise<Layout> =>
  page.evaluate(
    ({ flow, untranslated }) => {
      const box = (element: Element): Box => {
        const { left, top, width, height } = element.getBoundingClientRect();
        return { left, top, width, height };
      };
      const nav = document.querySelector('.site-nav');
      const scroller = document.scrollingElement;
      return {
        flowWidths: [...document.querySelectorAll(flow)].map(
          (element) => element.getBoundingClientRect().width,
        ),
        scroll: { width: scroller?.scrollWidth ?? 0, client: scroller?.clientWidth ?? 0 },
        nav: {
          links: [...(nav?.querySelectorAll('a') ?? [])].map(box),
          scrollWidth: nav?.scrollWidth ?? 0,
          clientWidth: nav?.clientWidth ?? 0,
        },
        buttons: [...document.querySelectorAll('button')].map(
          (button) => button.getBoundingClientRect().height,
        ),
        hrefs: [...document.querySelectorAll('a')].map((link) => link.getAttribute('href')),
        // The Japanese paragraph is already in Japanese: it is left as it is.
        untranslated: [
          ...document.querySelectorAll(untranslated),
          ...[...document.querySelectorAll('p')].filter((p) => /[ぁ-ん]/u.test(p.textContent)),
        ].map((element) => element.textContent),
      };
    },
    { flow: FLOW_BLOCKS, untranslated: UNTRANSLATED },
  );

/**
 * The navigations from the article to the rest of the made-up site (a form's post): each is
 * recorded and then aborted, which Chrome drops without an error page, so the page stays. The
 * site's images are not found.
 */
type Sent = Readonly<{ method: string; url: string; body: string | null }>;
async function recordSite(context: BrowserContext): Promise<Sent[]> {
  const sent: Sent[] = [];
  await context.route(
    (url) => url.origin === SITE.origin && url.pathname !== SITE.pathname,
    async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        await route.fulfill({ status: 404 });
        return;
      }
      sent.push({ method: request.method(), url: request.url(), body: request.postData() });
      await route.abort('aborted');
    },
  );
  return sent;
}

/** What the page's script kept at load is still in the page: the same text nodes and links. */
const refsHeld = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const refs = Reflect.get(window, 'fixtureRefs') as {
      texts: Text[];
      links: HTMLAnchorElement[];
    };
    const links = [...document.querySelectorAll('a')];
    return (
      refs.texts.every((text) => text.isConnected) &&
      refs.links.length === links.length &&
      refs.links.every((link, i) => link === links[i])
    );
  });

for (const mode of DISPLAY_MODES) {
  test(`translation keeps layout, links and forms working (${mode})`, async ({
    context,
    serviceWorker,
    llama,
  }) => {
    await useServer(serviceWorker, llama.origin);
    await usePageSettings(serviceWorker, { mode });
    const batches = recordBatches(llama);
    const sent = await recordSite(context);
    const page = await openArticle(context);
    const submit = page.locator('form.comment-form button[type="submit"]');
    // The comment form as the reader sends it, before anything is translated.
    await submit.click();
    await expect.poll(() => sent.length).toBe(1);
    const before = await layoutOf(page);

    const tabId = await startTranslation(context, page);
    const progress = await untilTranslated(serviceWorker, tabId);
    expect(progress).toMatchObject({ mode, failed: 0 });
    const after = await layoutOf(page);

    // The page's flow and its links are as they were; nothing sticks out sideways.
    expect(after.flowWidths).toEqual(before.flowWidths);
    expect(after.scroll.width).toBeLessThanOrEqual(after.scroll.client);
    expect(after.hrefs).toEqual(before.hrefs);
    expect(after.buttons).toEqual(before.buttons);
    expect(after.untranslated).toEqual(before.untranslated);
    // The navigation row stays one row inside its width.
    expect(new Set(after.nav.links.map((link) => link.top)).size).toBe(1);
    expect(after.nav.scrollWidth).toBeLessThanOrEqual(after.nav.clientWidth);

    /** The text of an element's own nodes: a side-by-side box's shadow root is not one of them. */
    const textOf = (selector: string): Promise<string | null> =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => element.textContent);
    if (mode === 'replace') {
      expect(await textOf('h1')).toBe(`${STUB_PAGE_PREFIX}Vesper the Tidebound`);
      expect(await textOf('.site-nav a')).toBe(`${STUB_PAGE_PREFIX}Home`);
      expect(await textOf('.site-nav button')).toBe(`${STUB_PAGE_PREFIX}Search`);
      expect(await textOf('.card > div')).toBe(`${STUB_PAGE_PREFIX}Next boss`);
      await expect(page.locator('pt-ja')).toHaveCount(0);
    } else {
      // Side by side the text stays, and the translation goes in a box after the paragraph.
      expect(await textOf('h1')).toBe('Vesper the Tidebound');
      await expect(page.locator('h1 > pt-ja')).toHaveText(
        `${STUB_PAGE_PREFIX}Vesper the Tidebound`,
      );
      // The box reads as the paragraph does: its spaces, its kept name (`translate="no"`) and its
      // key (`kbd`) are there. (The stub keeps the space a piece starts with: `訳: lantern`.)
      const P = STUB_PAGE_PREFIX;
      await expect(page.locator('p.lead > pt-ja')).toHaveText(
        `${P}Vesper the Tidebound is the third boss of the ${P}Sunken Choir${P}. She guards the Glimmerdeep ${P} lantern and attacks with waves of cold water.`,
      );
      await expect(page.locator('main > p').nth(1).locator(':scope > pt-ja')).toHaveText(
        `${P}Phase 2 begins at 50% HP. Roll ${P}backward ${P} to dodge the light attack, then press R2 ${P} to counter.`,
      );
      // The row's box goes after its links, which keep their places along the row (the row may
      // grow taller for the box).
      const along = (links: readonly Box[]): Omit<Box, 'top'>[] =>
        links.map(({ left, width, height }) => ({ left, width, height }));
      expect(along(after.nav.links)).toEqual(along(before.nav.links));
      await expect(page.locator('.site-nav > pt-ja')).toHaveCount(1);
      expect(await textOf('.site-nav a')).toBe('Home');
      // A button and a card link show no box (P26): their translation is in the tooltip only.
      expect(await textOf('.site-nav button')).toBe('Search');
      expect(await textOf('.card > div')).toBe('Next boss');
      await expect(page.locator('a pt-ja, button pt-ja, summary pt-ja')).toHaveCount(0);
      expect(await page.locator('pt-ja').count()).toBeGreaterThan(5);
    }

    // The page's own script still works: its button, its nodes.
    const clicks = (): Promise<unknown> =>
      page.evaluate(() => Reflect.get(window, 'fixtureClicks'));
    const clicked = Number(await clicks());
    await page.locator('.site-nav button').click();
    expect(await clicks()).toBe(clicked + 1);
    expect(await refsHeld(page)).toBe(true);

    // The form sends what it sent before: the field's value, the option's text, the text area's.
    await submit.click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'POST', url: SUBMIT_URL },
      { method: 'POST', url: SUBMIT_URL },
    ]);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(new URLSearchParams(sent[1]?.body ?? '').toString()).toBe(
      new URLSearchParams({
        author: 'Tide Runner',
        difficulty: 'Easy mode',
        body: 'Write your tips here',
      }).toString(),
    );

    // Every batch went to Gemma on the server's last slot (the stub has 2).
    expect(batches.asked.length).toBeGreaterThan(0);
    for (const batch of batches.asked)
      expect(batch).toMatchObject({ model: 'gemma4-e4b', slot: 1 });

    // A translated link still leads where it did.
    await context.route(LINKED, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Sunken Choir</title><p>The next made-up page.</p>',
      }),
    );
    await page.locator(`p.lead a[href="${LINK}"]`).click();
    await expect(page).toHaveURL(LINKED);
  });
}
