// The made-up wiki page of the unit tests (Task 4, test/unit/fixtures/article.html), served with
// a script of the page's own: the site's look (a flex navigation row, buttons of a fixed height,
// a card link), a few more elements that are never translated, a comment form that posts, and
// what the tests read back (`window.fixtureRefs`, `window.fixtureClicks`, `window.fixtureShows`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { servePage } from '../page.ts';

/** Where the page is served, and where its comment form posts. */
export const ARTICLE_URL = 'https://wiki.fixture.test/wiki/vesper-the-tidebound';
export const SUBMIT_URL = 'https://wiki.fixture.test/submit';

/**
 * What the page's script kept at load (`window.fixtureRefs`): every text node of the body and
 * its data then, and every link with its `href` then.
 */
export type FixtureRefs = Readonly<{
  texts: readonly Text[];
  originals: readonly string[];
  links: readonly HTMLAnchorElement[];
  hrefs: readonly (string | null)[];
}>;

/** The page's own script, run at the end of the body before any extension script. */
function pageScript(submit: string): void {
  const style = document.createElement('style');
  style.textContent = [
    '.site-nav { display: flex; align-items: center; gap: 12px; }',
    '.site-nav form { display: flex; gap: 6px; margin: 0; }',
    'button { height: 28px; }',
    '.card { display: block; max-width: 420px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; color: inherit; text-decoration: none; }',
  ].join('\n');
  document.head.append(style);
  // More text that is never translated: a program's output and a drawing's label.
  document
    .querySelector('main')
    ?.insertAdjacentHTML(
      'beforeend',
      '<p>The save screen shows <samp>Slot 3 saved</samp> once the bell rings.</p>' +
        '<p>Follow the <svg width="80" height="16" role="img"><text x="0" y="12">Tide map</text></svg> signs to the tower.</p>',
    );
  // The search runs in the page; the comment form posts what the reader chose and wrote.
  document
    .querySelector('form[action="/search"]')
    ?.addEventListener('submit', (event) => event.preventDefault());
  const comment = document.querySelector('form.comment-form');
  if (comment instanceof HTMLFormElement) {
    comment.method = 'post';
    comment.action = submit;
    const author = document.createElement('input');
    author.name = 'author';
    author.setAttribute('value', 'Tide Runner');
    comment.prepend(author);
    comment.querySelector('select')?.setAttribute('name', 'difficulty');
  }
  Object.assign(window, { fixtureClicks: 0 });
  for (const button of document.querySelectorAll('button'))
    button.addEventListener('click', () => {
      Object.assign(window, { fixtureClicks: Number(Reflect.get(window, 'fixtureClicks')) + 1 });
    });
  // `persisted` of each pageshow: true when the page came back from the bfcache.
  const shows: boolean[] = [];
  Object.assign(window, { fixtureShows: shows });
  window.addEventListener('pageshow', (event) => shows.push(event.persisted));
  const texts: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    if (node instanceof Text) texts.push(node);
  const links = [...document.querySelectorAll('a')];
  Object.assign(window, {
    fixtureRefs: {
      texts,
      originals: texts.map((text) => text.data),
      links,
      hrefs: links.map((link) => link.getAttribute('href')),
    },
  });
}

const source = readFileSync(
  path.join(import.meta.dirname, '../../unit/fixtures/article.html'),
  'utf8',
);

/** The article with the page's script at the end of its body. */
export const articleHtml = source.replace(
  '</body>',
  () => `  <script>(${pageScript.toString()})(${JSON.stringify(SUBMIT_URL)});</script>\n  </body>`,
);

/**
 * Opens the article in a new tab whose viewport is tall enough that every paragraph is near it:
 * translating it translates the whole page.
 */
export async function openArticle(context: BrowserContext): Promise<Page> {
  await servePage(context, ARTICLE_URL, articleHtml);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.goto(ARTICLE_URL);
  return page;
}
