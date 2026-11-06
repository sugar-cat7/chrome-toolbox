import { setTimeout as sleep } from 'node:timers/promises';
import { commentLimits } from '@chrome-toolbox/extension-core';
import { expect, heapSnapshotParts, test, usedHeap } from '@chrome-toolbox/extension-core/testing';
import { SOAK_WARM_UP, soakMinutes, soakTimeout } from '../../../../tools/quality/soak.ts';
import { connect, linesAfter, newest, openChat, statsOf } from './chat.ts';

/**
 * Minutes the chat runs at 20 messages a second: SOAK_MINUTES, 2 by default, 120 for the long
 * run (the same parse as the runner's and the gate's deadlines).
 */
const SOAK_MINUTES = soakMinutes();
/**
 * Before the first measurement every bounded buffer fills: the content script remembers 1,000
 * annotations (50 s at 20 a second) and the chat keeps 250 lines.
 */
const WARM_UP_MS = SOAK_WARM_UP;
const RATE = 20;
const MB = 1024 * 1024;
const VIDEO = 'fixtureSoak01';

test('20 msg/s for SOAK_MINUTES keeps heap and long tasks within budget', async ({
  context,
  platform,
  sidePanel,
  llama,
  longTasks,
}) => {
  test.setTimeout(soakTimeout(SOAK_MINUTES));
  await connect(sidePanel, llama.origin);
  // The side panel stays open on the summary, as a viewer would leave it.
  await sidePanel.getByRole('tab', { name: '要約' }).click();
  const { watch, chat, documents } = await openChat(context, platform, {
    video: VIDEO,
    rate: RATE,
  });
  // From now on the chat frame keeps every long task (and those since it loaded).
  await longTasks(chat);
  await sleep(WARM_UP_MS);
  // The first measurement is taken with the panel showing a summary of the warm chat (about
  // 1,200 comments), not the near-empty one it made when the chat opened. The 2-minute refreshes
  // after it are part of what the end measurement covers.
  await sidePanel.getByRole('button', { name: '更新' }).click();
  await expect
    .poll(async () => {
      const counted = await sidePanel.getByText(/^対象 [\d,]+件/u).textContent();
      return Number(/対象 ([\d,]+)件/u.exec(counted ?? '')?.[1]?.replaceAll(',', ''));
    })
    .toBeGreaterThan((WARM_UP_MS / 1000) * RATE * 0.8);

  const start = { content: await usedHeap(watch), panel: await usedHeap(sidePanel) };
  // The side panel's heap apart from compiled code, for its leak check (below).
  const panelBefore = await heapSnapshotParts(sidePanel);
  // Minute k is sampled k minutes after this, by the clock: the time each sample takes (forced
  // GCs and a stats request, a second or more under load) does not push the later ones back.
  const began = Date.now();
  let end = { minute: 0, ...start, stats: await statsOf(sidePanel, VIDEO) };
  const samples = [end];
  for (let minute = 1; minute <= SOAK_MINUTES; minute += 1) {
    await sleep(Math.max(0, began + minute * 60_000 - Date.now()));
    end = {
      minute,
      content: await usedHeap(watch),
      panel: await usedHeap(sidePanel),
      stats: await statsOf(sidePanel, VIDEO),
    };
    samples.push(end);
  }
  const panelAfter = await heapSnapshotParts(sidePanel);
  const tasks = await longTasks(chat);
  const posted = await newest(chat);
  const report = {
    minutes: SOAK_MINUTES,
    rate: RATE,
    posted,
    longTasks: tasks,
    samples,
    panelParts: { start: panelBefore, end: panelAfter },
  };
  console.log(`soak ${JSON.stringify(report)}`);
  await test.info().attach('soak.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });

  // The chat kept up to the end: the last second's lines up to the newest one read above are
  // answered (later ones are still on their way).
  await expect
    .poll(async () =>
      (await linesAfter(chat, posted - RATE)).filter((line) => line.n <= posted && !line.mode),
    )
    .toEqual([]);
  for (const sample of samples)
    expect(sample.content, `content frame heap at minute ${sample.minute}`).toBeLessThan(30 * MB);
  expect(end.content, `content frame heap grew from ${start.content}`).toBeLessThanOrEqual(
    start.content * 1.1,
  );
  // The side panel: what a leak grows (its objects, strings, closures) stays within 1.1× of the
  // start. Its whole heap also holds the code V8 compiles while the summary re-renders every 2
  // minutes (about +0.27 MB, levelling off after an hour; bounded by the panel's own code), so
  // that only has to stay under twice the start.
  expect(panelAfter.data, `side panel objects grew from ${panelBefore.data}`).toBeLessThanOrEqual(
    panelBefore.data * 1.1,
  );
  for (const sample of samples)
    expect(sample.panel, `side panel heap at minute ${sample.minute}`).toBeLessThan(
      start.panel * 2,
    );
  expect(tasks.filter((duration) => duration > 50)).toEqual([]);
  // The observer is live in the chat frame: a task of the frame's own over 50 ms shows up.
  await chat.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          const begin = performance.now();
          while (performance.now() - begin < 80);
          resolve();
        }, 0);
      }),
  );
  await expect
    .poll(async () => (await longTasks(chat)).filter((duration) => duration > 50).length)
    .toBe(1);
  // The stub answers at once: every comment reached the model (none only stored: the chat was in
  // front all along), and the store stayed bounded.
  expect(end.stats).toMatchObject({ dropped: 0, failed: 0, expired: 0, stored: 0, judge: 'clef' });
  expect(end.stats.records).toBeLessThanOrEqual(commentLimits.store.maxItems);
  expect(platform.requests).toEqual(documents);
});
