import { useEffect, useRef, useState } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import type { Settings } from '@chrome-toolbox/extension-core';
import { ConnectionPanel } from '@chrome-toolbox/ui';
import type { PanelPort } from '../../panel.ts';
import type { CommentStats } from '../../protocol.ts';
import type { StreamContext } from '../../stream-context.ts';
import { explain } from './text.ts';

type Judge =
  | { status: 'loading' }
  | { status: 'ready'; stats: CommentStats }
  | { status: 'failed'; code: string };

/**
 * The llama.cpp connection (the shared `ConnectionPanel`), the model names sent to a router
 * (translation, Clef), which judge decides abuse for the stream (stats' `judge`) and the
 * stream's processing counters (R53). The stats are asked for when the tab opens and when
 * "更新" is pressed; nothing polls.
 */
export function SettingsTab({
  port,
  stream,
}: {
  port: PanelPort;
  stream: StreamContext | undefined;
}) {
  const [settings, setSettings] = useState<Settings | undefined>();
  const [translate, setTranslate] = useState('');
  const [clef, setClef] = useState('');
  const [saved, setSaved] = useState('');
  // The panel remounts this tab for another stream: the judge is asked again for each one.
  const [judge, setJudge] = useState<Judge>({ status: 'loading' });
  /** Bumped by "更新": the stats are asked for again. */
  const [asked, setAsked] = useState(0);
  const mounted = useRef(true);
  /** Fields the viewer has typed in: the saved names, read afterwards, must not replace them. */
  const edited = useRef({ translate: false, clef: false });

  useEffect(() => {
    mounted.current = true;
    launch(
      async () => {
        const loaded = await port.settings.load();
        if (!mounted.current) return;
        if (!loaded.ok) {
          setSaved(explain(loaded.error.internalCode));
          return;
        }
        setSettings(loaded.value);
        if (!edited.current.translate) setTranslate(loaded.value.models.translate);
        if (!edited.current.clef) setClef(loaded.value.models.clef);
      },
      () => {
        if (mounted.current) setSaved(explain('unexpected_failure'));
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [port]);
  useEffect(() => {
    if (stream === undefined) return undefined;
    let current = true;
    launch(
      async () => {
        const stats = await port.stats(stream);
        if (!current) return;
        setJudge(
          stats.ok
            ? { status: 'ready', stats: stats.value }
            : { status: 'failed', code: stats.error.internalCode },
        );
      },
      () => {
        if (current) setJudge({ status: 'failed', code: 'unexpected_failure' });
      },
    );
    return () => {
      current = false;
    };
  }, [port, stream, asked]);

  return (
    <div className="flex flex-col gap-3">
      <ConnectionPanel title="llama.cpp の接続" adapter={port.connection} />
      <form
        className="flex flex-col gap-2 px-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (settings === undefined) return;
          launch(
            async () => {
              // Read again first: the connection check may have saved a new URL meanwhile.
              const current = await port.settings.load();
              const base = current.ok ? current.value : settings;
              const written = await port.settings.save({
                ...base,
                models: { ...base.models, translate: translate.trim(), clef: clef.trim() },
              });
              if (!mounted.current) return;
              if (written.ok) setSettings(written.value);
              setSaved(written.ok ? 'モデル名を保存しました' : explain(written.error.internalCode));
            },
            () => {
              if (mounted.current) setSaved(explain('unexpected_failure'));
            },
          );
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium">翻訳モデル</span>
          <input
            name="translate"
            required
            value={translate}
            onChange={(event) => {
              edited.current.translate = true;
              setTranslate(event.target.value);
            }}
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Clef モデル</span>
          <input
            name="clef"
            required
            value={clef}
            onChange={(event) => {
              edited.current.clef = true;
              setClef(event.target.value);
            }}
            className="rounded border px-2 py-1"
          />
        </label>
        <button
          type="submit"
          disabled={settings === undefined}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          モデル名を保存
        </button>
        <output aria-live="polite" className="text-xs text-slate-600">
          {saved}
        </output>
      </form>
      <section aria-label="有害判定" className="flex flex-col gap-1 px-4">
        <h2 className="font-medium">有害判定</h2>
        {stream === undefined ? (
          <p className="text-slate-500">配信を開くと、判定の方式を表示します。</p>
        ) : (
          <JudgeStatus judge={judge} />
        )}
      </section>
      <section aria-label="処理の状況" className="flex flex-col gap-1 px-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">処理の状況</h2>
          {stream !== undefined && (
            <button
              type="button"
              onClick={() => setAsked((count) => count + 1)}
              className="rounded border px-2 py-0.5 text-xs"
            >
              更新
            </button>
          )}
        </div>
        {stream === undefined ? (
          <p className="text-slate-500">配信を開くと、処理の状況を表示します。</p>
        ) : judge.status === 'ready' ? (
          <Counters stats={judge.stats} />
        ) : (
          <p className="text-slate-500">
            {judge.status === 'loading' ? '確認しています…' : explain(judge.code)}
          </p>
        )}
      </section>
    </div>
  );
}

/** Seconds with one decimal, as the counters show a latency. */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} 秒`;

/**
 * The stream's processing counters (R53): comments waiting for the model, shown in the original
 * because they could not be processed in time (expired or dropped), stored while the chat was
 * not in front, not stored for want of room (only when there were some, R55), and the median
 * time from arrival to the first annotation of the comments that waited for the model.
 */
function Counters({ stats }: { stats: CommentStats }) {
  const rows: readonly (readonly [string, string])[] = [
    ['処理待ち', `${stats.pending} 件`],
    ['原文のまま（処理しきれず）', `${stats.expired + stats.dropped} 件`],
    ['画面外で未処理', `${stats.stored} 件`],
    ...(stats.unstored > 0 ? [['保存できず', `${stats.unstored} 件`] as const] : []),
    [
      '応答の中央値',
      stats.latencyP50Ms === undefined ? 'まだありません' : seconds(stats.latencyP50Ms),
    ],
  ];
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-slate-600">{name}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JudgeStatus({ judge }: { judge: Judge }) {
  switch (judge.status) {
    case 'loading':
      return <p className="text-slate-500">確認しています…</p>;
    case 'failed':
      return <p>{explain(judge.code)}</p>;
    case 'ready': {
      const { stats } = judge;
      return (
        <div className="flex flex-col gap-1">
          <p>
            {stats.judge === 'clef'
              ? 'Clef で判定しています'
              : 'Clef が使えないため、翻訳モデルの分類で判定しています'}
          </p>
          {/* Once Clef proved unavailable, the line above says why. */}
          {stats.judgeError !== undefined && stats.judge === 'clef' && (
            <p className="text-xs text-slate-600">
              Clef の直近の判定に失敗しました。{explain(stats.judgeError)}
            </p>
          )}
          {stats.lastError !== undefined && (
            <p className="text-xs text-slate-600">{explain(stats.lastError)}</p>
          )}
          {stats.feedbackError !== undefined && (
            <p className="text-xs text-slate-600">
              保存済みのフィードバックを読めませんでした。この間の判断は、読めたときに保存します。
            </p>
          )}
        </div>
      );
    }
  }
}
