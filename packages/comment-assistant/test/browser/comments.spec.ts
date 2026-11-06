import { setTimeout as sleep } from 'node:timers/promises';
import { summaryPrompt } from '@chrome-toolbox/extension-core';
import {
  chatCompletion,
  defaultResponder,
  expect,
  STUB_ABUSIVE,
  STUB_QUESTION,
  STUB_TOPIC,
  summaryReply,
  test,
} from '@chrome-toolbox/extension-core/testing';
import { filterKey } from '../../src/filters.ts';
import {
  connect,
  hiddenOf,
  kindOf,
  linesAfter,
  newest,
  openChat,
  statsOf,
  type Line,
} from './chat.ts';

// The whole chat flow on a made-up watch page whose live chat iframe keeps posting
// (test/browser/fixtures), against the llama.cpp stub: its default responder translates every
// comment the batch marks (`訳:` + text) and calls a text ending in `?` a question. Clef decides
// abuse (R37, R43): the stub's model calls `BAD` and `ROUGH` lines abusive, so the extension asks
// Clef after the reply, which scores `BAD` high and `ROUGH` low; `HARSH idiot` lines hold an
// abuse cue, so Clef, which scores them high, is asked while the model calls them chatter.

/** Lines the chat has answered: each has a display mode. */
const answered = (lines: readonly Line[]): Line[] => lines.filter((line) => line.mode !== null);

const VIDEO = 'fixtureLive01';

test('translates, highlights and removes comments in the live chat iframe without extra platform requests', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  await connect(sidePanel, llama.origin);
  const { chat, documents } = await openChat(context, platform, { video: VIDEO, rate: 5 });
  await sleep(5_000);
  const shown = await newest(chat);
  expect(shown, 'about 25 lines in 5 seconds').toBeGreaterThanOrEqual(20);
  // Every line posted in those 5 seconds gets its display: the stub answers at once, so the
  // pipeline keeps up (the stats tell why if not: expired lines waited too long, none means a
  // message was lost).
  try {
    await expect
      .poll(async () => (await linesAfter(chat)).filter((line) => line.n <= shown && !line.mode), {
        timeout: 10_000,
      })
      .toEqual([]);
  } finally {
    await test.info().attach('stats.json', {
      body: JSON.stringify(await statsOf(sidePanel, VIDEO)),
      contentType: 'application/json',
    });
  }
  // Counters that only grow: none of the comments so far was dropped, failed or expired, and
  // none was only stored, the chat being in front all along (the chat keeps posting, so what is
  // pending right now says nothing).
  expect(await statsOf(sidePanel, VIDEO)).toMatchObject({
    dropped: 0,
    failed: 0,
    expired: 0,
    stored: 0,
    judge: 'clef',
  });
  const lines = (await linesAfter(chat)).filter((line) => line.n <= shown);
  const of = (kind: ReturnType<typeof kindOf>): Line[] =>
    lines.filter((line) => kindOf(line.text) === kind);
  const kinds = ['question', 'bad', 'rough', 'harsh', 'english', 'japanese', 'reaction'] as const;
  for (const kind of kinds) expect(of(kind).length, `${kind} lines were posted`).toBeGreaterThan(0);

  // Questions are highlighted, what Clef found abusive removed from the chat (R54), the rest
  // shown: a line the model alone called abusive (ROUGH) too.
  expect(of('question').map((line) => [line.text, line.mode, line.category])).toEqual(
    of('question').map((line) => [line.text, 'highlight', 'question']),
  );
  for (const kind of ['bad', 'harsh'] as const)
    expect(of(kind).map((line) => [line.text, line.mode, line.category])).toEqual(
      of(kind).map((line) => [line.text, 'hide', 'abusive']),
    );
  expect(of('rough').map((line) => [line.text, line.mode, line.category])).toEqual(
    of('rough').map((line) => [line.text, 'show', 'chatter']),
  );
  for (const kind of ['english', 'japanese', 'reaction'] as const)
    expect(of(kind).map((line) => line.mode)).toEqual(of(kind).map(() => 'show'));
  // The review list holds the BAD and HARSH lines as Clef's verdicts, with its probability, and
  // no ROUGH line.
  const hidden = await hiddenOf(sidePanel, VIDEO);
  for (const kind of ['bad', 'harsh'] as const) {
    const listed = hidden.filter((entry) => kindOf(entry.text) === kind);
    expect(listed.length, `${kind} lines are listed`).toBeGreaterThan(0);
    expect(listed.map((entry) => [entry.category, entry.source, entry.abusive])).toEqual(
      listed.map(() => ['abusive', 'clef', STUB_ABUSIVE]),
    );
  }
  expect(hidden.filter((entry) => kindOf(entry.text) === 'rough')).toEqual([]);
  // Comments in other languages show the translation in place; Japanese ones stay as written.
  for (const line of [...of('english'), ...of('bad'), ...of('rough'), ...of('harsh')]) {
    expect(line.text).toMatch(/^訳:/u);
    expect(line.translated).toBe(true);
  }
  for (const line of of('japanese')) {
    expect(line.text).not.toMatch(/^訳:/u);
    expect(line.translated).toBe(false);
  }
  await expect(
    chat.locator('#message', { hasText: /^訳:that dodge was clean/u }).first(),
  ).toBeVisible();

  // A removed line leaves no box and no label in the chat (R54).
  await chat.evaluate(() => {
    Object.assign(window, { fixturePaused: true });
  });
  const bad = of('bad').at(-1);
  const concealed = chat.locator(`#fixture-line-${bad?.n}`);
  await expect(concealed).toHaveAttribute('data-ca-conceal', 'hide');
  expect(await concealed.evaluate((line) => (line as HTMLElement).offsetHeight)).toBe(0);
  expect(await concealed.evaluate((line) => getComputedStyle(line, '::before').content)).toBe(
    'none',
  );
  // A viewer who conceals abusive lines instead (伏せる) gets a bar of the category's colour with
  // a label; its text is not shown (nor in the accessibility tree) until a click on the line
  // reveals it (R51).
  await sidePanel.evaluate(
    async (keys) => {
      const { chrome } = globalThis as unknown as {
        chrome: { storage: { local: { set(items: object): Promise<void> } } };
      };
      const blur = { translate: true, showOriginal: false, modes: { abusive: 'blur' } };
      await chrome.storage.local.set(Object.fromEntries(keys.map((key) => [key, blur])));
    },
    [filterKey('youtube', VIDEO), filterKey('youtube', '@FixtureStreamer')],
  );
  await expect(concealed).toHaveAttribute('data-ca-conceal', 'blur');
  await expect(concealed.locator('#message')).toBeHidden();
  expect(await concealed.evaluate((line) => getComputedStyle(line, '::before').content)).toBe(
    '"伏せたコメント（攻撃的）· クリックで表示"',
  );
  // The bar keeps the line's height: revealing it does not move the chat.
  const concealedHeight = await concealed.evaluate((line) => (line as HTMLElement).offsetHeight);
  await concealed.click();
  await expect(concealed).toHaveAttribute('data-ca-revealed', '');
  await expect(concealed.locator('#message')).toBeVisible();
  expect(await concealed.evaluate((line) => (line as HTMLElement).offsetHeight)).toBe(
    concealedHeight,
  );

  // The chat was read from the page: one platform request per document the test opened.
  expect(platform.requests).toEqual(documents);
});

/** What the made-up chat recorded of one line: when it was added and when it came in. */
type Held = Readonly<{
  text: string;
  added: number;
  waited: boolean;
  shown?: number;
  /** Concealed (`data-ca-conceal`) before `data-ca-wait` came off. */
  concealedFirst?: boolean;
}>;

test('lets a line into the chat only once it is judged, and keeps the chat at its end (R52)', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  // The model and Clef take a moment to answer, as a real server does: new lines wait for them.
  // One batch runs at a time (the stub has 2 slots), and keeps up with 5 lines a second.
  llama.respond = async (request) => {
    await sleep(200);
    return defaultResponder(request);
  };
  await connect(sidePanel, llama.origin);
  const { chat } = await openChat(context, platform, { video: 'fixtureLive04', rate: 5 });
  await expect(chat.locator('#items > [data-ca-mode]').first()).toBeAttached();
  // Records each new line as the page adds it, and the changes of its display in order.
  await chat.evaluate(() => {
    const items = document.getElementById('items');
    if (items === null) throw new Error('no chat list');
    const log = new Map<string, Held>();
    const concealed = new Set<string>();
    Object.assign(window, { held: log });
    new MutationObserver((records) => {
      const now = performance.now();
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes)
            if (node instanceof Element)
              log.set(node.id, {
                text: node.querySelector('#message')?.textContent ?? '',
                added: now,
                waited: node.hasAttribute('data-ca-wait'),
              });
          continue;
        }
        const target = record.target;
        if (!(target instanceof Element)) continue;
        if (record.attributeName === 'data-ca-conceal') concealed.add(target.id);
        const entry = log.get(target.id);
        if (record.attributeName !== 'data-ca-wait' || record.oldValue === null || !entry) continue;
        log.set(target.id, { ...entry, shown: now, concealedFirst: concealed.has(target.id) });
      }
    }).observe(items, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-ca-wait', 'data-ca-conceal'],
    });
  });
  await sleep(5_000);
  // The site stops posting, as YouTube and Twitch do while the viewer reads above; the lines
  // still waiting come in.
  const scroller = chat.locator('#item-scroller');
  const pause = (paused: boolean): Promise<void> =>
    chat.evaluate((value) => {
      Object.assign(window, { fixturePaused: value });
    }, paused);
  await pause(true);
  await expect.poll(() => chat.locator('#items > [data-ca-wait]').count()).toBe(0);
  const log = await chat.evaluate(() => [
    ...(Reflect.get(window, 'held') as Map<string, Held>).values(),
  ]);
  await test.info().attach('held.json', {
    body: JSON.stringify(log.map(({ text, ...rest }) => ({ kind: kindOf(text), ...rest }))),
    contentType: 'application/json',
  });
  // Every new line waited, and none longer than 2 s.
  expect(log.length).toBeGreaterThanOrEqual(20);
  expect(log.filter((entry) => !entry.waited)).toEqual([]);
  const waits = log.map((entry) => (entry.shown ?? Infinity) - entry.added).sort((a, b) => a - b);
  expect(waits.at(-1)).toBeLessThan(2_100);
  // The abusive lines were removed (消す, R54) before they came in: none ever showed.
  const abusive = log.filter((entry) => ['bad', 'harsh'].includes(kindOf(entry.text)));
  expect(abusive.length).toBeGreaterThan(0);
  expect(abusive.filter((entry) => entry.concealedFirst !== true)).toEqual([]);
  expect(
    await chat.evaluate(
      () =>
        [...document.querySelectorAll('#items > [data-ca-conceal="hide"]')].filter(
          (line) => (line as HTMLElement).offsetHeight > 0,
        ).length,
    ),
  ).toBe(0);
  // The chat was at its end, so it still is: the lines let in were followed.
  const gap = (): Promise<number> =>
    scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  expect(await gap()).toBeLessThanOrEqual(1);

  // The viewer scrolls up while lines wait: what they read stays where it is.
  await pause(false);
  await sleep(900);
  const before = await chat.evaluate(() => {
    Object.assign(window, { fixturePaused: true });
    const list = document.getElementById('item-scroller');
    const lines = document.querySelectorAll('#items > :not([data-ca-wait])');
    const read = lines[lines.length - 10];
    if (list === null || read === undefined) throw new Error('no chat');
    list.scrollTop -= 150;
    return {
      waiting: document.querySelectorAll('#items > [data-ca-wait]').length,
      top: list.scrollTop,
      read: read.id,
      at: read.getBoundingClientRect().top,
    };
  });
  expect(before.waiting).toBeGreaterThan(0);
  await expect.poll(() => chat.locator('#items > [data-ca-wait]').count()).toBe(0);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before.top);
  expect(
    await chat.locator(`#${before.read}`).evaluate((line) => line.getBoundingClientRect().top),
  ).toBe(before.at);
  expect(await gap()).toBeGreaterThan(100);
});

test('shows originals and a connection error while llama.cpp is down, then recovers', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  await connect(sidePanel, llama.origin);
  const { chat } = await openChat(context, platform, { video: 'fixtureLive02', rate: 10 });
  await expect(chat.locator('#message', { hasText: /^訳:/u }).first()).toBeVisible();

  await llama.stop();
  const down = await newest(chat);
  // English lines posted while the server is down stay in the original and nothing is hidden.
  const english = async (after: number): Promise<Line[]> =>
    answered(await linesAfter(chat, after)).filter((line) => kindOf(line.text) === 'english');
  await expect.poll(async () => (await english(down)).length).toBeGreaterThanOrEqual(3);
  const outage = answered(await linesAfter(chat, down)).filter(
    (line) => kindOf(line.text) !== 'reaction',
  );
  expect(outage.filter((line) => line.translated || line.text.startsWith('訳:'))).toEqual([]);
  expect(outage.filter((line) => line.mode !== 'show')).toEqual([]);
  // New lines come in as they are posted: none waits for a judgement that cannot come (R52).
  for (let sample = 0; sample < 5; sample += 1) {
    expect(await chat.locator('#items > [data-ca-wait]').count()).toBe(0);
    await sleep(150);
  }
  // The settings tab tells why (asked again each time the tab opens).
  await sidePanel.getByRole('tab', { name: '要約' }).click();
  await sidePanel.getByRole('tab', { name: '設定' }).click();
  const judge = sidePanel.getByRole('region', { name: '有害判定' });
  await expect(judge).toContainText('llama.cpp に接続できません');

  await llama.start();
  const up = await newest(chat);
  await expect
    .poll(async () => (await english(up)).filter((line) => line.translated).length)
    .toBeGreaterThanOrEqual(3);
  await sidePanel.getByRole('tab', { name: '要約' }).click();
  await sidePanel.getByRole('tab', { name: '設定' }).click();
  await expect(judge).toContainText('Clef で判定しています');
  await expect(judge).not.toContainText('接続できません');
});

test('side panel summary reflects the last 5 minutes', async ({
  context,
  sidePanel,
  platform,
  llama,
}) => {
  // The user turn of a 5-minute summary starts with this line (`summaryPrompt`); the stub
  // answers that window with a topic of its own.
  const [, header] = summaryPrompt({
    windowMinutes: 5,
    questions: [],
    peaks: [],
    others: [],
  }).messages;
  const fiveMinutes: string[] = [];
  llama.respond = (request) => {
    const user = request.chat?.messages.find((message) => message.role === 'user')?.content;
    if (header === undefined || !user?.startsWith(`${header.content}\n`))
      return defaultResponder(request);
    fiveMinutes.push(user);
    return chatCompletion(summaryReply(user, '直近5分の話題'));
  };
  await connect(sidePanel, llama.origin);
  const { chat } = await openChat(context, platform, { video: 'fixtureLive03', rate: 10 });
  // Both kinds of question are answered before the summary: English (translated) and Japanese.
  await expect
    .poll(async () =>
      [
        ...new Set(
          answered(await linesAfter(chat))
            .filter((line) => line.mode === 'highlight')
            .map((line) => (line.text.startsWith('訳:') ? 'english' : 'japanese')),
        ),
      ].sort(),
    )
    .toEqual(['english', 'japanese']);

  // The summary tab opens on the last 15 minutes.
  await sidePanel.getByRole('tab', { name: '要約' }).click();
  await expect(sidePanel.getByText('Fixture Raid Night: the clockwork tower')).toBeVisible();
  await expect(sidePanel.getByText(STUB_TOPIC)).toBeVisible();
  const five = sidePanel.getByRole('button', { name: '5分', exact: true });
  await five.click();
  await expect(five).toHaveAttribute('aria-pressed', 'true');
  await expect(sidePanel.getByText('直近5分の話題')).toBeVisible();
  await expect(sidePanel.getByText(STUB_TOPIC)).toHaveCount(0);
  // The model read the chat as shown (translations, Japanese as written); its merged question
  // stands for the questions counted from the store.
  expect(fiveMinutes).toHaveLength(1);
  // Questions are listed most asked first, then newest: any Q line may hold either kind.
  expect(fiveMinutes[0]).toMatch(/^Q\d+ .*訳:which level is this \d+\?/mu);
  expect(fiveMinutes[0]).toMatch(/^Q\d+ (?:×\d+ )?"次はどのボスに行くの \d+\?"$/mu);
  await expect(sidePanel.getByText(STUB_QUESTION)).toBeVisible();
  const counted = await sidePanel.getByText(/^対象 [\d,]+件/u).textContent();
  const total = Number(/対象 ([\d,]+)件/u.exec(counted ?? '')?.[1]?.replaceAll(',', ''));
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual((await statsOf(sidePanel, 'fixtureLive03')).records);
});
