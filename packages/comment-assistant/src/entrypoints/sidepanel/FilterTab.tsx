import { useEffect, useId, useRef, useState } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import {
  isStreamCategory,
  STREAM_GENRES,
  type CommentCategory,
  type StreamGenre,
} from '@chrome-toolbox/extension-core';
import {
  defaultFilterSettings,
  MAX_SPOILER_NOTE,
  defaultModeOf,
  type FilterMode,
  type FilterSettings,
} from '../../filters.ts';
import type { PanelPort } from '../../panel.ts';
import type { GenreView } from '../../protocol.ts';
import { ownerOf, type StreamContext } from '../../stream-context.ts';
import {
  explain,
  FILTER_CATEGORIES,
  filterLabel,
  GENRE_LABELS,
  GENRE_REASON_LABELS,
  HOLD_LABEL,
  MODE_LABELS,
} from './text.ts';

/** The select value of the default option: no mode chosen. */
const DEFAULT_MODE = '';
const MODES: readonly FilterMode[] = ['show', 'highlight', 'blur', 'hide'];

type Status =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'noteSaved' }
  | { kind: 'genreSaved' }
  | { kind: 'genreUnsaved' }
  | { kind: 'unreadable' }
  | { kind: 'failed'; code: string };

/** The select value of the automatic genre: none chosen. */
const AUTO_GENRE = '';
/**
 * The stream's genre (R63): the detected one and what decided it, and the viewer's choice for
 * the stream (`自動` for none). Remounted for each new answer of the service worker, so a choice
 * shows at once and then follows what the service worker says.
 */
function GenreField({
  genre,
  onChoose,
}: {
  genre: GenreView | undefined;
  onChoose: (genre: StreamGenre | undefined) => void;
}) {
  const [picked, setPicked] = useState<string>(
    genre?.reason === 'viewer' ? genre.genre : AUTO_GENRE,
  );
  // A label of its own: the genre names (雑談 …) stay out of the label text of other rows.
  const id = useId();
  const auto =
    genre === undefined
      ? '自動'
      : `自動（${GENRE_LABELS[genre.detected]}・${GENRE_REASON_LABELS[genre.detectedReason]}）`;
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id}>この配信のジャンル</label>
        <select
          id={id}
          value={picked}
          onChange={(event) => {
            const value = event.target.value;
            setPicked(value);
            onChoose(STREAM_GENRES.find((candidate) => candidate === value));
          }}
          className="rounded border border-slate-300 px-1 py-0.5"
        >
          <option value={AUTO_GENRE}>{auto}</option>
          {STREAM_GENRES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {GENRE_LABELS[candidate]}
            </option>
          ))}
        </select>
      </div>
      {genre !== undefined && (
        <p className="text-xs text-slate-500">
          判定: {GENRE_LABELS[genre.detected]}（理由: {GENRE_REASON_LABELS[genre.detectedReason]}）
        </p>
      )}
    </>
  );
}

/** Typing pause after which the spoiler targets are saved. */
const NOTE_DELAY_MS = 500;
type NoteSaver = Readonly<{
  /** Where a note goes when it is saved; set by the tab's effect for its stream. */
  use(this: void, save: (note: string) => void): void;
  /** The note as typed; it is saved after `NOTE_DELAY_MS` without further typing. */
  schedule(this: void, note: string): void;
  /** Saves a note still waiting at once (leaving the field, closing the panel). */
  flush(this: void): void;
}>;
function noteSaver(): NoteSaver {
  let save: ((note: string) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (pending === undefined) return;
    const note = pending;
    pending = undefined;
    save?.(note);
  }
  return {
    use(next) {
      save = next;
    },
    schedule(note) {
      pending = note;
      clearTimeout(timer);
      timer = setTimeout(flush, NOTE_DELAY_MS);
    },
    flush,
  };
}

/**
 * The stream's genre, detected or chosen for the stream (R63); how the chat shows each category
 * on for the stream (the genre's own and the ones every stream has, R62), translations and the
 * original text, and whether a new line waits for its judgement (R52), saved per streamer (or
 * per stream while the streamer is unknown, R29); and the spoiler targets, saved per stream
 * (R30). Filter and genre changes are saved at once; the spoiler targets after a short pause in
 * typing, when the field is left and when the panel closes.
 */
export function FilterTab({
  port,
  stream,
  genre,
}: {
  port: PanelPort;
  stream: StreamContext | undefined;
  /** The stream's genre and categories; every category is listed without it. */
  genre?: GenreView | undefined;
}) {
  const site = stream?.site;
  const owner = stream && ownerOf(stream);
  const partition = stream?.partition;
  const [settings, setSettings] = useState<FilterSettings | undefined>();
  /** Undefined until the stream's saved note is read. */
  const [note, setNote] = useState<string | undefined>();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const mounted = useRef(true);
  // One saver per mount: the panel remounts this tab for another stream.
  const [saver] = useState(noteSaver);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (site === undefined || partition === undefined) return undefined;
    let current = true;
    saver.use((text) => {
      launch(
        async () => {
          const saved = await port.notes.save(site, partition, text);
          if (!current) return;
          setStatus(
            saved.ok ? { kind: 'noteSaved' } : { kind: 'failed', code: saved.error.internalCode },
          );
        },
        () => {
          if (current) setStatus({ kind: 'failed', code: 'unexpected_failure' });
        },
      );
    });
    // A note still waiting is saved when the tab or the panel closes (pagehide unmounts it).
    return () => {
      saver.flush();
      current = false;
    };
  }, [saver, port, site, partition]);
  // The panel remounts this tab for another stream, so the state starts empty for each owner.
  useEffect(() => {
    if (site === undefined || owner === undefined) return undefined;
    let current = true;
    launch(
      async () => {
        const loaded = await port.filters.load(site, owner);
        if (!current) return;
        // Unreadable saved filters show the defaults; saving replaces them.
        setSettings(loaded.ok ? loaded.value : defaultFilterSettings);
        if (!loaded.ok) setStatus({ kind: 'unreadable' });
      },
      () => {
        if (current) setStatus({ kind: 'failed', code: 'unexpected_failure' });
      },
    );
    return () => {
      current = false;
    };
  }, [port, site, owner]);
  useEffect(() => {
    if (site === undefined || partition === undefined) return undefined;
    let current = true;
    launch(
      async () => {
        const loaded = await port.notes.load(site, partition);
        if (!current) return;
        // An unreadable note list shows an empty note; saving writes a readable one.
        setNote(loaded.ok ? loaded.value : '');
      },
      () => {
        if (current) setNote('');
      },
    );
    return () => {
      current = false;
    };
  }, [port, site, partition]);

  if (stream === undefined || site === undefined || owner === undefined)
    return <p className="text-slate-500">配信を開くと、配信者ごとのフィルターを設定できます。</p>;
  if (settings === undefined || note === undefined)
    return <p className="text-slate-500">読み込んでいます…</p>;
  const shown = settings;

  function save(next: FilterSettings): void {
    if (site === undefined || owner === undefined) return;
    setSettings(next);
    launch(
      async () => {
        const saved = await port.filters.save(site, owner, next);
        if (!mounted.current) return;
        setStatus(
          saved.ok ? { kind: 'saved' } : { kind: 'failed', code: saved.error.internalCode },
        );
      },
      () => {
        if (mounted.current) setStatus({ kind: 'failed', code: 'unexpected_failure' });
      },
    );
  }
  function choose(next: StreamGenre | undefined): void {
    if (stream === undefined) return;
    const shownStream = stream;
    launch(
      async () => {
        const saved = await port.chooseGenre(shownStream, next);
        if (!mounted.current) return;
        if (!saved.ok) setStatus({ kind: 'failed', code: saved.error.internalCode });
        else setStatus({ kind: saved.value.persisted ? 'genreSaved' : 'genreUnsaved' });
      },
      () => {
        if (mounted.current) setStatus({ kind: 'failed', code: 'unexpected_failure' });
      },
    );
  }
  // The categories on for the stream: the ones every stream has and the stream's own (R62).
  const categories = FILTER_CATEGORIES.filter(
    (category) =>
      genre === undefined || !isStreamCategory(category) || genre.categories.includes(category),
  );
  function setMode(category: CommentCategory, value: string): void {
    const mode = MODES.find((candidate): candidate is FilterMode => candidate === value);
    // The default option has no mode: the explicit one is removed.
    if (value === DEFAULT_MODE) {
      const { [category]: _removed, ...rest } = shown.modes;
      save({ ...shown, modes: rest });
      return;
    }
    if (mode === undefined) return;
    save({ ...shown, modes: { ...shown.modes, [category]: mode } });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-slate-500">ジャンル</legend>
        <GenreField key={JSON.stringify(genre ?? null)} genre={genre} onChoose={choose} />
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-slate-500">翻訳</legend>
        <label className="flex items-center justify-between gap-2">
          翻訳を表示
          <input
            type="checkbox"
            checked={shown.translate}
            onChange={(event) => save({ ...shown, translate: event.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          原文を表示
          <input
            type="checkbox"
            checked={shown.showOriginal}
            onChange={(event) => save({ ...shown, showOriginal: event.target.checked })}
          />
        </label>
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-slate-500">カテゴリごとの表示</legend>
        {genre !== undefined && (
          <p className="text-xs text-slate-500">
            この配信のジャンルで有効なカテゴリです。表示方法は配信者ごとに保存します。
          </p>
        )}
        {categories.map((category) => (
          <label key={category} className="flex items-center justify-between gap-2">
            {filterLabel(category)}
            <select
              value={shown.modes[category] ?? DEFAULT_MODE}
              onChange={(event) => setMode(category, event.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5"
            >
              <option value={DEFAULT_MODE}>既定（{MODE_LABELS[defaultModeOf(category)]}）</option>
              {MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="mt-1 flex items-center justify-between gap-2">
          {HOLD_LABEL}
          <input
            type="checkbox"
            checked={shown.holdUntilJudged}
            onChange={(event) => save({ ...shown, holdUntilJudged: event.target.checked })}
          />
        </label>
      </fieldset>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">ネタバレ対象</span>
        <textarea
          value={note}
          maxLength={MAX_SPOILER_NOTE}
          rows={2}
          placeholder="例: ゲーム名、どこまで進んだか"
          aria-describedby="spoiler-note-hint"
          onChange={(event) => {
            setNote(event.target.value);
            saver.schedule(event.target.value);
          }}
          onBlur={saver.flush}
          className="rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <span id="spoiler-note-hint" className="text-xs text-slate-500">
        この配信だけに使います（同じ配信者の次の配信には引き継ぎません）。
      </span>
      <output aria-live="polite" className="text-xs text-slate-500">
        {statusText(status, stream.streamer !== undefined)}
      </output>
    </form>
  );
}

function statusText(status: Status, byStreamer: boolean): string {
  switch (status.kind) {
    case 'idle':
      return byStreamer
        ? 'この配信者のフィルターです'
        : '配信者が分からないため、この配信のフィルターです';
    case 'saved':
      return byStreamer ? 'この配信者用に保存しました' : 'この配信用に保存しました';
    case 'noteSaved':
    case 'genreSaved':
      return 'この配信用に保存しました';
    case 'genreUnsaved':
      return 'ジャンルを保存できませんでした（一時的に使います）';
    case 'unreadable':
      return '保存済みの設定を読めなかったため、既定値を表示しています';
    case 'failed':
      return `保存できませんでした。${explain(status.code)}`;
  }
}
