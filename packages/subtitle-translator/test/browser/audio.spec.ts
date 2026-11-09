import { defaultSettings } from '@chrome-toolbox/extension-core';
import {
  defaultResponder,
  triggerAction,
  withoutAudio,
} from '@chrome-toolbox/extension-core/testing';
import { AUDIO_UNSUPPORTED_MESSAGE } from '../../src/overlay/source.ts';
import { AUDIO_MISSING } from '../../src/entrypoints/sidepanel/text.ts';
import { expect, setServer, test } from './server.ts';
import {
  hasOffscreen,
  openWatch,
  overlayOf,
  play,
  recordChats,
  serveWatch,
  sessionStorage,
  TONES,
} from './subtitles.ts';

// The audio path (Tasks 11–14): the toolbar icon on a watch page without caption tracks starts
// the capture of the tab's audio (S46), the offscreen document cuts the tones into utterances and
// has the stub recognize and translate them, and the overlay shows each line. The icon is pressed
// over CDP (`Extensions.triggerAction`), which is what a click on it does (Task 13 Step 0); the
// Alt+Shift+S shortcut cannot be pressed from a test (CDP key events never reach Chrome's
// commands), so it is checked by hand (Task 16). The browser keeps tab audio audible to the
// capture (no `--mute-audio`) and plays nothing on the host.
test.use({ captureAudio: true });

const STUB_LINE = 'Stub speech 1.';

test('audio path shows the source line, then the Japanese line', async ({
  context,
  platform,
  llama,
  serviceWorker,
}) => {
  const videoId = 'fixtureAud1';
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  await serveWatch(
    context,
    platform,
    { videoId, title: 'Fixture Talk', live: true, tracks: [] },
    TONES,
  );
  const page = await openWatch(context, videoId);
  const overlay = await overlayOf(page);
  await overlay.record();
  await play(page);
  await triggerAction(context, page);

  await expect
    .poll(async () => (await overlay.read()).ja, { timeout: 15_000 })
    .toMatch(/^訳:Stub speech \d+\.$/u);
  const changes = await overlay.changes();
  const sourceFirst = changes.findIndex((change) => change.source === STUB_LINE);
  const japanese = changes.findIndex((change) => change.ja === `訳:${STUB_LINE}`);
  expect(sourceFirst, JSON.stringify(changes)).toBeGreaterThanOrEqual(0);
  // The recognized line shows before its translation does.
  expect(changes[sourceFirst]?.ja, JSON.stringify(changes)).toBe('');
  expect(japanese, JSON.stringify(changes)).toBeGreaterThan(sourceFirst);
  const latency = Number((await overlay.read()).latency);
  console.log(`audio: a line showed ${latency} ms after its speech ended`);
  expect(latency).toBeGreaterThanOrEqual(0);
  expect(latency).toBeLessThan(1_000);

  // Recognition and translation both go to slot 0, each naming its model.
  const recognitions = chats.filter((chat) => chat.audio > 0);
  const translations = chats.filter((chat) => chat.audio === 0);
  expect(recognitions.length).toBeGreaterThan(0);
  expect(translations.length).toBeGreaterThan(0);
  for (const chat of recognitions)
    expect(chat).toMatchObject({ model: defaultSettings.models.asr, slot: 0, audio: 1 });
  for (const chat of translations)
    expect(chat).toMatchObject({ model: defaultSettings.models.translate, slot: 0 });
  await overlay.detach();
});

test('a missing projector is explained and no capture starts', async ({
  context,
  platform,
  llama,
  serviceWorker,
  sidePanel,
}) => {
  const videoId = 'fixtureAud2';
  const chats = recordChats(llama, withoutAudio(defaultResponder));
  await setServer(serviceWorker, llama.origin);
  await sidePanel.reload();
  await expect(sidePanel.getByText(AUDIO_MISSING)).toBeVisible();

  await serveWatch(
    context,
    platform,
    { videoId, title: 'Fixture Talk', live: true, tracks: [] },
    TONES,
  );
  const page = await openWatch(context, videoId);
  const overlay = await overlayOf(page);
  await play(page);
  await triggerAction(context, page);
  await expect.poll(async () => (await overlay.read()).message).toBe(AUDIO_UNSUPPORTED_MESSAGE);
  expect(await hasOffscreen(serviceWorker)).toBe(false);
  expect(chats).toEqual([]);
  expect(llama.requests.filter((request) => request.startsWith('GET /props'))).not.toEqual([]);
  await overlay.detach();
});

test('closing the tab releases the capture and the offscreen document', async ({
  context,
  platform,
  llama,
  serviceWorker,
}) => {
  const videoId = 'fixtureAud3';
  const chats = recordChats(llama);
  await setServer(serviceWorker, llama.origin);
  await serveWatch(
    context,
    platform,
    { videoId, title: 'Fixture Talk', live: true, tracks: [] },
    TONES,
  );
  const page = await openWatch(context, videoId);
  await play(page);
  await triggerAction(context, page);
  await expect
    .poll(() => chats.filter((chat) => chat.audio > 0).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(await hasOffscreen(serviceWorker)).toBe(true);
  expect(await sessionStorage(serviceWorker)).toHaveProperty('capture');

  await page.close();
  await expect.poll(() => hasOffscreen(serviceWorker)).toBe(false);
  // No capture record, and nothing kept of the closed tab: its page and front are gone (the two
  // per-tab lists stay, empty).
  await expect
    .poll(() => sessionStorage(serviceWorker))
    .toEqual({ 'subs:fronts': [], 'subs:pages': [] });
  // Nothing is recognized any more.
  const count = chats.length;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(chats.length).toBe(count);
});
