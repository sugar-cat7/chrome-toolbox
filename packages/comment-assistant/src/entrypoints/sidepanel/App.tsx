import { useEffect, useState, type KeyboardEvent } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import type { PanelPort, ShownStream } from '../../panel.ts';
import { FilterTab } from './FilterTab.tsx';
import { HiddenTab } from './HiddenTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { SummaryTab } from './SummaryTab.tsx';

/**
 * The panel's two views: かんたん needs no configuration (the summary, the filter strength and
 * the translation switches) and 詳細設定 keeps everything else — the per-category modes, the
 * hidden comments to review and the connection settings. The hidden list sits in 詳細設定: it
 * is a review of what the filters removed, not part of daily use.
 */
type ViewId = 'simple' | 'advanced';
const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: 'simple', label: 'かんたん' },
  { id: 'advanced', label: '詳細設定' },
];
type AdvancedId = 'filters' | 'hidden' | 'settings';
const ADVANCED_TABS: readonly { id: AdvancedId; label: string }[] = [
  { id: 'filters', label: 'フィルター' },
  { id: 'hidden', label: '非表示' },
  { id: 'settings', label: '設定' },
];

type StreamState =
  | { status: 'loading' }
  | { status: 'ready'; shown: ShownStream | undefined }
  | { status: 'failed' };

/**
 * The same stream and genre as before (asked again after a tab or page event): keep the old
 * object.
 */
const sameStream = (a: ShownStream | undefined, b: ShownStream | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

type TabSpec<T extends string> = Readonly<{ id: T; label: string }>;
/**
 * One tablist of the panel (WAI-ARIA tabs pattern): the selected tab is the only one in the
 * tab order, and ArrowLeft/ArrowRight move the selection and the focus.
 */
function TabBar<T extends string>({
  label,
  tabs,
  active,
  onSelect,
}: {
  label: string;
  tabs: readonly TabSpec<T>[];
  active: T;
  onSelect: (id: T) => void;
}) {
  /** Arrow keys move between the tabs of this list. */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    onSelect(next.id);
    event.currentTarget.ownerDocument.getElementById(`tab-${next.id}`)?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className="flex border-b border-slate-200">
      {tabs.map((item, index) => (
        <button
          key={item.id}
          id={`tab-${item.id}`}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          aria-controls={`panel-${item.id}`}
          tabIndex={active === item.id ? 0 : -1}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => onTabKey(event, index)}
          className={`flex-1 py-2 text-center ${
            active === item.id
              ? 'border-b-2 border-blue-600 font-semibold text-slate-900'
              : 'text-slate-500'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The side panel (mock B): the active tab's stream, and the かんたん view (summary, filter
 * strength, translation switches) beside the 詳細設定 view (per-category filters, hidden
 * comments, settings). Only the open views are rendered. The stream is asked for on open and
 * again when another tab is activated, the tab finishes loading or a page reports its stream;
 * there is no polling, and every listener goes when the panel is closed.
 */
export function App({ port }: { port: PanelPort }) {
  const [view, setView] = useState<ViewId>('simple');
  const [advanced, setAdvanced] = useState<AdvancedId>('filters');
  const [state, setState] = useState<StreamState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    /** Only the newest request's answer is shown. */
    let latest = 0;
    function refresh(): void {
      latest += 1;
      const request = latest;
      launch(
        async () => {
          const found = await port.stream();
          if (!current || request !== latest) return;
          if (!found.ok) {
            setState({ status: 'failed' });
            return;
          }
          setState((previous) =>
            previous.status === 'ready' && sameStream(previous.shown, found.value)
              ? previous
              : { status: 'ready', shown: found.value },
          );
        },
        () => {
          if (current) setState({ status: 'failed' });
        },
      );
    }
    refresh();
    const stop = port.watch(refresh);
    return () => {
      current = false;
      stop();
    };
  }, [port]);

  const shown = state.status === 'ready' ? state.shown : undefined;
  const stream = shown?.stream;
  // Each view starts afresh for another stream (or streamer): no state of the previous one.
  const streamKey =
    stream === undefined
      ? 'none'
      : JSON.stringify([stream.site, stream.partition, stream.streamer]);
  // A summary belongs to the stream's chat: learning its streamer later keeps the tab as it is.
  const chatKey = stream === undefined ? 'none' : JSON.stringify([stream.site, stream.partition]);

  return (
    <main className="flex min-h-screen flex-col bg-white text-sm text-slate-900">
      <header className="border-b border-slate-200 px-3 py-2">
        <h1 className="text-base font-semibold">コメントアシスタント</h1>
        <StreamLine state={state} />
      </header>
      <TabBar label="コメントアシスタントの表示" tabs={VIEWS} active={view} onSelect={setView} />
      {view === 'simple' ? (
        <section
          role="tabpanel"
          id="panel-simple"
          aria-labelledby="tab-simple"
          className="flex flex-col gap-3 p-3"
        >
          <SummaryTab key={`summary:${chatKey}`} port={port} stream={stream} />
          <FilterTab
            key={`filters:${streamKey}`}
            port={port}
            stream={stream}
            genre={shown?.genre}
            simple
          />
        </section>
      ) : (
        <section
          role="tabpanel"
          id="panel-advanced"
          aria-labelledby="tab-advanced"
          className="flex flex-col gap-3 p-3"
        >
          <TabBar label="詳細設定" tabs={ADVANCED_TABS} active={advanced} onSelect={setAdvanced} />
          {advanced === 'filters' && (
            <section
              role="tabpanel"
              id="panel-filters"
              aria-labelledby="tab-filters"
              className="flex flex-col gap-3"
            >
              <FilterTab key={streamKey} port={port} stream={stream} genre={shown?.genre} />
            </section>
          )}
          {advanced === 'hidden' && (
            <section
              role="tabpanel"
              id="panel-hidden"
              aria-labelledby="tab-hidden"
              className="flex flex-col gap-3"
            >
              <HiddenTab key={streamKey} port={port} stream={stream} />
            </section>
          )}
          {advanced === 'settings' && (
            <section
              role="tabpanel"
              id="panel-settings"
              aria-labelledby="tab-settings"
              className="flex flex-col gap-3"
            >
              <SettingsTab key={streamKey} port={port} stream={stream} />
            </section>
          )}
        </section>
      )}
    </main>
  );
}

function StreamLine({ state }: { state: StreamState }) {
  if (state.status === 'loading') return <p className="text-slate-500">配信を確認しています…</p>;
  if (state.status === 'failed')
    return <p className="text-slate-500">このタブの配信を確認できませんでした。</p>;
  const stream = state.shown?.stream;
  if (stream === undefined) return <p className="text-slate-500">このタブには配信がありません</p>;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium break-all">{stream.title ?? stream.partition}</span>
      {stream.streamer !== undefined && (
        <span className="text-xs text-slate-500 break-all">{stream.streamer}</span>
      )}
    </p>
  );
}
