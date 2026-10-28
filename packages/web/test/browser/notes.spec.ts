import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { notesSchema } from '@starter/contracts';

test('styled SSR and safe input remain available while hydration is loading', async ({ page }) => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(/\/(?:src\/client\.ts|assets\/client-[^/]+\.js)(?:\?|$)/u, async (route) => {
    requested = true;
    await waiting;
    await route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await expect.poll(() => requested).toBe(true);
    const input = page.getByLabel('New note');
    await expect(input).toBeVisible();
    await expect(input).toHaveJSProperty('readOnly', true);
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toHaveCSS(
      'font-size',
      '30px',
    );
    await input.click();
    await page.keyboard.type('Too early');
    await expect(input).toHaveValue('');
    if (!release) throw new Error('Hydration release missing');
    release();
    await expect(input).toBeEditable();
    await input.fill('Retained text');
    await expect(input).toHaveValue('Retained text');
    await page.getByRole('link', { name: 'About' }).click();
    await expect(page.getByRole('heading', { name: 'About this sample' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    release?.();
  }
});

test('SSR, hydration, CRUD, same-origin export, routes and accessibility', async ({
  page,
  request,
}) => {
  const rendered = await request.get('/');
  expect(rendered.status()).toBe(200);
  expect(await rendered.text()).toContain('New note');
  const existing = notesSchema.parse(await (await request.get('/api/notes')).json());
  for (const note of existing)
    expect((await request.delete(`/api/notes/${note.id}`)).status()).toBe(204);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('No notes yet. Add your first note.')).toBeVisible();
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('between 1 and 1000');
  await page.getByLabel('New note').fill('Browser note');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(page.getByText('Browser note', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const exported = await download;
  const filename = await exported.path();
  if (!filename) throw new Error('JSON download missing');
  expect(
    notesSchema.parse(JSON.parse(await readFile(filename, 'utf8'))).map((note) => note.text),
  ).toEqual(['Browser note']);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Delete Browser note' }).click();
  await expect(page.getByText('No notes yet. Add your first note.')).toBeVisible();
  await page.getByRole('link', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'About this sample' })).toBeVisible();
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.getByLabel('New note')).toBeEditable();
  expect(errors).toEqual([]);
});

test('cold static page preserves styled native navigation and the destination hydrates', async ({
  page,
  browser,
}) => {
  const rendererRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (/\/assets\/react-dom-[^/]+\.js/u.test(request.url())) rendererRequests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About this sample' })).toHaveCSS(
    'font-size',
    '30px',
  );
  await expect(page.locator('meta[name="app-client"]')).toHaveAttribute('content', 'static');
  if (process.env.STARTER_BROWSER_MODE === 'production') {
    // Observe initial lazy imports before navigation; a styled heading alone is too early.
    await page.waitForLoadState('networkidle');
    expect(rendererRequests).toEqual([]);
  }
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.locator('meta[name="app-client"]')).toHaveCount(0);
  await expect(page.getByLabel('New note')).toBeEditable();
  await page.getByLabel('New note').fill('From static page');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(page.getByText('From static page', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete From static page' }).click();
  await expect(page.getByText('From static page', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);

  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const staticPage = await context.newPage();
    await staticPage.goto(new URL('/about', page.url()).href);
    await expect(staticPage.getByRole('heading', { name: 'About this sample' })).toHaveCSS(
      'font-size',
      '30px',
    );
    await staticPage.getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(staticPage.getByLabel('New note')).toBeVisible();
    await expect(staticPage.getByLabel('New note')).toHaveJSProperty('readOnly', true);
  } finally {
    await context.close();
  }
});

test('loading, empty and API-error states have reviewed visual baselines', async ({ page }) => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/notes', async (route) => {
    await waiting;
    await route.fulfill({ json: [] });
  });
  await page.goto('/');
  await expect(page.getByText('Loading notes…')).toBeVisible();
  const region = page.getByRole('region', { name: 'Notes' });
  await expect(region).toHaveScreenshot('persistent-loading.png');
  release?.();
  await expect(page.getByText('No notes yet. Add your first note.')).toBeVisible();
  await expect(region).toHaveScreenshot('persistent-empty.png');
  await page.unroute('**/api/notes');
  await page.route('**/api/notes', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await expect(region).toHaveScreenshot('persistent-error.png');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
