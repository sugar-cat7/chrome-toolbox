import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Err, launch, type Result } from '@chrome-toolbox/contracts';
import { commentLimits } from '@chrome-toolbox/extension-core';
import type { PanelPort } from '../../panel.ts';
import { SUMMARY_WINDOWS, type Summary, type SummaryWindow } from '../../protocol.ts';
import type { StreamContext } from '../../stream-context.ts';
import {
  clockTime,
  explain,
  languageName,
  minuteTime,
  MODEL_FAILED,
  SUMMARY_HEADINGS,
  unprocessedNote,
  WINDOW_LABELS,
} from './text.ts';

const MINUTE = 60_000;
/** Auto refresh while the panel is visible (spec §7: every 2 minutes, R35). */
const SUMMARY_REFRESH_MS = 120_000;
/** Languages named in the footer; more are "ほか". */
const SHOWN_LANGUAGES = 4;
/** Width of the busiest minute's bar, in pixels. */
const BAR_PX = 96;

type View = Readonly<{
  summary: Summary | undefined;
  /** Error code of the latest failed request; the last summary stays. */
  error: string | undefined;
  loading: boolean;
}>;

/**
 * The summary tab (mock B): the stream's chat over the last 5, 15 or 30 minutes, asked for when
 * the tab opens, the window changes or "更新" is pressed. While "自動更新" is on and the panel is
 * visible, the panel asks again every 2 minutes (and at once when it comes back into view); the
 * timer is cleared when it is turned off, the panel is hidden or the tab closes (R35). A failure
 * keeps the last summary and says what went wrong.
 */
export function SummaryTab({
  port,
  stream,
}: {
  port: PanelPort;
  stream: StreamContext | undefined;
}) {
  const [windowMinutes, setWindowMinutes] = useState<SummaryWindow>(15);
  const [auto, setAuto] = useState(true);
  const [view, setView] = useState<View>({ summary: undefined, error: undefined, loading: true });
  const mounted = useRef(true);
  /** Only the newest request's answer is shown. */
  const latest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const show = useCallback((answer: Result<Summary>): void => {
    if (!mounted.current) return;
    setView((current) =>
      answer.ok
        ? { summary: answer.value, error: undefined, loading: false }
        : { ...current, error: answer.error.internalCode, loading: false },
    );
  }, []);
  /** Asks for the chosen window's summary; the caller shows that it is loading. */
  const request = useCallback((): void => {
    if (stream === undefined) return;
    latest.current += 1;
    const asked = latest.current;
    launch(
      async () => {
        const answer = await port.summary(stream, windowMinutes);
        if (asked === latest.current) show(answer);
      },
      (error) => show(Err(error)),
    );
  }, [port, stream, windowMinutes, show]);
  const refresh = useCallback((): void => {
    setView((current) => ({ ...current, loading: true }));
    request();
  }, [request]);
  // On open and for each window chosen (`choose` shows it loading).
  useEffect(() => {
    request();
  }, [request]);
  useEffect(() => {
    if (stream === undefined || !auto) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
      timer ??= setInterval(refresh, SUMMARY_REFRESH_MS);
    };
    const stop = (): void => {
      clearInterval(timer);
      timer = undefined;
    };
    function onVisibility(): void {
      if (document.visibilityState !== 'visible') {
        stop();
        return;
      }
      if (timer !== undefined) return;
      // Back in view: the summary may be minutes old.
      refresh();
      start();
    }
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [stream, auto, refresh]);

  function choose(minutes: SummaryWindow): void {
    if (minutes === windowMinutes) return;
    setWindowMinutes(minutes);
    setView((current) => ({ ...current, loading: true }));
  }

  if (stream === undefined)
    return (
      <p className="text-slate-500">
        配信を開くと、直近 5・15・30
        分のチャットの主な話題、よくある質問、盛り上がり、重要なコメントをここにまとめます。
      </p>
    );

  const { summary, error, loading } = view;
  const status = [
    ...(summary === undefined ? [] : [`最終更新 ${clockTime(summary.generatedAt)}`]),
    ...(loading ? [summary === undefined ? '要約しています…' : '更新中…'] : []),
  ].join(' · ');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="inline-flex items-center overflow-hidden rounded border border-slate-300">
          <legend className="sr-only">要約する期間</legend>
          <span className="px-2 py-0.5 text-xs text-slate-500">直近</span>
          {SUMMARY_WINDOWS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              aria-pressed={minutes === windowMinutes}
              onClick={() => choose(minutes)}
              className={`border-l border-slate-300 px-2 py-0.5 ${
                minutes === windowMinutes ? 'bg-blue-600 text-white' : 'text-slate-700'
              }`}
            >
              {WINDOW_LABELS[minutes]}
            </button>
          ))}
        </fieldset>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => setAuto(event.currentTarget.checked)}
          />
          自動更新（2分ごと）
        </label>
        <button
          type="button"
          onClick={refresh}
          className="ml-auto rounded border border-slate-300 px-2 py-0.5"
        >
          更新
        </button>
      </div>
      <p className="text-xs text-slate-500">{status}</p>
      {error !== undefined && <p role="alert">{explain(error)}</p>}
      {summary !== undefined &&
        (summary.total === 0 ? (
          <p className="text-slate-500">この期間のコメントはまだありません。</p>
        ) : (
          <SummaryBody summary={summary} />
        ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function SummaryBody({ summary }: { summary: Summary }) {
  const busiest = Math.max(1, ...summary.peaks.map((peak) => peak.count));
  // The store keeps 5,000 comments: when full, the oldest one may be newer than the window.
  const covered = Math.ceil((summary.generatedAt - summary.from) / MINUTE);
  const cut = summary.total >= commentLimits.store.maxItems && covered < summary.windowMinutes;
  const languages = [
    summary.languages.slice(0, SHOWN_LANGUAGES).map(languageName).join('・'),
    ...(summary.languages.length > SHOWN_LANGUAGES ? ['ほか'] : []),
  ].join(' ');
  return (
    <>
      {(summary.topics.length > 0 || summary.modelFailed === true) && (
        <Section title={SUMMARY_HEADINGS.topics}>
          {summary.modelFailed === true ? (
            <p className="text-slate-500">{MODEL_FAILED}</p>
          ) : (
            <ul className="list-inside list-disc">
              {summary.topics.map((topic) => (
                <li key={topic}>{topic}</li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {summary.questions.length > 0 && (
        <Section title={SUMMARY_HEADINGS.questions}>
          <ul className="list-inside list-disc">
            {summary.questions.map((question) => (
              <li key={question.text}>
                <span className="break-all">{question.text}</span>{' '}
                <span className="text-xs text-slate-500">×{question.count}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.peaks.length > 0 && (
        <Section title={SUMMARY_HEADINGS.peaks}>
          <ul className="flex flex-col gap-1">
            {summary.peaks.map((peak) => (
              <li key={peak.minute} className="flex items-center gap-2">
                <time dateTime={new Date(peak.minute).toISOString()} className="tabular-nums">
                  {minuteTime(peak.minute)}
                </time>
                <span
                  aria-hidden="true"
                  className="h-2 shrink-0 rounded bg-blue-400"
                  style={{ width: `${Math.max(4, Math.round((peak.count / busiest) * BAR_PX))}px` }}
                />
                {peak.label !== undefined && <span className="break-all">{peak.label}</span>}
                <span className="text-xs text-slate-500">{peak.count}件</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.important.length > 0 && (
        <Section title={SUMMARY_HEADINGS.important}>
          <ul className="flex flex-col gap-1">
            {summary.important.map((item) => (
              <li key={item.text} className="break-all">
                <span className="font-medium">{item.author}</span>：<span>{item.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="text-xs text-slate-500">
        対象 {summary.total.toLocaleString('ja-JP')}件{cut ? `（直近 ${covered} 分ぶん）` : ''}
        {languages === '' ? '' : ` · ${languages} → 日本語`}
      </p>
      {summary.unprocessed > 0 && (
        <p className="text-xs text-slate-500">{unprocessedNote(summary.unprocessed)}</p>
      )}
    </>
  );
}
