import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CDPSession, Page } from '@playwright/test';
import { build } from 'vite-plus';
import { expect, test } from '@chrome-toolbox/extension-core/testing';
import { filterKey, storedFilters, type FilterSettings } from '../../src/filters.ts';
import { connect } from './chat.ts';

// What the chat display costs the page (R45), measured in the browser: the YouTube adapter's
// lookups where every line repeats the same ids, and at 50 messages a second the main thread
// and GPU process time of concealed lines against shown ones, of new lines waiting for their
// judgement (R52) against lines shown as posted, and the layouts the extension adds. The made-up
// live chat (test/browser/fixtures/live-chat.html) posts the lines. The budgets are loose enough
// for a busy CI machine, and each fails a known cost: a scoped id query in the adapter, a filter
// on each concealed line, a layout per line.

const packageRoot = path.join(import.meta.dirname, '../..');
const liveChat = readFileSync(path.join(import.meta.dirname, 'fixtures/live-chat.html'), 'utf8');
/** A host the extension does not run on: the same chat without the content script. */
const ELSEWHERE = 'https://chat.fixture.test';
const VIDEO = 'fixturePerf01';
const RATE = 50;
/** Settling after a change of filters or of the tab in front, then each measured window. */
const SETTLE_MS = 3_000;
const WINDOW_MS = 6_000;

/** The YouTube live chat adapter as a script for a page: `liveChatAdapter.youtubeLiveChat`. */
async function adapterScript(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: packageRoot,
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(packageRoot, 'src/sites/youtube-live-chat.ts'),
        formats: ['iife'],
        name: 'liveChatAdapter',
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs)
    if ('output' in output)
      for (const item of output.output) if (item.type === 'chunk') return item.code;
  throw new Error('the adapter bundle has no chunk');
}

test.use({ realVisibility: true });

test('reads a live chat line in under twice the time the page takes to post it, while the page adds and removes lines that repeat the same ids', async ({
  context,
}) => {
  await context.route(`${ELSEWHERE}/**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: liveChat }),
  );
  const page = await context.newPage();
  // The test posts the lines itself.
  await page.addInitScript(() => {
    Object.assign(window, { fixturePaused: true });
  });
  await page.goto(`${ELSEWHERE}/live_chat`);
  await page.addScriptTag({ content: await adapterScript() });
  const measured = await page.evaluate(() => {
    const { youtubeLiveChat } = Reflect.get(window, 'liveChatAdapter') as {
      youtubeLiveChat: {
        read(node: Element): { text: string } | undefined;
        textElement(message: HTMLElement): HTMLElement | null;
      };
    };
    const items = document.getElementById('items');
    const template = document.querySelector('template#line');
    const line =
      template instanceof HTMLTemplateElement ? template.content.firstElementChild : null;
    if (items === null || line === null) return undefined;
    let posted = 0;
    /** One line as the chat posts it; the oldest goes past 250, as on YouTube. */
    const post = (): HTMLElement => {
      const node = line.cloneNode(true);
      if (!(node instanceof HTMLElement)) throw new Error('the template is no element');
      posted += 1;
      node.id = `perf-line-${posted}`;
      node.querySelector('[id="author-name"]')?.prepend('@perf-viewer');
      const message = node.querySelector('[id="message"]');
      if (message) message.textContent = `perf line ${posted}`;
      items.append(node);
      if (items.childElementCount > 250) items.firstElementChild?.remove();
      return node;
    };
    for (let index = 0; index < 250; index += 1) post();
    const LINES = 1000;
    /** µs a line: posting alone, or posting and then reading the new line as the content script does. */
    const round = (reading: boolean): number => {
      const start = performance.now();
      for (let index = 0; index < LINES; index += 1) {
        const node = post();
        if (!reading) continue;
        if (youtubeLiveChat.read(node)?.text === undefined) throw new Error('a line was not read');
        if (youtubeLiveChat.textElement(node) === null) throw new Error('no text element');
      }
      return ((performance.now() - start) * 1000) / LINES;
    };
    let posting = Infinity;
    let reading = Infinity;
    for (let index = 0; index < 10; index += 1) {
      posting = Math.min(posting, round(false));
      reading = Math.min(reading, round(true));
    }
    return { lines: items.childElementCount, posting, reading, microseconds: reading - posting };
  });
  console.log(`adapter ${JSON.stringify(measured)}`);
  expect(measured?.lines).toBe(250);
  // With a scoped `#message` and `#author-name` query right after the page changed the list a line
  // took 47 µs here (on the live page those queries were 466 of the content script's 676 µs a
  // comment); walking the line's children, 6 µs. Posting a line is the machine's yardstick: on an
  // M4 Max reading costs 1.1× posting (6.9 µs against 6.3), on a GitHub Linux runner 1.1–1.2×
  // (19.7–21.1 µs against 17–18), and the scoped queries were 7.5×.
  expect(measured?.microseconds).toBeLessThan(2 * (measured?.posting ?? 0));
});

/** One page's counters: main thread task time (s) and layouts. */
async function pageCounters(session: CDPSession): Promise<{ task: number; layouts: number }> {
  const { metrics } = await session.send('Performance.getMetrics');
  const value = (name: string): number =>
    metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { task: value('TaskDuration'), layouts: value('LayoutCount') };
}
/** CPU seconds of the GPU process so far. */
async function gpuSeconds(browserSession: CDPSession): Promise<number> {
  const { processInfo } = (await browserSession.send('SystemInfo.getProcessInfo')) as {
    processInfo: { type: string; cpuTime: number }[];
  };
  return processInfo
    .filter((info) => info.type === 'GPU')
    .reduce((sum, info) => sum + info.cpuTime, 0);
}
/** The number of the newest line the chat posted. */
const newestLine = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Number(document.getElementById('items')?.lastElementChild?.id.replace('fixture-line-', '')),
  );
type Window = { task: number; gpu: number; layoutsPerLine: number };
/**
 * Brings `page` to the front, lets its chat post again, settles, and measures one window: main
 * thread task ms and GPU process CPU ms a second, and layouts per posted line.
 */
async function measure(
  page: Page,
  others: readonly Page[],
  session: CDPSession,
  browserSession: CDPSession,
): Promise<Window> {
  for (const other of others)
    await other.evaluate(() => {
      Object.assign(window, { fixturePaused: true });
    });
  await page.bringToFront();
  await page.evaluate(() => {
    Object.assign(window, { fixturePaused: false });
  });
  await sleep(SETTLE_MS);
  const before = { ...(await pageCounters(session)), gpu: await gpuSeconds(browserSession) };
  const firstLine = await newestLine(page);
  const began = performance.now();
  await sleep(WINDOW_MS);
  const after = { ...(await pageCounters(session)), gpu: await gpuSeconds(browserSession) };
  const posted = (await newestLine(page)) - firstLine;
  const seconds = (performance.now() - began) / 1000;
  return {
    task: ((after.task - before.task) * 1000) / seconds,
    gpu: ((after.gpu - before.gpu) * 1000) / seconds,
    layoutsPerLine: (after.layouts - before.layouts) / Math.max(1, posted),
  };
}
const total = (windows: readonly Window[], key: keyof Window): number =>
  windows.reduce((sum, window) => sum + window[key], 0);

test('at 50 msg/s, concealed lines cost about what shown ones do, and the display adds no layout per line but the one keeping a new line out', async ({
  context,
  platform,
  sidePanel,
  llama,
}) => {
  test.setTimeout(150_000);
  await connect(sidePanel, llama.origin);
  /**
   * Every category shown as `mode` in this chat (the stream's own filters); new lines wait for
   * their judgement unless `hold` is false (R52).
   */
  const conceal = async (mode: 'show' | 'blur', hold = true): Promise<void> => {
    const settings: FilterSettings = {
      translate: true,
      showOriginal: false,
      holdUntilJudged: hold,
      modes: {
        chatter: mode,
        question: mode,
        abusive: mode,
        important: mode,
        spam: mode,
        spoiler: mode,
      },
    };
    // Saved from the side panel, as its filter tab does.
    await sidePanel.evaluate(
      async ([key, value]) => {
        const { chrome } = globalThis as unknown as {
          chrome: { storage: { local: { set(items: object): Promise<void> } } };
        };
        await chrome.storage.local.set({ [key]: value });
      },
      [filterKey('youtube', VIDEO), storedFilters(settings)] as const,
    );
  };
  await conceal('show');
  platform.serve('https://www.youtube.com/live_chat', liveChat);
  await context.route(`${ELSEWHERE}/**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: liveChat }),
  );
  const open = async (url: string): Promise<{ page: Page; session: CDPSession }> => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(url);
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable', { timeDomain: 'threadTicks' });
    return { page, session };
  };
  const chat = await open(`https://www.youtube.com/live_chat?v=${VIDEO}&rate=${RATE}`);
  const plain = await open(`${ELSEWHERE}/live_chat?rate=${RATE}`);
  const browser = context.browser();
  if (browser === null) throw new Error('the browser is not connected over CDP');
  const browserSession = await browser.newBrowserCDPSession();
  // The chat fills its 250 lines and the extension answers them.
  await chat.page.bringToFront();
  await expect
    .poll(() => chat.page.locator('#items > [data-ca-mode]').count(), { timeout: 20_000 })
    .toBeGreaterThan(200);

  const shown: Window[] = [];
  const concealed: Window[] = [];
  const without: Window[] = [];
  const unheld: Window[] = [];
  for (let round = 0; round < 2; round += 1) {
    without.push(await measure(plain.page, [chat.page], plain.session, browserSession));
    await conceal('show', false);
    unheld.push(await measure(chat.page, [plain.page], chat.session, browserSession));
    await conceal('show');
    shown.push(await measure(chat.page, [plain.page], chat.session, browserSession));
    await conceal('blur');
    concealed.push(await measure(chat.page, [plain.page], chat.session, browserSession));
  }
  const report = { shown, concealed, without, unheld };
  console.log(`perf ${JSON.stringify(report)}`);
  await test.info().attach('perf.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  // Every line answered was concealed: the blurred ones carry the attribute the style draws them
  // by. (The newest lines, about a second's worth, are still with the model.)
  const blurred = await chat.page.evaluate(() => {
    const lines = [...document.querySelectorAll('#items > [data-ca-mode]')];
    return {
      answered: lines.length,
      blurred: lines.filter((line) => line.getAttribute('data-ca-conceal') === 'blur').length,
    };
  });
  expect(blurred.answered).toBeGreaterThan(150);
  expect(blurred.blurred).toBe(blurred.answered);
  // Concealed lines are labelled bars of colour: about 1.0 times what shown lines take, on the
  // main thread and in the GPU process. Only the GPU reliably catches a filter on each line: it
  // took 1.6 times here and 2.24 times in the 60 s profiling runs, while the main thread took 1.5
  // times here and 0.90 times there.
  expect(total(concealed, 'task') / total(shown, 'task')).toBeLessThan(1.3);
  expect(total(concealed, 'gpu') / total(shown, 'gpu')).toBeLessThan(1.2);
  // Lines shown as posted (holdUntilJudged off): annotations are written as they arrive, each
  // message in a layout of its own, about 0.15 a line at this rate. The chat forces its own
  // layout while posting a line (it reads the list's height to follow the newest line, as
  // YouTube's list does), so waiting for the page's next change saved none (R51). The bound
  // catches a layout per line, such as one forced by reading the page's geometry.
  expect(total(unheld, 'layoutsPerLine') / total(without, 'layoutsPerLine')).toBeLessThan(1.3);
  // New lines waiting for their judgement (R52, the default): the chat lays a new line out
  // before the observer can keep it out, and keeping it out takes one layout more; letting lines
  // in shares the layout of their annotations and reads the scroller once a pass. Answered
  // oldest first (R56), lines come in as each batch is answered, a pass a batch: 2.32 layouts a
  // line here, against 2.09 when they came in behind the oldest in bigger passes. The bound
  // catches a further layout per line. The main thread took 0.93 to 0.96 times what lines shown
  // as posted took (a translation is written while its line is out of the layout), and the GPU
  // process 1.17 to 1.22 times.
  expect(total(shown, 'layoutsPerLine') / total(without, 'layoutsPerLine')).toBeLessThan(2.6);
  expect(total(shown, 'task') / total(unheld, 'task')).toBeLessThan(1.2);
  expect(total(shown, 'gpu') / total(unheld, 'gpu')).toBeLessThan(1.4);
  await browserSession.detach();
});
