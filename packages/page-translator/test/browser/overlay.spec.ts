import { expect, STUB_PAGE_PREFIX, test } from '@chrome-toolbox/extension-core/testing';
import { openArticle } from './fixtures/article.ts';
import {
  fingerprint,
  injectPageScript,
  startTranslation,
  tell,
  untilTranslated,
  usePageSettings,
  useServer,
} from './page.ts';

// Spec §8: the pointer resting on a translated paragraph shows its original in a tooltip, and a
// selection is translated in a bubble next to it. Both live in `<pt-overlay>`, whose shadow root
// Playwright's locators pierce, and both leave the page as it was once they close.

test.use({ realVisibility: true });

const LEAD =
  'Vesper the Tidebound is the third boss of the Sunken Choir. She guards the Glimmerdeep lantern and attacks with waves of cold water.';

test('hovering a translated paragraph shows its original', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const page = await openArticle(context);
  const tabId = await startTranslation(context, page);
  await untilTranslated(serviceWorker, tabId);
  const translated = await fingerprint(page);
  const tooltip = page.locator('pt-overlay [role="tooltip"]');
  await page.locator('p.lead').hover();
  await expect(tooltip).toHaveText(`原文：${LEAD}`);
  // The pointer leaves for the page's margin: the tooltip and its overlay go.
  await page.mouse.move(2, 2);
  await expect(tooltip).toHaveCount(0);
  await expect(page.locator('pt-overlay')).toHaveCount(0);
  expect(await fingerprint(page)).toBe(translated);

  // Side by side, a card link shows no box (P26): its translation shows in the tooltip.
  await usePageSettings(serviceWorker, { mode: 'pair' });
  await expect(page.locator('h1 > pt-ja')).toHaveCount(1);
  await page.locator('.card > div').last().hover();
  await expect(tooltip).toHaveText(
    `訳：${STUB_PAGE_PREFIX}The Hollow Organist waits in the bell tower.`,
  );
  await page.mouse.move(2, 2);
  await expect(page.locator('pt-overlay')).toHaveCount(0);
});

test('the selection bubble shows a translation near the selection and leaves nothing behind', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const page = await openArticle(context);
  const before = await fingerprint(page);
  const tabId = await injectPageScript(context, page);
  // The reader selects the first sentence of the lore.
  const sentence = 'The Sunken Choir was once a cathedral built on the shore of a quiet bay.';
  const selected = await page.evaluate((text) => {
    const paragraph = [...document.querySelectorAll('p')].find((p) => p.textContent.includes(text));
    const node = paragraph?.firstChild;
    if (!(node instanceof Text)) throw new Error('no lore paragraph');
    const start = node.data.indexOf(text);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const { left, right, bottom } = range.getBoundingClientRect();
    return { left, right, bottom, text: selection?.toString() };
  }, sentence);
  expect(selected.text).toBe(sentence);
  // The shortcut (or the context menu) makes the background tell the page script.
  await tell(serviceWorker, tabId, { action: 'selection' });
  const bubble = page.locator('pt-overlay [role="dialog"]');
  await expect(bubble.locator('.text')).toHaveText(`${STUB_PAGE_PREFIX}${sentence}`);
  const box = await bubble.boundingBox();
  if (box === null) throw new Error('the bubble shows nothing');
  // Under the selection, across from it.
  expect(box.y).toBeGreaterThanOrEqual(selected.bottom);
  expect(box.x).toBeLessThan(selected.right);
  expect(box.x + box.width).toBeGreaterThan(selected.left);
  await expect(bubble.getByRole('button', { name: '閉じる' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(bubble).toHaveCount(0);
  await expect(page.locator('pt-overlay')).toHaveCount(0);
  expect(await fingerprint(page)).toBe(before);
});
