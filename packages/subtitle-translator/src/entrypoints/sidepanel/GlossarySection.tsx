import { useEffect, useRef, useState } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import { GLOSSARY_LIMITS, type GlossaryEntry, type GlossaryStore } from '../../glossary.ts';
import { GLOSSARY_FULL, GLOSSARY_UNKNOWN, KEEP_SOURCE, explain } from './text.ts';

type Entries = { status: 'loading' } | { status: 'ready'; entries: GlossaryEntry[] };

/**
 * The glossary of the shown tab's streamer (`streamer` is its key, `name` its heading): pairs of a
 * source and a translation, an empty translation keeping the source as it is. At most 50; the 51st
 * is refused. Each change is saved at once. Without a known streamer it cannot be edited. The panel
 * makes it again for another streamer.
 */
export function GlossarySection({
  glossary,
  streamer,
  name,
}: {
  glossary: GlossaryStore;
  streamer: string | undefined;
  name: string | undefined;
}) {
  const [entries, setEntries] = useState<Entries>({ status: 'loading' });
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (streamer !== undefined)
      launch(
        async () => {
          const loaded = await glossary.load(streamer);
          if (!mounted.current) return;
          if (loaded.ok) setEntries({ status: 'ready', entries: loaded.value });
          else setNote(explain(loaded.error.internalCode));
        },
        () => {
          if (mounted.current) setNote(explain('unexpected_failure'));
        },
      );
    return () => {
      mounted.current = false;
    };
  }, [glossary, streamer]);

  /** Saves `next` for the streamer; the list shows what was saved. */
  function save(next: GlossaryEntry[], saved: () => void): void {
    if (streamer === undefined) return;
    setBusy(true);
    setNote('');
    launch(
      async () => {
        const written = await glossary.save(streamer, next);
        if (!mounted.current) return;
        setBusy(false);
        if (!written.ok) {
          setNote(explain(written.error.internalCode));
          return;
        }
        setEntries({ status: 'ready', entries: written.value });
        saved();
      },
      () => {
        if (!mounted.current) return;
        setBusy(false);
        setNote(explain('unexpected_failure'));
      },
    );
  }

  const usable = streamer !== undefined && entries.status === 'ready';
  const listed = entries.status === 'ready' ? entries.entries : [];
  return (
    <section aria-label="用語集" className="flex flex-col gap-2 px-4">
      <h2 className="font-medium">用語集</h2>
      {streamer === undefined ? (
        <p className="text-slate-500">{GLOSSARY_UNKNOWN}</p>
      ) : (
        <h3 className="font-medium break-all">{name ?? streamer}</h3>
      )}
      {listed.length > 0 && (
        <ul aria-label="用語集の項目" className="flex flex-col gap-0.5">
          {listed.map((entry) => (
            <li key={entry.source} className="flex items-center justify-between gap-2">
              <span className="break-all">
                <span>{entry.source}</span>
                {' → '}
                <span className={entry.target === '' ? 'text-slate-500' : ''}>
                  {entry.target === '' ? KEEP_SOURCE : entry.target}
                </span>
              </span>
              <button
                type="button"
                aria-label={`${entry.source} を削除`}
                disabled={busy}
                onClick={() =>
                  save(
                    listed.filter((kept) => kept.source !== entry.source),
                    () => undefined,
                  )
                }
                className="rounded border px-2 py-0.5 text-xs"
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const term = source.trim();
          if (term === '') return;
          // An entry with the same source is replaced, so it does not count toward the limit.
          const next = [
            ...listed.filter((kept) => kept.source !== term),
            { source: term, target: target.trim() },
          ];
          if (next.length > GLOSSARY_LIMITS.entries) {
            setNote(GLOSSARY_FULL);
            return;
          }
          save(next, () => {
            setSource('');
            setTarget('');
          });
        }}
      >
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-0.5">
            <span>原文</span>
            <input
              value={source}
              disabled={!usable || busy}
              required
              maxLength={GLOSSARY_LIMITS.chars}
              onChange={(event) => setSource(event.target.value)}
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span>訳</span>
            <input
              value={target}
              disabled={!usable || busy}
              maxLength={GLOSSARY_LIMITS.chars}
              placeholder={`空なら${KEEP_SOURCE}`}
              onChange={(event) => setTarget(event.target.value)}
              className="rounded border px-2 py-1"
            />
          </label>
          <button
            type="submit"
            disabled={!usable || busy}
            className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
          >
            追加
          </button>
        </div>
      </form>
      <output aria-live="polite" className="text-xs text-slate-600">
        {note}
      </output>
    </section>
  );
}
