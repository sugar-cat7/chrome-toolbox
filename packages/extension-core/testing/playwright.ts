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
import { extensionTarget } from './targets.ts';

export { heapParts, type HeapParts } from './heap.ts';
export { extensionTarget, type TargetEntry } from './targets.ts';

export {
  chatCompletion,
  defaultResponder,
  summaryReply,
  withPlamo,
  withoutAudio,
  STUB_ABUSIVE,
  STUB_GENRE,
  STUB_PLAMO_PREFIX,
  STUB_QUESTION,
  STUB_TOPIC,
  STUB_TRANSCRIPT,
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
  /**
   * Answers requests for `url` (origin and path; any query) with `body`, HTML unless `contentType`
   * says otherwise; others get 404. A request for a range of the body (media elements ask for
   * one) gets that range, as a server that accepts ranges answers it.
   */
  serve(this: void, url: string, body: string | Uint8Array, contentType?: string): void;
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
  /**
   * Tab audio reaches `chrome.tabCapture`: the browser starts without Playwright's default
   * `--mute-audio`, which makes a captured tab's audio silent, and with `--disable-audio-output`,
   * so nothing plays on the host's speakers. Off by default.
   */
  captureAudio: boolean;
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
 * Collects the document's long tasks with `PerformanceObserver({ type: 'longtask', buffered:
 * true })`: the first call starts observing (and takes the ones buffered since the document
 * loaded), each call returns every duration collected so far. Runs in the document.
 */
function collectLongTasks(): number[] {
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
}
/** The frame's long tasks, by `collectLongTasks`. */
const longTasksOf: LongTasks = (frame) => frame.evaluate(collectLongTasks);

/**
 * The bytes a `Range: bytes=<start>-[<end>]` header asks of a body of `length` bytes, the end
 * included and cut to the body; undefined for no header, another form or a start past the end.
 */
function rangeOf(
  header: string | undefined,
  length: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header ?? '');
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Math.min(length - 1, match[2] === '' ? length - 1 : Number(match[2]));
  return start <= end ? { start, end } : undefined;
}

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
  captureAudio: boolean,
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
      ...(captureAudio ? ['--disable-audio-output'] : ['--mute-audio']),
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
  captureAudio: [false, { option: true }],
  // Branded Chrome removed --load-extension in 137; Playwright's Chromium keeps it,
  // including the new headless mode.
  context: async ({ headless, realVisibility, captureAudio }, provide) => {
    if (realVisibility) {
      const launched = await launchUnemulated(headless, captureAudio);
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
      ...(captureAudio ? { ignoreDefaultArgs: ['--mute-audio'] } : {}),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        ...(captureAudio ? ['--disable-audio-output'] : []),
      ],
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
    const served = new Map<string, Readonly<{ body: Buffer; contentType: string }>>();
    for (const host of PLATFORM_HOSTS)
      await context.route(`${host}/**`, async (route) => {
        const url = route.request().url();
        requests.push(url);
        const { origin, pathname } = new URL(url);
        const file = served.get(`${origin}${pathname}`);
        if (file === undefined) {
          await route.fulfill({ status: 404, body: '' });
          return;
        }
        const range = rangeOf((await route.request().allHeaders())['range'], file.body.length);
        await route.fulfill(
          range === undefined
            ? { contentType: file.contentType, body: file.body }
            : {
                status: 206,
                contentType: file.contentType,
                headers: {
                  'accept-ranges': 'bytes',
                  'content-range': `bytes ${range.start}-${range.end}/${file.body.length}`,
                },
                body: file.body.subarray(range.start, range.end + 1),
              },
        );
      });
    await provide({
      requests,
      serve: (url, body, contentType = 'text/html; charset=utf-8') => {
        served.set(url, { body: Buffer.from(body), contentType });
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

/**
 * Presses the extension's toolbar button on the tab that shows `page`, as the viewer would:
 * Chrome grants the extension `activeTab` for that tab and opens its popup. Uses CDP
 * `Extensions.triggerAction` on the page's tab target (a page target is refused); it works over
 * the default connection and the `realVisibility` one, without `--enable-unsafe-extension-
 * debugging`. Playwright does not attach to the popup this opens: it is not in `context.pages()`
 * and fires no `page` event (adoption: Page translator foundation). The page is brought to the
 * front first; its tab is the active one showing its URL.
 */
export async function triggerAction(context: BrowserContext, page: Page): Promise<void> {
  const browser = context.browser();
  if (browser === null) throw new Error('the browser is not connected over CDP');
  const own = (worker: Worker): boolean => worker.url().startsWith('chrome-extension://');
  const worker =
    context.serviceWorkers().find(own) ??
    (await context.waitForEvent('serviceworker', { predicate: own }));
  await page.bringToFront();
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets', {
      filter: [{ type: 'tab' }],
    });
    // `embedderData.tabActive` is a boolean, though the protocol types call it a string.
    const tabs = targetInfos.filter(
      ({ url, embedderData }) => url === page.url() && `${embedderData?.['tabActive']}` === 'true',
    );
    const [tab] = tabs;
    if (tab === undefined || tabs.length > 1)
      throw new Error(`expected one active tab showing ${page.url()}, found ${tabs.length}`);
    await session.send('Extensions.triggerAction', {
      id: new URL(worker.url()).host,
      targetId: tab.targetId,
    });
  } finally {
    await session.detach();
  }
}

/** An extension document Playwright does not attach to, measured as `usedHeap` and the rest do. */
export type DocumentTarget = {
  /** JS heap in use after a forced GC (see `usedHeap`). */
  usedHeap(this: void): Promise<number>;
  /** The heap after a forced GC, in parts (see `heapSnapshotParts`). */
  heapParts(this: void): Promise<HeapParts>;
  /** Its long tasks since it loaded, as the `longTasks` fixture collects a page's. */
  longTasks(this: void): Promise<number[]>;
  /** Evaluates `expression` in the document and returns its value (JSON-serializable). */
  evaluate(this: void, expression: string): Promise<unknown>;
  detach(this: void): Promise<void>;
};

/** How long `offscreenTarget` waits for the document to open. */
const TARGET_TIMEOUT_MS = 10_000;

/** A property of a parsed CDP message, or undefined. */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/**
 * Attaches to the extension's document at `path` (its offscreen document, `/offscreen.html`),
 * waiting up to 10 s for it to open. Chrome lists an offscreen document as a `background_page`
 * target, which Playwright never attaches to, so this attaches over a browser CDP session. The
 * attachment is not flattened: Playwright's `CDPSession` has no way to address a child session,
 * so commands go through `Target.sendMessageToTarget` and come back as
 * `Target.receivedMessageFromTarget` (adoption: subtitle-translator Task 15).
 */
export async function offscreenTarget(
  context: BrowserContext,
  path: '/offscreen.html',
): Promise<DocumentTarget> {
  const browser = context.browser();
  if (browser === null) throw new Error('the browser is not connected over CDP');
  const own = (worker: Worker): boolean => worker.url().startsWith('chrome-extension://');
  const worker =
    context.serviceWorkers().find(own) ??
    (await context.waitForEvent('serviceworker', { predicate: own }));
  const extensionId = new URL(worker.url()).host;
  const session = await browser.newBrowserCDPSession();
  let targetId: string | undefined;
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  while (targetId === undefined) {
    const { targetInfos } = await session.send('Target.getTargets');
    targetId = extensionTarget(targetInfos, extensionId, path)?.targetId;
    if (targetId !== undefined) break;
    if (Date.now() > deadline) {
      await session.detach();
      throw new Error(`chrome-extension://${extensionId}${path} did not open`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: false });
  let lastId = 0;
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<string, (params: unknown) => void>();
  session.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message: unknown = JSON.parse(event.message);
    const id = fieldOf(message, 'id');
    const method = fieldOf(message, 'method');
    if (typeof method === 'string') listeners.get(method)?.(fieldOf(message, 'params'));
    if (typeof id !== 'number') return;
    const call = waiting.get(id);
    waiting.delete(id);
    const error = fieldOf(message, 'error');
    if (error === undefined) call?.resolve(fieldOf(message, 'result'));
    else call?.reject(new Error(`${path}: ${JSON.stringify(error)}`));
  });
  session.on('Target.detachedFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    for (const call of waiting.values()) call.reject(new Error(`${path} closed`));
    waiting.clear();
  });
  function send(method: string, params: object = {}): Promise<unknown> {
    lastId += 1;
    const id = lastId;
    const answered = new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
    });
    return session
      .send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      })
      .then(() => answered);
  }
  async function evaluate(expression: string): Promise<unknown> {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const thrown = fieldOf(reply, 'exceptionDetails');
    if (thrown !== undefined) throw new Error(`${path}: ${JSON.stringify(thrown)}`);
    return fieldOf(fieldOf(reply, 'result'), 'value');
  }
  return {
    usedHeap: async () => {
      await send('HeapProfiler.collectGarbage');
      await send('Performance.enable');
      const metrics = fieldOf(await send('Performance.getMetrics'), 'metrics');
      const heap = Array.isArray(metrics)
        ? metrics.find((metric) => fieldOf(metric, 'name') === 'JSHeapUsedSize')
        : undefined;
      const value = fieldOf(heap, 'value');
      expect(value, 'Chromium reports JSHeapUsedSize').toBeGreaterThan(0);
      return typeof value === 'number' ? value : 0;
    },
    heapParts: async () => {
      const chunks: string[] = [];
      listeners.set('HeapProfiler.addHeapSnapshotChunk', (params) => {
        const chunk = fieldOf(params, 'chunk');
        if (typeof chunk === 'string') chunks.push(chunk);
      });
      await send('HeapProfiler.enable');
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      listeners.delete('HeapProfiler.addHeapSnapshotChunk');
      return heapParts(JSON.parse(chunks.join('')));
    },
    longTasks: async () => {
      const durations = await evaluate(`(${collectLongTasks.toString()})()`);
      return Array.isArray(durations)
        ? durations.filter((duration): duration is number => typeof duration === 'number')
        : [];
    },
    evaluate,
    detach: async () => {
      await session.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      await session.detach();
    },
  };
}
