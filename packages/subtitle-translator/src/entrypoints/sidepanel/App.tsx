import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { launch, type Result } from '@chrome-toolbox/contracts';
import type { PanelPort } from '../../panel.ts';
import type { SubtitleSettings } from '../../settings.ts';
import {
  AudioSection,
  LanguageSection,
  SourceSection,
  type CapabilityView,
} from './AudioSection.tsx';
import { DisplaySection } from './DisplaySection.tsx';
import { GlossarySection } from './GlossarySection.tsx';
import { PositionSection } from './PositionSection.tsx';
import { ServerSection } from './ServerSection.tsx';
import { StatusSection, type TabView } from './StatusSection.tsx';
import { NO_VIDEO, explain } from './text.ts';
import { TranslatorSection } from './TranslatorSection.tsx';

/** A subtitle setting the panel changes, and why its change failed. */
type Field = 'display' | 'source' | 'sourceLang' | 'translator' | 'position';
type Failure = Readonly<{ field: Field; message: string }>;

const TABS = [
  { id: 'simple', label: 'かんたん' },
  { id: 'details', label: '詳細設定' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * The side panel: the shown tab's state (asked on open, when another tab becomes active, the shown
 * tab finishes loading or the service worker says a state changed, and on 更新; no polling), the
 * display, speech, source, spoken language, position, translator, glossary and connection
 * settings. かんたん shows what a viewer needs; 詳細設定 the rest. The subtitle settings follow
 * every change saved anywhere; a change made here saves only its own field. Every listener goes
 * when the panel closes.
 */
export function App({ port }: { port: PanelPort }) {
  const [view, setView] = useState<TabView>({ status: 'loading' });
  const [capability, setCapability] = useState<CapabilityView>({ status: 'loading' });
  const [settings, setSettings] = useState<SubtitleSettings | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [tabId, setTabId] = useState<TabId>('simple');
  const mounted = useRef(true);
  /** Only the newest answer of each kind is shown. */
  const latest = useRef({ tab: 0, capability: 0 });

  const refresh = useCallback((): void => {
    latest.current.tab += 1;
    const request = latest.current.tab;
    launch(
      async () => {
        const found = await port.tabState();
        if (!mounted.current || request !== latest.current.tab) return;
        setView(
          found.ok
            ? { status: 'ready', tab: found.value }
            : { status: 'failed', code: found.error.internalCode },
        );
      },
      () => {
        if (mounted.current) setView({ status: 'failed', code: 'unexpected_failure' });
      },
    );
  }, [port]);
  const check = useCallback((): void => {
    latest.current.capability += 1;
    const request = latest.current.capability;
    launch(
      async () => {
        const found = await port.capability();
        if (!mounted.current || request !== latest.current.capability) return;
        setCapability(
          found.ok ? { status: 'ready', capability: found.value } : { status: 'failed' },
        );
      },
      () => {
        if (mounted.current) setCapability({ status: 'failed' });
      },
    );
  }, [port]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    check();
    const stopWatching = port.watch(refresh);
    // The saved settings are shown from the first read on; later changes replace them.
    const stopFollowing = port.followSubtitles(setSettings);
    launch(
      async () => {
        const loaded = await port.subtitles.load();
        if (!mounted.current) return;
        if (loaded.ok) setSettings((shown) => shown ?? loaded.value);
        else setFailure({ field: 'display', message: explain(loaded.error.internalCode) });
      },
      () => undefined,
    );
    return () => {
      mounted.current = false;
      stopWatching();
      stopFollowing();
    };
  }, [port, refresh, check]);

  /** Shows the viewer's choice at once and saves it; a failure is told under its field. */
  function choose(
    field: Field,
    shown: Partial<SubtitleSettings>,
    save: () => Promise<Result<void>>,
  ) {
    setFailure(undefined);
    setSettings((current) => (current === undefined ? current : { ...current, ...shown }));
    launch(
      async () => {
        const saved = await save();
        if (mounted.current && !saved.ok)
          setFailure({ field, message: explain(saved.error.internalCode) });
      },
      () => {
        if (mounted.current) setFailure({ field, message: explain('unexpected_failure') });
      },
    );
  }
  const failed = (field: Field): string | undefined =>
    failure?.field === field ? failure.message : undefined;

  /** Arrow keys move between the tabs (WAI-ARIA tabs pattern). */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tabId);
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (next === undefined) return;
    setTabId(next.id);
    event.currentTarget.ownerDocument.getElementById(`tab-${next.id}`)?.focus();
  }

  const tab = view.status === 'ready' ? view.tab : undefined;
  const page = tab?.page;
  const plamoListed = capability.status === 'ready' ? capability.capability.plamo : undefined;
  // On the audio path the offscreen document translates; elsewhere the service worker.
  const translator = tab?.session?.translator ?? tab?.translator;

  return (
    <main className="flex min-h-screen flex-col gap-2 bg-white pb-4 text-sm text-slate-900">
      <header className="border-b border-slate-200 px-4 py-2">
        <h1 className="text-base font-semibold">配信字幕翻訳</h1>
        {view.status === 'ready' &&
          (page === undefined ? (
            <p className="text-slate-500">{NO_VIDEO}</p>
          ) : (
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium break-all">{page.title ?? page.videoId}</span>
              {page.author !== undefined && (
                <span className="text-xs text-slate-500 break-all">{page.author}</span>
              )}
            </p>
          ))}
      </header>
      <div
        role="tablist"
        aria-label="配信字幕翻訳の表示"
        className="flex border-b border-slate-200"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tabId === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tabId === item.id ? 0 : -1}
            onClick={() => setTabId(item.id)}
            onKeyDown={onTabKey}
            className={`flex-1 py-2 text-center ${
              tabId === item.id
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
        id={`panel-${tabId}`}
        aria-labelledby={`tab-${tabId}`}
        className="flex flex-col gap-2"
      >
        {tabId === 'simple' && (
          <>
            <StatusSection
              view={view}
              onRefresh={() => {
                refresh();
                check();
              }}
            />
            <DisplaySection
              mode={settings?.display}
              failure={failed('display')}
              onChange={(mode) => choose('display', { display: mode }, () => port.display(mode))}
            />
            <AudioSection
              tab={tab}
              capability={capability}
              onStop={async (): Promise<Result<void>> => {
                const stopped = await port.stopAudio();
                if (mounted.current) refresh();
                return stopped;
              }}
            />
            <SourceSection
              source={settings?.source}
              failure={failed('source')}
              onChange={(source) =>
                choose('source', { source }, () => port.saveSubtitles({ source }))
              }
            />
            <LanguageSection
              sourceLang={settings?.sourceLang}
              failure={failed('sourceLang')}
              onChange={(sourceLang) =>
                choose('sourceLang', { sourceLang }, () => port.saveSubtitles({ sourceLang }))
              }
            />
          </>
        )}
        {tabId === 'details' && (
          <>
            <TranslatorSection
              chosen={settings?.translator}
              status={translator}
              plamoListed={plamoListed}
              failure={failed('translator')}
              onChange={(chosen) =>
                choose('translator', { translator: chosen }, () =>
                  port.saveSubtitles({ translator: chosen }),
                )
              }
            />
            {/* Another streamer starts afresh: no entry or typing of the previous one. */}
            <GlossarySection
              key={page?.streamer ?? 'none'}
              glossary={port.glossary}
              streamer={page?.streamer}
              name={page?.author ?? page?.streamer}
            />
            <ServerSection port={port} />
            <PositionSection
              position={settings?.position}
              failure={failed('position')}
              onChange={(position) =>
                choose('position', { position }, () => port.saveSubtitles({ position }))
              }
            />
          </>
        )}
      </section>
    </main>
  );
}
