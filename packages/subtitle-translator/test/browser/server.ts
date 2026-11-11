// The llama.cpp address of the subtitle extension's browser tests. Opening the side panel asks
// the server what it can do (`subs/capability`: `/props` for the speech model and `/v1/models`),
// which would otherwise reach whatever listens on the default address: a developer's real router,
// where `/props` for the speech model can make it load a model. The fixtures below point the
// extension at `NO_SERVER` before every test (before the side panel opens), refuse every request
// of the service worker to the default address (as a network error), and fail a test that made
// one. The offscreen document takes its address from the service worker when a capture starts.
import type { Worker } from '@playwright/test';
import { defaultSettings } from '@chrome-toolbox/extension-core';
import { expect, test as base } from '@chrome-toolbox/extension-core/testing';

/** A llama.cpp address where nothing listens (the discard port). */
export const NO_SERVER = 'http://127.0.0.1:9';

/** The part of `chrome` the tests call in the service worker. */
type WorkerChrome = { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
/** The service worker's global that keeps the URLs it fetched. */
const FETCHED = 'subtitleTestFetched';

/**
 * Points the extension at the llama.cpp server at `origin`, as the side panel's connection check
 * saves it.
 */
export const setServer = (serviceWorker: Worker, origin: string): Promise<void> =>
  serviceWorker.evaluate(
    (settings) =>
      (globalThis as unknown as { chrome: WorkerChrome }).chrome.storage.local.set({ settings }),
    { ...defaultSettings, llamaBaseUrl: origin },
  );

/**
 * Keeps the URL of every request the service worker makes from now on; one to `blocked` fails as
 * an unreachable server does and never leaves the browser.
 */
const recordFetches = (serviceWorker: Worker, blocked: string): Promise<void> =>
  serviceWorker.evaluate(
    ({ key, blocked: origin }) => {
      const fetched: string[] = [];
      const original = globalThis.fetch.bind(globalThis);
      Reflect.set(globalThis, key, fetched);
      Reflect.set(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        fetched.push(url);
        return url.startsWith(origin)
          ? Promise.reject(new TypeError('Failed to fetch'))
          : original(input, init);
      });
    },
    { key: FETCHED, blocked },
  );

/** The URLs the service worker fetched since `recordFetches`; undefined when it restarted. */
async function fetchedUrls(serviceWorker: Worker): Promise<string[] | undefined> {
  const fetched: unknown = await serviceWorker.evaluate(
    (key) => Reflect.get(globalThis, key),
    FETCHED,
  );
  return Array.isArray(fetched)
    ? fetched.filter((url): url is string => typeof url === 'string')
    : undefined;
}

/**
 * The shared fixtures, kept off the default llama.cpp address: before each test the extension
 * points at `NO_SERVER` (a test that wants the stub calls `setServer` with its origin), and every
 * request of the service worker to the default address is refused and fails the test. The side
 * panel opens after that.
 */
export const test = base.extend<{ serverGuard: undefined }>({
  serverGuard: [
    async ({ serviceWorker }, provide) => {
      await setServer(serviceWorker, NO_SERVER);
      await recordFetches(serviceWorker, defaultSettings.llamaBaseUrl);
      await provide(undefined);
      const fetched = await fetchedUrls(serviceWorker);
      expect(fetched, 'the service worker kept its record of requests').toBeDefined();
      expect(
        fetched?.filter((url) => url.startsWith(defaultSettings.llamaBaseUrl)),
        `requests to the default address ${defaultSettings.llamaBaseUrl}`,
      ).toEqual([]);
    },
    { auto: true },
  ],
  sidePanel: async ({ context, extensionId, serverGuard: _guarded }, provide) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await provide(page);
  },
});

export { expect };
