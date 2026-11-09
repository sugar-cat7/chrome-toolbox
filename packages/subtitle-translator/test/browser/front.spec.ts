import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserContext, Page } from '@playwright/test';
import { triggerAction } from '@chrome-toolbox/extension-core/testing';
import { expect, setServer, test } from './server.ts';
import {
  openWatch,
  play,
  recordChats,
  serveWatch,
  settled,
  TONES,
  type Chat,
} from './subtitles.ts';

// Only the video in front of the viewer is processed (R44): while its tab is in the background,
// it is paused, YouTube shows an ad, or the player is scrolled off screen, no model request goes
// out; once it is back, the subtitles go on by themselves (the capture stays open, S8). The audio
// path, which asks the model every 1.1 s while it plays, shows it best. Pages see their real
// visibility only without Playwright's focus emulation.
test.use({ realVisibility: true, captureAudio: true });

/** How long nothing may be asked while away or paused. */
const QUIET_MS = 5_000;

type Act = (watch: Page, context: BrowserContext) => Promise<() => Promise<void>>;

const player = (watch: Page) => watch.locator('#movie_player');
const video = (watch: Page) => watch.locator('#movie_player video');

const ACTS: Readonly<Record<'background-tab' | 'pause' | 'ad-showing' | 'scroll-away', Act>> = {
  'background-tab': async (watch, context) => {
    const other = await context.newPage();
    await other.bringToFront();
    return async () => {
      await watch.bringToFront();
    };
  },
  pause: async (watch) => {
    await video(watch).evaluate((element: HTMLVideoElement) => element.pause());
    return () => play(watch);
  },
  'ad-showing': async (watch) => {
    await player(watch).evaluate((element) => element.classList.add('ad-showing'));
    return () => player(watch).evaluate((element) => element.classList.remove('ad-showing'));
  },
  'scroll-away': async (watch) => {
    await watch.evaluate(() => {
      const below = document.createElement('div');
      below.style.height = '3000px';
      document.body.append(below);
      window.scrollTo(0, 2000);
    });
    return () => watch.evaluate(() => window.scrollTo(0, 0));
  },
};

const recognitions = (chats: readonly Chat[]): number =>
  chats.filter((chat) => chat.audio > 0).length;

for (const { name, act } of [
  { name: '裏のタブ', act: 'background-tab' },
  { name: '一時停止', act: 'pause' },
  { name: '広告', act: 'ad-showing' },
  { name: 'プレイヤーが画面外', act: 'scroll-away' },
] as const) {
  test(`${name} stops every model request`, async ({ context, platform, llama, serviceWorker }) => {
    const videoId = `fixtureFr${['background-tab', 'pause', 'ad-showing', 'scroll-away'].indexOf(act)}0`;
    const chats = recordChats(llama);
    await setServer(serviceWorker, llama.origin);
    await serveWatch(
      context,
      platform,
      { videoId, title: 'Fixture Talk', live: true, tracks: [] },
      TONES,
    );
    const watch = await openWatch(context, videoId);
    await play(watch);
    await triggerAction(context, watch);
    await expect.poll(() => recognitions(chats), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    const undo = await ACTS[act](watch, context);
    // What was already with the model, or waiting for it on a pause, finishes first.
    const left = act === 'pause' ? await settled(chats) : chats.length;
    await sleep(QUIET_MS);
    expect(chats.length, `model requests in ${QUIET_MS} ms after ${act}`).toBe(left);

    await undo();
    await expect
      .poll(() => recognitions(chats), {
        timeout: 10_000,
        message: `recognition after ${act} ends`,
      })
      .toBeGreaterThan(recognitions(chats.slice(0, left)));
  });
}
