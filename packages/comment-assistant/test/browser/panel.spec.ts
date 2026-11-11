import { readFileSync } from 'node:fs';
import path from 'node:path';
import { genrePrompt } from '@chrome-toolbox/extension-core';
import {
  defaultResponder,
  expect,
  test,
  usedHeap,
  type StubChat,
} from '@chrome-toolbox/extension-core/testing';

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
  await sidePanel.getByRole('tab', { name: '詳細設定' }).click();
  await sidePanel.getByRole('tab', { name: '設定', exact: true }).click();
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

test("side panel shows the genre the model guessed once for the stream and keeps the viewer's choice (R63)", async ({
  context,
  sidePanel,
  llama,
}) => {
  await context.route('https://www.youtube.com/**', async (route) => {
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: watchPage });
  });
  // The watch page names a game the table does not list and no genre word: the model guesses
  // once (the stub answers `story`).
  const guesses: StubChat[] = [];
  const { grammar } = genrePrompt({});
  llama.respond = (request) => {
    if (request.chat?.grammar === grammar) guesses.push(request.chat);
    return defaultResponder(request);
  };
  await sidePanel.getByRole('tab', { name: '詳細設定' }).click();
  await sidePanel.getByRole('tab', { name: '設定', exact: true }).click();
  await sidePanel.getByLabel('llama.cpp の接続先').fill(llama.origin);
  await sidePanel.getByRole('button', { name: '接続を確認' }).click();
  await expect(sidePanel.locator('output[data-status="connected"]')).toBeVisible();

  /** A category's row in the filter tab. */
  const row = (name: string) => sidePanel.getByRole('combobox', { name, exact: true });
  const watch = await context.newPage();
  await watch.goto('https://www.youtube.com/watch?v=fixture0001');
  await watch.bringToFront();
  await expect(sidePanel.getByText('Fixture Quest Part 3: the frozen bridge')).toBeVisible();
  await sidePanel.getByRole('tab', { name: 'フィルター' }).click();
  await expect(sidePanel.getByText('判定: ストーリー・RPG（理由: 推定）')).toBeVisible();
  expect(guesses).toHaveLength(1);
  // On a comment slot, never slot 0 (subtitles), with the router's model.
  expect(guesses[0]?.id_slot).toBeGreaterThanOrEqual(1);
  expect(guesses[0]?.model).toBe('gemma4-e4b');
  // A story stream conceals spoilers; the description's rules welcome advice, so instructions
  // are no category of this stream.
  await expect(row('ネタバレ')).toBeVisible();
  await expect(row('指示')).toHaveCount(0);
  await expect(row('ゴースティング')).toHaveCount(0);

  // The viewer knows better: an FPS stream, with ghosting and without spoilers.
  await sidePanel.getByLabel('この配信のジャンル').selectOption({ label: 'FPS・対戦' });
  await expect(sidePanel.getByText('この配信用に保存しました')).toBeVisible();
  await expect(row('ゴースティング')).toBeVisible();
  await expect(row('ネタバレ')).toHaveCount(0);

  // The page loads again: the choice stays, and the stream is not guessed again.
  await watch.reload();
  await watch.bringToFront();
  await expect(sidePanel.getByLabel('この配信のジャンル')).toHaveValue('fps');
  await expect(sidePanel.getByText('判定: ストーリー・RPG（理由: 推定）')).toBeVisible();
  expect(guesses).toHaveLength(1);
});
