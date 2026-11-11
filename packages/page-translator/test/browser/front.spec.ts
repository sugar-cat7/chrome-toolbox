import { setTimeout as sleep } from 'node:timers/promises';
import {
  defaultResponder,
  expect,
  STUB_PAGE_PREFIX,
  test,
  type LlamaStub,
  type StubReply,
} from '@chrome-toolbox/extension-core/testing';
import { ALWAYS_SCRIPT_ID } from '../../src/control.ts';
import { LONG_URL, longHtml } from './fixtures/long.ts';
import {
  ping,
  progressOf,
  servePage,
  startTranslation,
  tabIdOf,
  usePageSettings,
  useServer,
} from './page.ts';

// Spec §8 and R44: a page in a background tab asks the model nothing. Its batch out when it left
// the viewer is stopped, and once it is in front again the paragraphs near the viewport are asked
// for again. A page of an always site opened in a background tab waits until it is shown: here
// on 127.0.0.1, the one site the manifest grants (Chrome's prompt for another site cannot be
// answered from a test); Task 6's unit test 'waits until visible before scanning a page opened
// in a background tab' covers the scan.

test.use({ realVisibility: true });

const chats = (llama: LlamaStub): number =>
  llama.requests.filter((request) => request.startsWith('POST /v1/chat/completions')).length;

test('a background tab asks nothing and resumes in front', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  // The stub holds every chat completion until the test lets it answer.
  const held: (() => void)[] = [];
  llama.respond = async (request): Promise<StubReply> => {
    if (request.path === '/v1/chat/completions')
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
    return defaultResponder(request);
  };
  await servePage(context, LONG_URL, longHtml());
  const page = await context.newPage();
  await page.goto(LONG_URL);
  const tabId = await startTranslation(context, page);
  // The first batch is out: another tab comes to the front.
  await expect.poll(() => chats(llama)).toBe(1);
  const other = await context.newPage();
  await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
  // The batch out is stopped (its answer comes too late to be written), and nothing more is asked.
  for (const resolve of held.splice(0)) resolve();
  await sleep(5_000);
  expect(chats(llama)).toBe(1);
  expect(await page.locator('#p1').textContent()).not.toContain(STUB_PAGE_PREFIX);
  expect(await progressOf(serviceWorker, tabId)).toMatchObject({ done: 0, failed: 0 });

  // In front again, the page asks for the paragraphs near the viewport and writes them.
  llama.respond = defaultResponder;
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect.poll(() => chats(llama)).toBeGreaterThan(1);
  await expect(page.locator('#p1')).toHaveText(new RegExp(`^${STUB_PAGE_PREFIX}Harbor log 1:`));
  await expect
    .poll(async () => {
      const { waiting, done, failed } = await progressOf(serviceWorker, tabId);
      return { waiting, failed, some: done > 0 };
    })
    .toEqual({ waiting: 0, failed: 0, some: true });
});

test('an always site opened in a background tab asks nothing until it is shown', async ({
  context,
  serviceWorker,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  const site = 'http://127.0.0.1/*';
  const url = 'http://127.0.0.1/always-front';
  await context.route(url, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: longHtml() }),
  );
  await usePageSettings(serviceWorker, { always: [site] });
  await expect
    .poll(() =>
      serviceWorker.evaluate(async (id) => {
        const { chrome } = globalThis as unknown as {
          chrome: {
            scripting: {
              getRegisteredContentScripts(filter: {
                ids: string[];
              }): Promise<{ matches?: string[] }[]>;
            };
          };
        };
        const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        return script?.matches ?? null;
      }, ALWAYS_SCRIPT_ID),
    )
    .toEqual([site]);
  const front = await context.newPage();
  await front.bringToFront();
  // A tab behind the one in front, as a link opened in a new background tab is. It loads the
  // site once Playwright has it, so that the site is served from the test.
  const browser = context.browser();
  if (browser === null) throw new Error('the browser is not connected over CDP');
  const session = await browser.newBrowserCDPSession();
  const opened = context.waitForEvent('page');
  await session.send('Target.createTarget', { url: 'about:blank', background: true });
  await session.detach();
  const page = await opened;
  await page.goto(url);
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
  // The registration ran the page script, which waits.
  const tabId = await serviceWorker.evaluate(async (shown) => {
    const { chrome } = globalThis as unknown as {
      chrome: { tabs: { query(info: { url: string }): Promise<{ id?: number }[]> } };
    };
    const [tab] = await chrome.tabs.query({ url: shown });
    return tab?.id;
  }, url);
  if (tabId === undefined) throw new Error(`no tab shows ${url}`);
  await expect.poll(() => ping(serviceWorker, tabId)).toEqual({ ready: true });
  await sleep(3_000);
  expect(chats(llama)).toBe(0);
  expect(await progressOf(serviceWorker, tabId)).toMatchObject({ found: 0, done: 0 });

  await page.bringToFront();
  expect(await tabIdOf(serviceWorker, page)).toBe(tabId);
  await expect(page.locator('#p1')).toHaveText(new RegExp(`^${STUB_PAGE_PREFIX}Harbor log 1:`));
  expect(chats(llama)).toBeGreaterThan(0);
});
