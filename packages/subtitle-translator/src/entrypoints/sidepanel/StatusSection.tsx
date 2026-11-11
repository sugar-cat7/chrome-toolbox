import type { TabState } from '../../protocol.ts';
import { SOURCE_NAMES, STOP_REASONS, explain, languageName, seconds } from './text.ts';

/** The shown tab's state as the panel last got it. */
export type TabView =
  | { status: 'loading' }
  | { status: 'ready'; tab: TabState | undefined }
  | { status: 'failed'; code: string };

/** Whether the shown tab processes its subtitles, or why not (R44). */
function processing(tab: TabState): string {
  const { state, reason } = tab.front;
  if (state === 'active') return '処理しています';
  return reason === undefined ? '止まっています' : `止まっています（${STOP_REASONS[reason]}）`;
}

/** The rows of the shown tab: its source, and on the audio path the language, latency and counts. */
function rows(tab: TabState): (readonly [string, string])[] {
  const stats = tab.session?.stats;
  return [
    ['字幕の取得元', SOURCE_NAMES[tab.source]],
    ...(stats === undefined
      ? []
      : [
          [
            '言語',
            stats.lang === undefined ? 'まだ分かりません' : languageName(stats.lang),
          ] as const,
          ['原語の応答（p50）', seconds(stats.sourceP50Ms)] as const,
          [
            '日本語の応答（p50 / p95）',
            stats.jaP50Ms === undefined
              ? seconds(undefined)
              : `${seconds(stats.jaP50Ms)} / ${seconds(stats.jaP95Ms)}`,
          ] as const,
          ['処理しきれず', `${stats.dropped + stats.expired} 件`] as const,
          ['無音', `${stats.silent} 件`] as const,
        ]),
    ...(tab.page === undefined ? [] : [['処理', processing(tab)] as const]),
  ];
}

/**
 * The shown tab's state: where its subtitles come from, and for its captured audio the spoken
 * language, the latency (source p50, Japanese p50 / p95 over the last 200), the segments it could
 * not process in time (dropped and expired) and the silent ones; and why it is not processed. It is
 * asked on open, on a tab change and on 更新 only.
 */
export function StatusSection({ view, onRefresh }: { view: TabView; onRefresh: () => void }) {
  return (
    <section aria-label="状態" className="flex flex-col gap-1 px-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">状態</h2>
        <button type="button" onClick={onRefresh} className="rounded border px-2 py-0.5 text-xs">
          更新
        </button>
      </div>
      {view.status === 'loading' && <p className="text-slate-500">確認しています…</p>}
      {view.status === 'failed' && <p>{explain(view.code)}</p>}
      {view.status === 'ready' && view.tab === undefined && (
        <p className="text-slate-500">このウィンドウには開いているタブがありません</p>
      )}
      {view.status === 'ready' && view.tab !== undefined && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
          {rows(view.tab).map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-slate-600">{name}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
