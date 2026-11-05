import { useEffect, useState, type KeyboardEvent } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import type { PanelPort } from '../../panel.ts';
import type { StreamContext } from '../../stream-context.ts';
import { FilterTab } from './FilterTab.tsx';
import { HiddenTab } from './HiddenTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { SummaryTab } from './SummaryTab.tsx';

const TABS = [
  { id: 'summary', label: '要約' },
  { id: 'filters', label: 'フィルター' },
  { id: 'hidden', label: '非表示' },
  { id: 'settings', label: '設定' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type StreamState =
  | { status: 'loading' }
  | { status: 'ready'; stream: StreamContext | undefined }
  | { status: 'failed' };

/** The same stream as before (asked again after a tab or page event): keep the old object. */
const sameStream = (a: StreamContext | undefined, b: StreamContext | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The side panel (mock B): the active tab's stream, and the summary, filter, hidden-comment and
 * settings tabs. Only the open tab is rendered. The stream is asked for on open and again when
 * another tab is activated, the tab finishes loading or a page reports its stream; there is no
 * polling, and every listener goes when the panel is closed.
 */
export function App({ port }: { port: PanelPort }) {
  const [tab, setTab] = useState<TabId>('summary');
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
            previous.status === 'ready' && sameStream(previous.stream, found.value)
              ? previous
              : { status: 'ready', stream: found.value },
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

  const stream = state.status === 'ready' ? state.stream : undefined;
  // Each tab starts afresh for another stream (or streamer): no state of the previous one.
  const streamKey =
    stream === undefined
      ? 'none'
      : JSON.stringify([stream.site, stream.partition, stream.streamer]);
  // A summary belongs to the stream's chat: learning its streamer later keeps the tab as it is.
  const chatKey = stream === undefined ? 'none' : JSON.stringify([stream.site, stream.partition]);
  /** Arrow keys move between the tabs (WAI-ARIA tabs pattern). */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (next === undefined) return;
    setTab(next.id);
    event.currentTarget.ownerDocument.getElementById(`tab-${next.id}`)?.focus();
  }

  return (
    <main className="flex min-h-screen flex-col bg-white text-sm text-slate-900">
      <header className="border-b border-slate-200 px-3 py-2">
        <h1 className="text-base font-semibold">コメントアシスタント</h1>
        <StreamLine state={state} />
      </header>
      <div
        role="tablist"
        aria-label="コメントアシスタントの表示"
        className="flex border-b border-slate-200"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={onTabKey}
            className={`flex-1 py-2 text-center ${
              tab === item.id
                ? 'border-b-2 border-blue-600 font-semibold text-slate-900'
                : 'text-slate-500'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="flex flex-col gap-3 p-3"
      >
        {tab === 'summary' && <SummaryTab key={chatKey} port={port} stream={stream} />}
        {tab === 'filters' && <FilterTab key={streamKey} port={port} stream={stream} />}
        {tab === 'hidden' && <HiddenTab key={streamKey} port={port} stream={stream} />}
        {tab === 'settings' && <SettingsTab key={streamKey} port={port} stream={stream} />}
      </section>
    </main>
  );
}

function StreamLine({ state }: { state: StreamState }) {
  if (state.status === 'loading') return <p className="text-slate-500">配信を確認しています…</p>;
  if (state.status === 'failed')
    return <p className="text-slate-500">このタブの配信を確認できませんでした。</p>;
  const { stream } = state;
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
