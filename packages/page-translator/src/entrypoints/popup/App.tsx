import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { launch, type AppError, type Result } from '@chrome-toolbox/contracts';
import { exclusionOf, type ActiveTab, type PopupPort } from '../../popup.ts';
import type { DisplayMode, Progress } from '../../protocol.ts';
import { siteOf, type PageSettings } from '../../settings.ts';

const MODES: readonly Readonly<{ mode: DisplayMode; label: string }>[] = [
  { mode: 'replace', label: '置き換え' },
  { mode: 'pair', label: '併記' },
];

const TEXT = {
  restricted: 'このページは翻訳できません',
  excluded: 'このサイトは翻訳しない設定です',
  limit: '段落が多いため、ここから先は翻訳しません',
  unreachable: 'llama.cpp に接続できません。設定を確認してください。',
  plamoMissing: 'PLaMo が見つからないため、Gemma で翻訳しています',
  noTab: 'このタブを読み取れませんでした',
  unreadable: '設定を読み込めませんでした',
  notStarted: '翻訳を始められませんでした',
  notRestored: '原文に戻せませんでした',
  denied: 'このサイトへのアクセスが許可されませんでした',
  notSaved: '設定を変えられませんでした',
  noOptions: '設定ページを開けませんでした',
  parallel: '段落を訳せていません。llama.cpp を --parallel 2 以上で起動しているか確かめてください',
  askChrome: 'Chrome がこのサイトへのアクセスの許可を求めます。',
  clearsNever: 'オンにすると「このサイトでは翻訳しない」はオフになります。',
} as const;
/** A parent domain's never entry (`entry`) excludes the site: only the options page changes it. */
const byParentText = (entry: string): string => `${entry} の設定で翻訳しないサイトになっています`;

/**
 * The progress line of a translated page: the paragraphs translated of those found, whether some
 * wait (the ones off screen go last) and how many stay in the original. None when the page is not
 * translated (`idle`, `restoring`, `restored`).
 */
function progressLine({ state, found, done, failed }: Progress): string | undefined {
  if (state !== 'on') return undefined;
  const count = `翻訳済み ${done}/${found} 段落`;
  const line = found > done + failed ? `${count} · 画面外は後回し` : count;
  return failed > 0 ? `${line} · ${failed} 段落は原文のまま` : line;
}

type TabState = { status: 'loading' } | { status: 'ready'; tab: ActiveTab } | { status: 'failed' };

/**
 * The popup (mock A): translate the tab the toolbar button was pressed on or put its original
 * back, the display mode of every tab, the site's always and never switches, and the tab's
 * progress while the popup is open (its port; nothing polls).
 */
export function App({ port }: { port: PopupPort }) {
  const [tab, setTab] = useState<TabState>({ status: 'loading' });
  const [settings, setSettings] = useState<PageSettings | undefined>();
  const [progress, setProgress] = useState<Progress | undefined>();
  /** Chrome refused to let the extension into the page (`page_restricted` from the start). */
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  /** Counts the starts: the page script is there after one, so the port connects again. */
  const [starts, setStarts] = useState(0);
  const mounted = useRef(true);
  const alwaysHint = useId();
  const parentNote = useId();
  const modeLabel = useId();

  /** Reads the page settings again, after a change or one the background made. */
  const refresh = useCallback(() => {
    launch(
      async () => {
        const loaded = await port.settings.load();
        if (!mounted.current) return;
        if (loaded.ok) setSettings(loaded.value);
        else setMessage(TEXT.unreadable);
      },
      () => {
        if (mounted.current) setMessage(TEXT.unreadable);
      },
    );
  }, [port]);

  useEffect(() => {
    mounted.current = true;
    launch(
      async () => {
        const found = await port.activeTab();
        if (!mounted.current) return;
        setTab(found.ok ? { status: 'ready', tab: found.value } : { status: 'failed' });
      },
      () => {
        if (mounted.current) setTab({ status: 'failed' });
      },
    );
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [port, refresh]);

  const active = tab.status === 'ready' ? tab.tab : undefined;
  // A page that is no site (`chrome://`, a file, an extension's page) takes no page script.
  const site = active?.url === undefined ? undefined : siteOf(active.url);
  const restricted = refused || site?.ok === false;
  const blocked = active === undefined || restricted;
  const known = site?.ok === true ? site.value : undefined;
  const exclusion =
    known === undefined || settings === undefined ? undefined : exclusionOf(known, settings.never);
  const excluded = exclusion !== undefined;
  // A parent domain's entry covers other sites too: the popup leaves it to the options page and
  // lifts nothing under it (P29).
  const byParent = exclusion?.parent === true ? exclusion.entry : undefined;
  // An always entry the never list cancels does nothing: shown off, the switches never contradict.
  const always =
    known !== undefined &&
    settings !== undefined &&
    !excluded &&
    settings.always.includes(known.pattern);
  const switchesOff =
    blocked || busy || known === undefined || settings === undefined || byParent !== undefined;
  const tabId = active?.id;

  useEffect(() => {
    if (tabId === undefined || restricted) return undefined;
    return port.watch(tabId, setProgress);
  }, [port, tabId, restricted, starts]);

  /** Runs `change`; its failure shows as `explain` says, and the settings are read again. */
  function apply(change: () => Promise<Result<void>>, explain: (error: AppError) => string): void {
    setBusy(true);
    setMessage('');
    launch(
      async () => {
        const changed = await change();
        if (!mounted.current) return;
        setBusy(false);
        if (!changed.ok) setMessage(explain(changed.error));
        refresh();
      },
      (error) => {
        if (!mounted.current) return;
        setBusy(false);
        setMessage(explain(error));
      },
    );
  }

  function start(target: ActiveTab): void {
    setBusy(true);
    setMessage('');
    launch(
      async () => {
        const started = await port.start(target);
        if (!mounted.current) return;
        setBusy(false);
        if (started.ok) setStarts((count) => count + 1);
        else if (started.error.internalCode === 'page_restricted') setRefused(true);
        // The site joined the never list since the popup read it: the line says so.
        else if (started.error.internalCode === 'page_excluded') refresh();
        else setMessage(TEXT.notStarted);
      },
      () => {
        if (!mounted.current) return;
        setBusy(false);
        setMessage(TEXT.notStarted);
      },
    );
  }

  function restore(target: ActiveTab): void {
    apply(
      () => port.restore(target),
      () => TEXT.notRestored,
    );
  }

  /** A link to the options page: Chrome opens it in a tab (`open_in_tab`). */
  function openOptions(event: MouseEvent<HTMLAnchorElement>): void {
    event.preventDefault();
    launch(
      async () => {
        const opened = await port.openOptions();
        if (mounted.current && !opened.ok) setMessage(TEXT.noOptions);
      },
      () => {
        if (mounted.current) setMessage(TEXT.noOptions);
      },
    );
  }

  function chooseMode(mode: DisplayMode): void {
    if (settings === undefined) return;
    // Shown at once; the stored settings follow.
    setSettings({ ...settings, mode });
    apply(
      () => port.setMode(mode),
      () => TEXT.notSaved,
    );
  }

  const lines = [
    ...(restricted ? [TEXT.restricted] : []),
    ...(tab.status === 'failed' ? [TEXT.noTab] : []),
    ...(excluded ? [TEXT.excluded] : []),
    ...(progress === undefined ? [] : progressLines(progress)),
    ...(message === '' ? [] : [message]),
  ];

  return (
    <main className="flex w-80 flex-col gap-3 p-4 text-sm text-slate-900">
      <h1 className="text-base font-semibold">ページ翻訳</h1>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={blocked || busy || excluded}
          onClick={() => {
            if (active !== undefined) start(active);
          }}
          className="flex-1 rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50"
        >
          このページを翻訳
        </button>
        <button
          type="button"
          disabled={blocked || busy}
          onClick={() => {
            if (active !== undefined) restore(active);
          }}
          className="flex-1 rounded border border-slate-300 px-3 py-1.5 disabled:opacity-50"
        >
          原文に戻す
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span id={modeLabel}>表示</span>
        <div
          role="radiogroup"
          aria-labelledby={modeLabel}
          className="flex rounded border border-slate-300 p-0.5"
        >
          {MODES.map(({ mode, label }) => (
            <label
              key={mode}
              className="cursor-pointer rounded px-3 py-0.5 has-checked:bg-slate-900 has-checked:text-white has-disabled:cursor-default has-disabled:opacity-50 has-focus-visible:ring-2 has-focus-visible:ring-slate-400"
            >
              <input
                type="radio"
                name="mode"
                value={mode}
                checked={settings?.mode === mode}
                disabled={blocked || busy || settings === undefined}
                onChange={() => chooseMode(mode)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-2">
          <span>このサイトは常に翻訳</span>
          <input
            type="checkbox"
            role="switch"
            checked={always}
            aria-checked={always}
            disabled={switchesOff}
            aria-describedby={byParent === undefined ? alwaysHint : parentNote}
            onChange={(event) => {
              if (switchesOff || known === undefined || settings === undefined) return;
              const on = event.target.checked;
              const { never } = settings;
              // Chrome asks for the site's permission during this click (setAlways).
              apply(
                () => port.setAlways(known, on, never),
                (error) =>
                  error.internalCode === 'host_permission_denied' ? TEXT.denied : TEXT.notSaved,
              );
            }}
            className="h-4 w-4 accent-slate-900"
          />
        </label>
        {byParent === undefined && (
          <p id={alwaysHint} className="text-xs text-slate-600">
            {/* Only the site's own entry goes: a parent domain's locks both switches instead. */}
            {excluded ? `${TEXT.clearsNever}${TEXT.askChrome}` : TEXT.askChrome}
          </p>
        )}
        <label className="flex items-center justify-between gap-2">
          <span>このサイトでは翻訳しない</span>
          <input
            type="checkbox"
            role="switch"
            checked={excluded}
            aria-checked={excluded}
            disabled={switchesOff}
            aria-describedby={byParent === undefined ? undefined : parentNote}
            onChange={(event) => {
              if (switchesOff || known === undefined) return;
              const on = event.target.checked;
              apply(
                () => port.setNever(known, on),
                () => TEXT.notSaved,
              );
            }}
            className="h-4 w-4 accent-slate-900"
          />
        </label>
        {byParent !== undefined && (
          <p id={parentNote} className="text-xs text-slate-600">
            <span>{byParentText(byParent)}</span>{' '}
            <a href="/options.html" onClick={openOptions} className="underline">
              設定ページで変える
            </a>
          </p>
        )}
      </div>
      <output aria-live="polite" className="flex flex-col gap-0.5 text-xs text-slate-700">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </output>
      <a
        href="/options.html"
        onClick={openOptions}
        className="self-end text-xs text-slate-600 underline"
      >
        設定
      </a>
    </main>
  );
}

/**
 * The lines the tab's progress adds: the count, the paragraph limit, the server's notice, and
 * what to check when not one paragraph could be translated though llama.cpp answers (a server
 * with one slot refuses the page's requests: `model_refused`).
 */
function progressLines(progress: Progress): string[] {
  const count = progressLine(progress);
  const none =
    count !== undefined &&
    progress.failed > 0 &&
    progress.done === 0 &&
    progress.notice !== 'unreachable';
  return [
    ...(count === undefined ? [] : [count]),
    ...(none ? [TEXT.parallel] : []),
    ...(progress.limit ? [TEXT.limit] : []),
    ...(progress.notice === 'unreachable' ? [TEXT.unreachable] : []),
    ...(progress.notice === 'plamo_missing' ? [TEXT.plamoMissing] : []),
  ];
}
