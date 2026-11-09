import {
  capture,
  captureSync,
  Err,
  failure,
  launch,
  Ok,
  type Result,
} from '@chrome-toolbox/contracts';
import { systemTimers, type Timers } from '@chrome-toolbox/extension-core';
import { needsPageTranslation, pageLangHint } from '../language.ts';
import {
  cutSelection,
  MAX_REQUEST_UNITS,
  pageCommandMessageSchema,
  pageProtocol,
  PROGRESS_PORT,
  type Progress,
  type TranslateReply,
  type TranslateRequest,
} from '../protocol.ts';
import {
  defaultPageSettings,
  isAlways,
  isNever,
  pageSettingsSchema,
  type PageSettings,
} from '../settings.ts';
import { createOverlay, type Rect } from './overlay.ts';
import { createScheduler, pageOf } from './scheduler.ts';
import { sentenceUnits } from './segment.ts';
import { createWriter, takesBox } from './writer.ts';

/** The popup hears of the progress at most this often (ms). */
const PROGRESS_MS = 250;
/** The storage key of the page settings (`pageSettingsStore`). */
const SETTINGS_KEY = 'page';

const TEXT = {
  noSelection: '翻訳する文を選択してください',
  japanese: '選択した文は日本語です',
  failed: '翻訳できませんでした',
  cut: '（先頭の 2,000 文字だけを訳しました）',
  original: '原文：',
  translation: '訳：',
} as const;

type Listeners<L> = { addListener(listener: L): void; removeListener(listener: L): void };
/** The popup's end of `tabs.connect(tabId, { name: PROGRESS_PORT })`, as the page script sees it. */
export type ProgressPort = {
  readonly name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onDisconnect: Listeners<() => void>;
};
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => undefined;
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

/** The extension APIs the page script uses; tests pass a fake with this shape. */
export type SessionApi = {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: Listeners<MessageListener>;
    onConnect: Listeners<(port: ProgressPort) => void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      onChanged: Listeners<(changes: StorageChanges) => void>;
    };
  };
};

const isNode = (target: EventTarget | null | undefined): target is Node =>
  target !== null && target !== undefined && 'nodeType' in target;
const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();
/** The stored page settings; a record that is none counts as the defaults, as for the background. */
function settingsOf(value: unknown): PageSettings {
  const parsed = pageSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultPageSettings;
}

/**
 * Runs the page script in `doc` for as long as the document lives (not WXT's context, P18):
 * - `page/command`: `ping` answers `{ ready: true }`; `translate` starts the scheduler (again:
 *   failures are cleared and the page looked at again); `restore` stops the scheduler, then puts
 *   the original back in slices (`restoring`, then `restored`), and a `translate` sent meanwhile
 *   waits for it (P27); `selection` translates the selection (or the context menu's `text`) in
 *   the bubble.
 * - At the start, a site of the always list that is not on the never list is translated.
 * - Stored settings: a new `mode` shows every paragraph the other way; the site joining the never
 *   list restores the page.
 * - While translated, the pointer resting on a paragraph shows its original (`replace`), or the
 *   translation of one that shows no box (`pair`, P26).
 * - The popup's `PROGRESS_PORT` gets the progress while it is open: at once, then on each change,
 *   at most every 250 ms.
 * - `pagehide` stops everything (a page going into the bfcache gets its original back first, at
 *   once) and lets go of every listener, timer, port and the overlay; only the `pageshow`
 *   listener stays. Back from the bfcache, a page that was translating starts again from nothing.
 * The returned function restores the page at once and lets go of everything.
 */
export function startSession(
  doc: Document,
  api: SessionApi,
  options: Readonly<{ timers?: Timers }> = {},
): () => void {
  const timers = options.timers ?? systemTimers;
  const view = doc.defaultView;
  const send = (message: unknown): Promise<unknown> => api.runtime.sendMessage(message);
  const writer = createWriter(doc, { timers });
  const overlay = createOverlay(doc, timers);
  let settings = defaultPageSettings;
  let phase: Progress['state'] = 'idle';
  /** A `translate` came while restoring: it runs once the page is whole again (P27). */
  let again = false;
  /** The page was translating when it went into the bfcache. */
  let resume = false;
  /** The listeners are on (between the start or `pageshow` and `pagehide`). */
  let attached = false;
  /** Grows at each `pagehide`: what was asked for before it is dropped when it comes back. */
  let generation = 0;
  /** The settings changed since they were read: the read is older. */
  let fresh = false;
  /** The selection asked for last: an older answer shows nothing. */
  let asked = 0;
  /** The block under the pointer, whose tooltip shows or waits. */
  let hovered: Element | undefined;
  let hovering = false;
  /** The open progress ports and their `onDisconnect` listeners. */
  const ports = new Map<ProgressPort, () => void>();
  let sent = '';
  let cooling: number | undefined;
  let dirty = false;

  const scheduler = createScheduler({
    doc,
    writer,
    translate,
    mode: () => settings.mode,
    timers,
    onProgress: report,
  });

  /** One page batch; its abort (the page hidden, the scheduler stopped) stops it in the background. */
  async function translate(
    request: TranslateRequest,
    signal: AbortSignal,
  ): Promise<Result<TranslateReply>> {
    signal.addEventListener('abort', cancelPage, { once: true });
    const reply = await pageProtocol.send(send, 'page/translate', request);
    signal.removeEventListener('abort', cancelPage);
    return reply;
  }
  function cancelPage(): void {
    launch(
      async () => {
        const told = await pageProtocol.send(send, 'page/cancel', {});
        // A cancel that cannot be sent has nothing to stop: the background has gone.
        if (!told.ok) return;
      },
      () => undefined,
    );
  }

  // --- Progress --------------------------------------------------------------------------------

  function current(): Progress {
    const progress = scheduler.progress();
    return phase === 'on' ? progress : { ...progress, state: phase };
  }
  /** Sends `progress` to `port`; a port whose popup just closed is let go. */
  function tell(port: ProgressPort, progress: Progress): void {
    if (!captureSync(() => port.postMessage(progress), 'ipc_failed').ok) drop(port);
  }
  /** Sends the progress when it changed, at once or once `PROGRESS_MS` has passed since the last. */
  function report(): void {
    if (ports.size === 0) return;
    if (cooling !== undefined) {
      dirty = true;
      return;
    }
    post();
  }
  function post(): void {
    const progress = current();
    const key = JSON.stringify(progress);
    if (key === sent) return;
    sent = key;
    for (const port of [...ports.keys()]) tell(port, progress);
    cooling = timers.set(cool, PROGRESS_MS);
  }
  function cool(): void {
    cooling = undefined;
    if (!dirty) return;
    dirty = false;
    post();
  }
  function quiet(): void {
    if (cooling !== undefined) timers.clear(cooling);
    cooling = undefined;
    dirty = false;
    sent = '';
  }
  function drop(port: ProgressPort): void {
    const gone = ports.get(port);
    if (gone === undefined) return;
    ports.delete(port);
    port.onDisconnect.removeListener(gone);
    if (ports.size === 0) quiet();
  }
  function onConnect(port: ProgressPort): void {
    if (port.name !== PROGRESS_PORT || ports.has(port)) return;
    const gone = (): void => drop(port);
    ports.set(port, gone);
    port.onDisconnect.addListener(gone);
    const progress = current();
    if (ports.size === 1) sent = JSON.stringify(progress);
    tell(port, progress);
  }

  // --- The original on hover -------------------------------------------------------------------

  function hideTip(): void {
    hovered = undefined;
    overlay.hideTooltip();
  }
  /** What the tooltip of a translated `block` says, if it has one. */
  function tipOf(block: Element): string | undefined {
    if (settings.mode === 'replace') {
      const original = writer.originalText(block);
      return original === undefined ? undefined : `${TEXT.original}${original}`;
    }
    // Side by side, the box under a paragraph shows its translation; a paragraph in a button, a
    // summary or a link has none, and shows it here (P26).
    if (takesBox(block)) return undefined;
    const translation = writer.translationText(block);
    return translation === undefined ? undefined : `${TEXT.translation}${translation}`;
  }
  function onOver(event: MouseEvent): void {
    const [target] = event.composedPath();
    const block = isNode(target) ? writer.segmentOf(target)?.block : undefined;
    if (block === hovered) return;
    hideTip();
    if (block === undefined) return;
    hovered = block;
    const text = tipOf(block);
    if (text !== undefined) overlay.tooltip(block.getBoundingClientRect(), text);
  }
  function onOut(event: MouseEvent): void {
    if (hovered === undefined) return;
    const next = event.relatedTarget;
    if (isNode(next) && writer.segmentOf(next)?.block === hovered) return;
    hideTip();
  }
  function onScroll(): void {
    hideTip();
  }
  function listenHover(on: boolean): void {
    if (on === hovering) return;
    hovering = on;
    if (on) {
      doc.addEventListener('mouseover', onOver, { passive: true });
      doc.addEventListener('mouseout', onOut, { passive: true });
      doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
      return;
    }
    doc.removeEventListener('mouseover', onOver);
    doc.removeEventListener('mouseout', onOut);
    doc.removeEventListener('scroll', onScroll, { capture: true });
    hideTip();
  }

  // --- Translating and restoring ---------------------------------------------------------------

  function translatePage(): void {
    if (phase === 'restoring') {
      again = true;
      return;
    }
    if (phase !== 'on') {
      phase = 'on';
      listenHover(true);
    }
    scheduler.start();
    report();
  }

  function restore(): void {
    again = false;
    if (phase !== 'on') return;
    phase = 'restoring';
    listenHover(false);
    // Stopped first, the scheduler writes nothing into the page being restored (P27).
    scheduler.stop();
    report();
    writer.restore({ sliced: true, done: restored });
  }
  function restored(): void {
    // `pagehide` finished the restore itself.
    if (phase !== 'restoring') return;
    phase = 'restored';
    report();
    if (!again) return;
    again = false;
    translatePage();
  }

  // --- The selection bubble --------------------------------------------------------------------

  /** Where the selection is on the screen; the top of the screen when it is not in this frame. */
  function anchorOf(selection: Selection | null): Rect {
    if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return rect;
    }
    const width = view?.innerWidth ?? 0;
    return { left: 0, top: 0, right: width, bottom: 0, width, height: 0 };
  }

  /** Translates `text` in text-only units of whole sentences, `MAX_REQUEST_UNITS` a request. */
  async function translateText(text: string): Promise<Result<string>> {
    const units = sentenceUnits(text);
    const page = pageOf(doc);
    let translation = '';
    for (let from = 0; from < units.length; from += MAX_REQUEST_UNITS) {
      const part = units.slice(from, from + MAX_REQUEST_UNITS);
      const reply = await pageProtocol.send(send, 'page/translate', {
        purpose: 'selection',
        units: part.map((unit, i) => ({ id: i + 1, tokens: [{ t: 'text', text: unit }] })),
        page,
      });
      if (!reply.ok) return reply;
      const pieces = new Map(reply.value.results.map((result) => [result.id, result.pieces]));
      for (const [i] of part.entries()) {
        const translated = pieces.get(i + 1);
        if (translated === undefined) return Err(failure('response_invalid'));
        translation += translated.join('');
      }
    }
    return Ok(translation);
  }

  function showAnswer(ask: number, rect: Rect, result: Result<string>, cut: boolean): void {
    // A newer selection, or the viewer closed the bubble (or the page left) before the answer.
    if (ask !== asked || !overlay.bubbleShown()) return;
    overlay.bubble(
      rect,
      result.ok
        ? { kind: 'done', text: result.value, ...(cut ? { note: TEXT.cut } : {}) }
        : { kind: 'message', text: TEXT.failed },
    );
  }

  /**
   * Translates the selection in the bubble: the page's own (`getSelection`), or else `given`
   * (the context menu's, for a selection in a frame; `givenCut` when the background cut it), its
   * spaces squashed, at most `MAX_SELECTION` long. It goes at once, apart from the page's batches.
   */
  function translateSelection(given: string | undefined, givenCut: boolean): void {
    const selection = doc.getSelection();
    const chosen = squash(selection?.toString() ?? '');
    const text = chosen === '' ? squash(given ?? '') : chosen;
    const rect = anchorOf(selection);
    asked += 1;
    const ask = asked;
    if (text === '') {
      overlay.bubble(rect, { kind: 'message', text: TEXT.noSelection });
      return;
    }
    const limited = cutSelection(text);
    const cut = limited.cut || (chosen === '' && givenCut);
    const source = limited.text.trim();
    if (!needsPageTranslation(source, pageLangHint(doc))) {
      overlay.bubble(rect, { kind: 'message', text: TEXT.japanese });
      return;
    }
    overlay.bubble(rect, { kind: 'loading' });
    launch(
      async () => {
        showAnswer(ask, rect, await translateText(source), cut);
      },
      (error) => showAnswer(ask, rect, Err(error), cut),
    );
  }

  // --- Commands and settings -------------------------------------------------------------------

  function onMessage(
    message: unknown,
    _sender: unknown,
    sendResponse: (response: unknown) => void,
  ): undefined {
    const command = pageCommandMessageSchema.safeParse(message);
    if (!command.success) return undefined;
    const { payload } = command.data;
    switch (payload.action) {
      case 'ping':
        sendResponse({ ready: true });
        return undefined;
      case 'translate':
        translatePage();
        break;
      case 'restore':
        restore();
        break;
      case 'selection':
        translateSelection(payload.text, payload.cut ?? false);
        break;
    }
    sendResponse({});
    return undefined;
  }

  const excluded = (list: PageSettings): boolean =>
    isNever(view?.location.hostname ?? '', list.never);

  function apply(next: PageSettings): void {
    const before = settings;
    settings = next;
    if (next.mode !== before.mode) {
      hideTip();
      // A restore under way takes every paragraph back anyway.
      if (phase === 'on') writer.setMode(next.mode);
      report();
    }
    if (!excluded(before) && excluded(next)) restore();
  }

  function onStorageChanged(changes: StorageChanges): void {
    if (!Object.hasOwn(changes, SETTINGS_KEY)) return;
    fresh = true;
    apply(settingsOf(changes[SETTINGS_KEY]?.newValue));
  }

  async function loadSettings(): Promise<Result<PageSettings>> {
    const stored = await capture(() => api.storage.local.get(SETTINGS_KEY), 'storage_failed');
    return stored.ok ? Ok(settingsOf(stored.value[SETTINGS_KEY])) : stored;
  }

  /** Settings read for the attach of `turn`: `begin` says whether to translate with them. */
  function loaded(
    turn: number,
    result: Result<PageSettings>,
    begin: (settings: PageSettings) => boolean,
  ): void {
    if (turn !== generation) return;
    // Unreadable settings leave the ones held; a change heard meanwhile is newer than the read.
    if (result.ok && !fresh) apply(result.value);
    if (begin(settings) && !excluded(settings)) translatePage();
  }

  // --- The page's life -------------------------------------------------------------------------

  function attach(begin: (settings: PageSettings) => boolean): void {
    attached = true;
    fresh = false;
    const turn = generation;
    api.runtime.onMessage.addListener(onMessage);
    api.runtime.onConnect.addListener(onConnect);
    api.storage.local.onChanged.addListener(onStorageChanged);
    view?.addEventListener('pagehide', onPageHide);
    launch(
      async () => {
        loaded(turn, await loadSettings(), begin);
      },
      (error) => loaded(turn, Err(error), begin),
    );
  }

  function detach(): void {
    attached = false;
    generation += 1;
    asked += 1;
    view?.removeEventListener('pagehide', onPageHide);
    listenHover(false);
    overlay.dispose();
    const open = [...ports];
    ports.clear();
    quiet();
    // The extension's own objects go last: one that has ended (P28) may have taken its runtime
    // with it, whose listeners and ports are then never called again.
    const released = captureSync(() => {
      api.runtime.onMessage.removeListener(onMessage);
      api.runtime.onConnect.removeListener(onConnect);
      api.storage.local.onChanged.removeListener(onStorageChanged);
      for (const [port, gone] of open) {
        port.onDisconnect.removeListener(gone);
        port.disconnect();
      }
    }, 'ipc_failed');
    if (!released.ok) return;
  }

  /** Stops the work; with `restoreNow`, the page gets its original back at once. */
  function halt(restoreNow: boolean): void {
    again = false;
    phase = 'idle';
    scheduler.stop();
    if (restoreNow) writer.restore({ sliced: false });
  }

  function onPageHide(event: PageTransitionEvent): void {
    resume = phase === 'on' || again;
    // A restore under way ends now rather than in timers of a page that is gone.
    halt(event.persisted || phase === 'restoring');
    detach();
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (!event.persisted || attached) return;
    const was = resume;
    resume = false;
    attach(() => was);
  }

  view?.addEventListener('pageshow', onPageShow);
  attach((stored) => isAlways(doc.URL, stored.always));
  return () => {
    view?.removeEventListener('pageshow', onPageShow);
    resume = false;
    halt(true);
    if (attached) detach();
  };
}
