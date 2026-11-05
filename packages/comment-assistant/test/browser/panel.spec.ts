import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, usedHeap } from '@chrome-toolbox/extension-core/testing';

// A watch page made up for the tests (test/fixtures), served at YouTube's URL so the content
// script runs on it; no request reaches YouTube.
const watchPage = readFileSync(
  path.join(import.meta.dirname, '../fixtures/youtube-comments.html'),
  'utf8',
);

test('side panel names the stream of the active tab and saves filters the chat follows per streamer', async ({
  context,
  sidePanel,
  llama,
}) => {
  const platform: string[] = [];
  await context.route('https://www.youtube.com/**', async (route) => {
    platform.push(route.request().url());
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: watchPage });
  });
  // Comments go to the local stub, which answers them as chatter (`defaultResponder`).
  await expect(sidePanel.getByText('このタブには配信がありません')).toBeVisible();
  await sidePanel.getByRole('tab', { name: '設定' }).click();
  await sidePanel.getByLabel('llama.cpp の接続先').fill(llama.origin);
  await sidePanel.getByRole('button', { name: '接続を確認' }).click();
  await expect(sidePanel.locator('output[data-status="connected"]')).toBeVisible();

  const watch = await context.newPage();
  await watch.goto('https://www.youtube.com/watch?v=fixture0001');
  await watch.bringToFront();
  await expect(sidePanel.getByText('Fixture Quest Part 3: the frozen bridge')).toBeVisible();
  await expect(sidePanel.getByText('@FixtureStreamer')).toBeVisible();

  // The comments were answered: plain chatter is shown.
  const thread = watch.locator('ytd-comment-thread-renderer[data-ca-id="FixtureThread01"]');
  await expect(thread).toHaveAttribute('data-ca-mode', 'show');
  await sidePanel.getByRole('tab', { name: 'フィルター' }).click();
  await sidePanel.getByLabel('雑談').selectOption('hide');
  await expect(sidePanel.getByText('この配信者用に保存しました')).toBeVisible();
  // The chat reads the same streamer's filters and follows them at once.
  await expect(thread).toHaveAttribute('data-ca-mode', 'hide');

  await sidePanel.getByRole('tab', { name: '非表示' }).click();
  await expect(sidePanel.getByText('チャットから外したコメントはありません。')).toBeVisible();

  // Switching tabs asks again each time (no polling) and keeps the panel's heap bounded.
  const before = await usedHeap(sidePanel);
  for (let round = 0; round < 20; round += 1) {
    await sidePanel.bringToFront();
    await expect(sidePanel.getByText('このタブには配信がありません')).toBeVisible();
    await watch.bringToFront();
    await expect(sidePanel.getByText('Fixture Quest Part 3: the frozen bridge')).toBeVisible();
  }
  const after = await usedHeap(sidePanel);
  expect(after - before, `heap grew from ${before} to ${after} bytes`).toBeLessThan(1_000_000);
  expect(platform).toEqual(['https://www.youtube.com/watch?v=fixture0001']);
});
