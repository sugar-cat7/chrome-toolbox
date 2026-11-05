import { useCallback, useEffect, useRef, useState } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import type { PanelPort } from '../../panel.ts';
import type { FeedbackVerdict, HiddenEntry } from '../../protocol.ts';
import type { StreamContext } from '../../stream-context.ts';
import { CATEGORY_NAMES } from '../../labels.ts';
import { clockTime, explain } from './text.ts';

type Rows =
  | { status: 'loading' }
  | { status: 'ready'; entries: HiddenEntry[] }
  | { status: 'failed'; code: string };

/** Saves `jsonl` as a file through a temporary link; the object URL is revoked right after. */
function download(doc: Document, jsonl: string, now: Date): void {
  const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/jsonl' }));
  const link = doc.createElement('a');
  link.href = url;
  // A local, sortable name: comment-feedback-20261028-123456.jsonl
  const stamp = now.toISOString().replace(/\D/gu, '').slice(0, 14);
  link.download = `comment-feedback-${stamp.slice(0, 8)}-${stamp.slice(8)}.jsonl`;
  doc.body.append(link);
  link.click();
  link.remove();
  // The click has started the download; the URL is not needed after this turn.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The stream's comments taken out of the chat (abusive, spam, spoiler and the genre categories:
 * removed or concealed as the filters say, R54, R62), newest first with the reason, to review: "問題なし" puts the comment
 * back in the chat and keeps such text visible for the streamer, "正しい" confirms it. The saved verdicts can be exported as JSONL or cleared (after a confirmation).
 * The list is read when the tab opens, after each verdict and on "更新"; there is no polling.
 */
export function HiddenTab({
  port,
  stream,
}: {
  port: PanelPort;
  stream: StreamContext | undefined;
}) {
  const [rows, setRows] = useState<Rows>({ status: 'loading' });
  /** Comment ids with a request in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  /** Only the newest list request's answer is shown. */
  const latest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = useCallback((): void => {
    if (stream === undefined) return;
    latest.current += 1;
    const request = latest.current;
    launch(
      async () => {
        const listed = await port.hidden(stream);
        if (!mounted.current || request !== latest.current) return;
        setRows(
          listed.ok
            ? { status: 'ready', entries: listed.value }
            : { status: 'failed', code: listed.error.internalCode },
        );
      },
      () => {
        if (mounted.current) setRows({ status: 'failed', code: 'unexpected_failure' });
      },
    );
  }, [port, stream]);
  // The panel remounts this tab for another stream: the list starts loading for each one.
  useEffect(() => {
    reload();
  }, [reload]);

  if (stream === undefined)
    return (
      <p className="text-slate-500">配信を開くと、チャットから外したコメントをここで見返せます。</p>
    );

  function settle(id: string): void {
    setBusy((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }
  function review(entry: HiddenEntry, verdict: FeedbackVerdict): void {
    setBusy((current) => new Set(current).add(entry.id));
    setNotice('');
    launch(
      async () => {
        const answered = await port.review(entry, verdict);
        if (!mounted.current) return;
        settle(entry.id);
        if (!answered.ok) {
          setNotice(explain(answered.error.internalCode));
          // Gone from the service worker's list (evicted, or a new pipeline): drop it here too.
          if (answered.error.internalCode === 'resource_missing') reload();
          return;
        }
        if (!answered.value.persisted)
          setNotice('判断はいまから反映しますが、まだ保存できていません。あとで保存します。');
        setRows((current) =>
          current.status !== 'ready'
            ? current
            : {
                status: 'ready',
                entries:
                  verdict === 'ok'
                    ? current.entries.filter((item) => item.id !== entry.id)
                    : current.entries.map((item) =>
                        item.id === entry.id ? { ...item, verdict } : item,
                      ),
              },
        );
        // "問題なし" also shows the other hidden copies of the text: the list is read again.
        if (verdict === 'ok') reload();
      },
      () => {
        if (!mounted.current) return;
        settle(entry.id);
        setNotice(explain('unexpected_failure'));
      },
    );
  }
  function exportFeedback(): void {
    setNotice('');
    launch(
      async () => {
        const exported = await port.exportFeedback();
        if (!mounted.current) return;
        if (!exported.ok) setNotice(explain(exported.error.internalCode));
        else if (exported.value === '') setNotice('書き出すフィードバックはまだありません。');
        else download(document, exported.value, new Date());
      },
      () => {
        if (mounted.current) setNotice(explain('unexpected_failure'));
      },
    );
  }
  function clearFeedback(): void {
    setConfirming(false);
    launch(
      async () => {
        const cleared = await port.clearFeedback();
        if (!mounted.current) return;
        setNotice(
          cleared.ok ? 'フィードバックを消去しました' : explain(cleared.error.internalCode),
        );
        // The confirmations are gone too: the list shows the comments as not judged yet.
        if (cleared.ok) reload();
      },
      () => {
        if (mounted.current) setNotice(explain('unexpected_failure'));
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">チャットから外したコメント（この配信）</h2>
          <p className="text-xs text-slate-500">
            攻撃的・スパム・ネタバレのほか、指示・他配信の話題・ゴースティング・プライバシー・センシティブと判定したコメントを、理由と時刻つきで新しい順に表示します（チャットと動画のコメントそれぞれ最新
            200 件）。「問題なし」でチャットに戻します。
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          className="shrink-0 rounded border border-slate-300 px-2 py-0.5"
        >
          更新
        </button>
      </div>
      {rows.status === 'loading' && <p className="text-slate-500">読み込んでいます…</p>}
      {rows.status === 'failed' && <p role="alert">{explain(rows.code)}</p>}
      {rows.status === 'ready' && rows.entries.length === 0 && (
        <p className="text-slate-500">チャットから外したコメントはありません。</p>
      )}
      {rows.status === 'ready' && rows.entries.length > 0 && (
        <ul aria-label="チャットから外したコメント" className="flex flex-col gap-2">
          {rows.entries.map((entry) => (
            <HiddenRow
              key={`${entry.channel}/${entry.id}`}
              entry={entry}
              busy={busy.has(entry.id)}
              onReview={(verdict) => review(entry, verdict)}
            />
          ))}
        </ul>
      )}
      <output aria-live="polite" className="text-xs text-slate-600">
        {notice}
      </output>
      <div className="flex flex-col gap-2 border-t border-slate-200 pt-2">
        <p className="text-xs text-slate-500">
          判断はこの端末の中だけに保存し、許可リストと訂正例、判定基準の調整に使います。
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportFeedback}
            className="rounded border border-slate-300 px-2 py-1"
          >
            書き出す（JSONL）
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded border border-red-300 px-2 py-1 text-red-700"
          >
            フィードバックを消去
          </button>
        </div>
        {confirming && (
          <div role="alertdialog" aria-label="フィードバックの消去" className="flex flex-col gap-2">
            <p>
              保存したフィードバック（許可リスト、訂正例、引き上げた判定基準）と、配信ごとに覚えたジャンル（選んだジャンルを含む）をすべて消去します。よろしいですか？
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearFeedback}
                className="rounded bg-red-700 px-2 py-1 text-white"
              >
                消去する
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-slate-300 px-2 py-1"
              >
                やめる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HiddenRow({
  entry,
  busy,
  onReview,
}: {
  entry: HiddenEntry;
  busy: boolean;
  onReview: (verdict: FeedbackVerdict) => void;
}) {
  return (
    <li className="flex flex-col gap-1 rounded border border-slate-200 p-2">
      <p data-field="text" className="break-all whitespace-pre-wrap">
        {entry.text}
      </p>
      {entry.translation !== undefined && (
        <p data-field="translation" className="break-all text-slate-600">
          {entry.translation}
        </p>
      )}
      <p className="flex flex-wrap gap-x-2 text-xs text-slate-500">
        <span>{CATEGORY_NAMES[entry.category]}</span>
        {entry.abusive !== undefined && <span>Clef {Math.round(entry.abusive * 100)}%</span>}
        <time dateTime={new Date(entry.at).toISOString()}>{clockTime(entry.at)}</time>
      </p>
      {entry.verdict === 'correct' ? (
        <p className="text-xs text-slate-500">確認済み</p>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onReview('ok')}
            className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50"
          >
            問題なし
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReview('correct')}
            className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50"
          >
            正しい
          </button>
        </div>
      )}
    </li>
  );
}
