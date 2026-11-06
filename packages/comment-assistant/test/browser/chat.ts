// Helpers shared by the chat flow and soak specs: the side panel's connection, the made-up watch
// page with its generated live chat (test/browser/fixtures), and what the chat shows.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Frame, Page } from '@playwright/test';
import { expect, type PlatformStub } from '@chrome-toolbox/extension-core/testing';
import type { CommentStats, HiddenEntry, Summary } from '../../src/protocol.ts';

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

/** The live chat iframe's URL as the watch page sets it (`watch.html`). */
const chatUrl = (rate: number): string =>
  `https://www.youtube.com/live_chat?continuation=fixture-continuation&rate=${rate}`;
const watchUrl = (video: string, rate: number): string =>
  `https://www.youtube.com/watch?v=${video}&rate=${rate}`;

/** Points the extension at `origin` from the settings tab, as a viewer would. */
export async function connect(sidePanel: Page, origin: string): Promise<void> {
  await sidePanel.getByRole('tab', { name: '設定' }).click();
  await sidePanel.getByLabel('llama.cpp の接続先').fill(origin);
  await sidePanel.getByRole('button', { name: '接続を確認' }).click();
  await expect(sidePanel.locator('output[data-status="connected"]')).toBeVisible();
}

export type OpenedChat = Readonly<{
  watch: Page;
  chat: Frame;
  /** The documents the test opened, in the order the platform was asked for them. */
  documents: readonly string[];
}>;

/**
 * Opens the watch page of `video` in a new tab, in front (the side panel follows the active
 * tab), with its live chat iframe posting `rate` messages a second.
 */
export async function openChat(
  context: BrowserContext,
  platform: PlatformStub,
  { video, rate }: Readonly<{ video: string; rate: number }>,
): Promise<OpenedChat> {
  platform.serve('https://www.youtube.com/watch', fixture('watch.html'));
  platform.serve('https://www.youtube.com/live_chat', fixture('live-chat.html'));
  const watch = await context.newPage();
  await watch.goto(watchUrl(video, rate));
  await watch.bringToFront();
  const chat = await (await watch.waitForSelector('iframe#chatframe')).contentFrame();
  if (chat === null) throw new Error('the watch page has no chat iframe');
  await chat.waitForURL(chatUrl(rate));
  await chat.waitForLoadState();
  return { watch, chat, documents: [watchUrl(video, rate), chatUrl(rate)] };
}

/** One line of the chat as shown: its number, text and display attributes. */
export type Line = Readonly<{
  n: number;
  author: string;
  text: string;
  mode: string | null;
  category: string | null;
  translated: boolean;
}>;

/** The chat's lines numbered above `after`, oldest first. */
export async function linesAfter(chat: Frame, after = -1): Promise<Line[]> {
  return chat.evaluate((after) => {
    const lines: Line[] = [];
    for (const element of document.querySelectorAll(
      '#items > yt-live-chat-text-message-renderer',
    )) {
      const n = Number(element.id.replace('fixture-line-', ''));
      if (!(n > after)) continue;
      const message = element.querySelector('#message');
      lines.push({
        n,
        author: element.querySelector('#author-name')?.firstChild?.textContent ?? '',
        text: message?.textContent ?? '',
        mode: element.getAttribute('data-ca-mode'),
        category: element.getAttribute('data-ca-category'),
        translated: message?.hasAttribute('data-ca-translated') ?? false,
      });
    }
    return lines;
  }, after);
}

/** The number of the newest line posted so far. */
export async function newest(chat: Frame): Promise<number> {
  const lines = await linesAfter(chat);
  return lines.at(-1)?.n ?? -1;
}

/** The kinds of text the generator posts (`live-chat.html`), told apart by their wording. */
export const kindOf = (
  text: string,
): 'reaction' | 'bad' | 'rough' | 'harsh' | 'question' | 'english' | 'japanese' => {
  if (text === 'lol' || text === '（笑）') return 'reaction';
  if (text.includes('BAD')) return 'bad';
  if (text.includes('ROUGH')) return 'rough';
  if (text.includes('HARSH')) return 'harsh';
  if (text.endsWith('?')) return 'question';
  return /[ぁ-んァ-ヶ一-龠]/u.test(text.replace(/^訳:/u, '')) ? 'japanese' : 'english';
};

/** The chat of `video`'s comments listed for review, asked from the side panel as its list does. */
export async function hiddenOf(sidePanel: Page, video: string): Promise<HiddenEntry[]> {
  const answer = await sidePanel.evaluate(async (channel) => {
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    };
    const reply = await chrome.runtime.sendMessage({
      type: 'comments/hidden',
      payload: { site: 'youtube', channel },
    });
    return reply as { ok: boolean; value?: HiddenEntry[] };
  }, video);
  expect(answer.ok, 'comments/hidden answers').toBe(true);
  return answer.value ?? [];
}

/** The service worker's counters for the chat of `video`, asked from the side panel. */
export async function statsOf(sidePanel: Page, video: string): Promise<CommentStats> {
  // The same request the settings tab sends for its judge status.
  const answer = await sidePanel.evaluate(async (channel) => {
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    };
    const reply = await chrome.runtime.sendMessage({
      type: 'comments/stats',
      payload: { site: 'youtube', channel },
    });
    return reply as { ok: boolean; value?: CommentStats };
  }, video);
  expect(answer.ok, 'comments/stats answers').toBe(true);
  return answer.value as CommentStats;
}

/** The 5-minute summary of the chat of `video`, asked from the side panel as its tab does. */
export async function summaryOf(sidePanel: Page, video: string): Promise<Summary> {
  const answer = await sidePanel.evaluate(async (channel) => {
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    };
    const reply = await chrome.runtime.sendMessage({
      type: 'comments/summary',
      payload: { site: 'youtube', channel, windowMinutes: 5 },
    });
    return reply as { ok: boolean; value?: Summary };
  }, video);
  expect(answer.ok, 'comments/summary answers').toBe(true);
  return answer.value as Summary;
}
