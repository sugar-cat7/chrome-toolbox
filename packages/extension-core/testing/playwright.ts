// Shared Playwright fixtures for extension E2E tests. This lives outside src/ because
// it runs in Node: it launches Chromium with the built extension and a local stub
// standing in for llama.cpp, so tests never depend on a real model server.
import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Frame,
  type Page,
  type Worker,
} from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { devToolsEndpoint, stopOnExit } from './devtools.ts';
import { heapParts, type HeapParts } from './heap.ts';
import { startLlamaStub, type LlamaStub } from './llama-stub.ts';

export { heapParts, type HeapParts } from './heap.ts';

export {
  chatCompletion,
  defaultResponder,
  summaryReply,
  STUB_ABUSIVE,
  STUB_GENRE,
  STUB_QUESTION,
  STUB_TOPIC,
  type LlamaStub,
  type Responder,
  type StubChat,
  type StubReply,
  type StubRequest,
} from './llama-stub.ts';

/**
 * The streaming platforms as the tests see them: pages a test serves at their real URLs (so
 * content scripts run on them) and every URL any page asked those hosts for. No request
 * reaches the platform.
 */
export type PlatformStub = {
  /** Every URL requested from the platform, in order. */
  requests: string[];
  /** Answers requests for `url` (origin and path; any query) with this HTML; others get 404. */
  serve(this: void, url: string, html: string): void;
};
/** The durations (ms) of the frame's long tasks since it loaded; see the `longTasks` fixture. */
export type LongTasks = (frame: Page | Frame) => Promise<number[]>;

type Options = {
  /**
   * Pages report the visibility of their tab as without a debugger: a page in a background tab
   * or a minimized window is `hidden`. Playwright otherwise emulates focus, which keeps every
   * page `visible`; with this option the browser is started on its own and connected without
   * that emulation (`connectOverCDP` with `noDefaults`). Off by default.
   */
  realVisibility: boolean;
};

type Fixtures = {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  llama: LlamaStub;
  sidePanel: Page;
  platform: PlatformStub;
  longTasks: LongTasks;
};

const extensionPath = path.resolve(process.env.STARTER_EXTENSION_PATH ?? 'dist/chrome-mv3');
/** Hosts whose pages the extensions read; tests serve them from fixtures. */
const PLATFORM_HOSTS = ['https://www.youtube.com'] as const;

/**
 * Collects the frame's long tasks with `PerformanceObserver({ type: 'longtask', buffered:
 * true })`: the first call on a frame starts observing (and takes the ones buffered since the
 * frame loaded), each call returns every duration collected so far.
 */
const longTasksOf: LongTasks = (frame) =>
  frame.evaluate(() => {
    const key = Symbol.for('chrome-toolbox.longTasks');
    const scope = globalThis as unknown as Record<symbol, number[] | undefined>;
    const known = scope[key];
    if (known !== undefined) return [...known];
    const durations: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration);
    });
    observer.observe({ type: 'longtask', buffered: true });
    for (const entry of observer.takeRecords()) durations.push(entry.duration);
    scope[key] = durations;
    return [...durations];
  });

/** How long Chromium may take to print its DevTools endpoint. */
const DEVTOOLS_TIMEOUT_MS = 30_000;
/** How long Chromium may take to exit after SIGTERM before it is killed. */
const EXIT_TIMEOUT_MS = 5_000;

/**
 * Starts Playwright's Chromium with the extension, as `launchPersistentContext` would, and
 * connects to it without Playwright's default overrides (focus emulation among them), so a page
 * in a background tab is `hidden`. Returns its context and what stops it. The browser never
 * outlives the call when start-up fails, nor the test worker: it is killed when the worker
 * exits, and its profile is removed with it.
 */
async function launchUnemulated(
  headless: boolean,
): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const profile = await mkdtemp(path.join(tmpdir(), 'extension-e2e-'));
  const browserProcess = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      // Playwright's own defaults, but not those that keep background tabs running as if shown
      // (timer throttling, renderer backgrounding, occluded windows).
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
      // Playwright's launch adds this unless `chromiumSandbox: true` (it defaults to false), so
      // the other fixtures run this way too. Without it, Chromium aborts with "No usable
      // sandbox!" on Linux hosts that restrict unprivileged user namespaces (Ubuntu 23.10+).
      '--no-sandbox',
      // The size of Playwright's default viewport.
      '--window-size=1280,720',
      ...(headless ? ['--headless'] : []),
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const killNow = (): void => {
    browserProcess.kill('SIGKILL');
  };
  // A worker that ends for any reason takes the browser and its profile with it.
  const forget = stopOnExit(browserProcess, profile);
  // A failed signal after start-up is no reason to fail the worker.
  browserProcess.on('error', () => undefined);
  async function stop(): Promise<void> {
    forget();
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      const exited = once(browserProcess, 'exit');
      browserProcess.kill();
      const timer = setTimeout(killNow, EXIT_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  try {
    const endpoint = await devToolsEndpoint(browserProcess, DEVTOOLS_TIMEOUT_MS);
    const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const [context] = browser.contexts();
    if (context === undefined) throw new Error('Chromium has no default context');
    return {
      context,
      close: async () => {
        try {
          await browser.close();
        } finally {
          await stop();
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export const test = base.extend<Fixtures & Options>({
  realVisibility: [false, { option: true }],
  // Branded Chrome removed --load-extension in 137; Playwright's Chromium keeps it,
  // including the new headless mode.
  context: async ({ headless, realVisibility }, provide) => {
    if (realVisibility) {
      const launched = await launchUnemulated(headless);
      try {
        await provide(launched.context);
      } finally {
        await launched.close();
      }
      return;
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await provide(context);
    await context.close();
  },
  serviceWorker: async ({ context }, provide) => {
    const [existing] = context.serviceWorkers();
    await provide(existing ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ serviceWorker }, provide) => {
    await provide(new URL(serviceWorker.url()).host);
  },
  llama: async ({ headless: _headless }, provide) => {
    const stub = await startLlamaStub();
    await provide(stub);
    await stub.stop();
  },
  sidePanel: async ({ context, extensionId }, provide) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await provide(page);
  },
  platform: async ({ context }, provide) => {
    const requests: string[] = [];
    const pages = new Map<string, string>();
    for (const host of PLATFORM_HOSTS)
      await context.route(`${host}/**`, async (route) => {
        const url = route.request().url();
        requests.push(url);
        const { origin, pathname } = new URL(url);
        const html = pages.get(`${origin}${pathname}`);
        await route.fulfill(
          html === undefined
            ? { status: 404, body: '' }
            : { contentType: 'text/html; charset=utf-8', body: html },
        );
      });
    await provide({
      requests,
      serve: (url, html) => {
        pages.set(url, html);
      },
    });
  },
  longTasks: async ({ headless: _headless }, provide) => {
    await provide(longTasksOf);
  },
});

export { expect };

/** JS heap in use after a forced GC, for bounded-growth (leak) assertions. */
export async function usedHeap(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  await session.send('Performance.enable');
  const { metrics } = await session.send('Performance.getMetrics');
  await session.detach();
  const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
  expect(heap, 'Chromium reports JSHeapUsedSize').toBeGreaterThan(0);
  return heap ?? 0;
}

/**
 * The page's heap after a forced GC (a heap snapshot takes one first), in parts: `data`, the
 * objects a leak grows, apart from the compiled `code` V8 adds while functions grow hot (see
 * `HeapParts`). A bounded-growth assertion over a long run compares `data`: `usedHeap` counts
 * that code too.
 */
export async function heapSnapshotParts(page: Page): Promise<HeapParts> {
  const session = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  session.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
    chunks.push(chunk);
  });
  await session.send('HeapProfiler.enable');
  await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await session.detach();
  return heapParts(JSON.parse(chunks.join('')));
}
