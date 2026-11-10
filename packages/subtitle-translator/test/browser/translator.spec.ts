import type { Page } from '@playwright/test';
import {
  defaultSettings,
  PLAMO_LICENSE_URL,
  PLAMO_TRANSLATE_MODEL,
} from '@chrome-toolbox/extension-core';
import {
  defaultResponder,
  STUB_PLAMO_PREFIX,
  withPlamo,
} from '@chrome-toolbox/extension-core/testing';
import { TRANSLATOR_LABELS } from '../../src/settings.ts';
import { expect, setServer, test } from './server.ts';
import {
  fixtureCues,
  openWatch,
  overlayOf,
  play,
  recordChats,
  serveWatch,
  type Chat,
} from './subtitles.ts';

// The translator of the caption lines (Tasks 0 and 8): PLaMo 3 Translate 2B, the default the
// viewer can also pick in the side panel's 詳細設定 tab, when the router serves it (the stub's
// `withPlamo`); Gemma otherwise, with a notice in the panel.

/** Picks PLaMo in the side panel's 詳細設定 tab, pointed at the stub. */
async function choosePlamo(sidePanel: Page): Promise<void> {
  await sidePanel.reload();
  await sidePanel.getByRole('tab', { name: '詳細設定' }).click();
  await sidePanel.getByRole('radio', { name: TRANSLATOR_LABELS.plamo }).check();
  await expect(sidePanel.getByRole('radio', { name: TRANSLATOR_LABELS.plamo })).toBeChecked();
}

/** Plays a captioned video until its Japanese row shows a line; returns that row. */
async function translatedLine(
  context: import('@playwright/test').BrowserContext,
  platform: import('@chrome-toolbox/extension-core/testing').PlatformStub,
  videoId: string,
): Promise<string> {
  await serveWatch(
    context,
    platform,
    {
      videoId,
      title: 'Fixture Quest day 6',
      live: false,
      tracks: [{ languageCode: 'en', kind: 'manual' }],
    },
    { kind: 'video', durationMs: 30_000 },
    fixtureCues({ count: 10, firstMs: 500, everyMs: 2_000, lengthMs: 1_800 }),
  );
  const page = await openWatch(context, videoId);
  const overlay = await overlayOf(page);
  await play(page);
  await expect.poll(async () => (await overlay.read()).ja).toMatch(/^訳P?:Fixture line \d+\.$/u);
  const { ja } = await overlay.read();
  await overlay.detach();
  return ja;
}

const translations = (chats: readonly Chat[]): Chat[] => chats.filter((chat) => chat.audio === 0);

test('PLaMo translates caption lines and the panel shows Built with PLaMo', async ({
  context,
  platform,
  llama,
  serviceWorker,
  sidePanel,
}) => {
  const chats = recordChats(llama, withPlamo(defaultResponder));
  await setServer(serviceWorker, llama.origin);
  await choosePlamo(sidePanel);
  await expect(sidePanel.getByText('Built with PLaMo', { exact: true })).toBeVisible();
  await expect(sidePanel.getByRole('link', { name: 'PLaMo Community License' })).toHaveAttribute(
    'href',
    PLAMO_LICENSE_URL,
  );

  expect(await translatedLine(context, platform, 'fixturePla1')).toMatch(
    new RegExp(`^${STUB_PLAMO_PREFIX}Fixture line \\d+\\.$`, 'u'),
  );
  expect(translations(chats).length).toBeGreaterThan(0);
  for (const chat of translations(chats))
    expect(chat).toMatchObject({
      model: PLAMO_TRANSLATE_MODEL,
      slot: 0,
      roles: ['user'],
      grammar: false,
    });
});

test('without PLaMo on the router the lines come from Gemma and the panel says so', async ({
  context,
  platform,
  llama,
  serviceWorker,
  sidePanel,
}) => {
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  await choosePlamo(sidePanel);

  expect(await translatedLine(context, platform, 'fixturePla2')).toMatch(
    /^訳:Fixture line \d+\.$/u,
  );
  expect(translations(chats).length).toBeGreaterThan(0);
  for (const chat of translations(chats))
    expect(chat).toMatchObject({ model: defaultSettings.models.translate, slot: 0 });
  await sidePanel.bringToFront();
  await expect(
    sidePanel.getByText(`サーバーに ${PLAMO_TRANSLATE_MODEL} がないため、Gemma で訳しています`),
  ).toBeVisible();
});
