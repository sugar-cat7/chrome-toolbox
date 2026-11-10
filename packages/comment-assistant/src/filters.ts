import { z } from 'zod/mini';
import { capture, decode, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  commentCategorySchema,
  commentRecordSchema,
  type CommentCategory,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import { cut, type Site } from './sites/types.ts';
import { streamOf } from './stream-context.ts';

/** Characters of the viewer's spoiler targets; they go into every batch prompt of the stream. */
export const MAX_SPOILER_NOTE = 300;
/** Streams whose spoiler targets are kept, the most recently saved ones. */
export const MAX_SPOILER_NOTES = 100;

export const filterModeSchema = z.enum(['show', 'highlight', 'blur', 'hide']);
/** How the chat shows a comment of one category. */
export type FilterMode = z.infer<typeof filterModeSchema>;
export const filterStrengthSchema = z.enum(['mild', 'normal', 'strict']);
/**
 * How hard the defaults filter a comment the viewer did not set a mode for: `mild` removes
 * nothing outright (a 消す default becomes 伏せる) and marks nothing (ハイライト becomes 表示);
 * `strict` conceals everything borderline (伏せる becomes 消す, ハイライト becomes 伏せる).
 * 雑談 stays 表示 at every strength. A category with a chosen mode ignores the strength.
 */
export type FilterStrength = z.infer<typeof filterStrengthSchema>;
/**
 * The version of a saved filter record (R56). A record without one was saved before it: the
 * pre-5d rule (`withoutLegacyDefaults`) applies to it only. Version 2 records load as they are
 * (the strength they lack reads as `normal`); version 3 adds `strength`.
 */
const FILTERS_VERSION = 3;
export const filterSettingsSchema = z.strictObject({
  v: z.optional(z.literal([2, FILTERS_VERSION])),
  /** Show translations at all. */
  translate: z.boolean(),
  /** Show the original text instead of the translation for now. */
  showOriginal: z.boolean(),
  /** Only the modes the viewer chose; a category without one shows as `defaultModeOf` says. */
  modes: z.partialRecord(commentCategorySchema, filterModeSchema),
  /**
   * A new chat line comes in only once it is judged, at most 2 s later (R52). Settings saved
   * before the switch existed have none: on.
   */
  holdUntilJudged: z._default(z.boolean(), true),
  /**
   * How hard the defaults filter (see `FilterStrength`); records saved before it existed
   * have none: `normal`, the defaults they were saved with.
   */
  strength: z._default(filterStrengthSchema, 'normal'),
});
export type FilterSettings = Readonly<{
  translate: boolean;
  showOriginal: boolean;
  modes: Readonly<Partial<Record<CommentCategory, FilterMode>>>;
  holdUntilJudged: boolean;
  strength: FilterStrength;
}>;
/**
 * No mode is chosen: every category shows as `defaultModeOf` says, at `normal` strength. A new
 * line waits for its judgement.
 */
export const defaultFilterSettings: FilterSettings = {
  translate: true,
  showOriginal: false,
  modes: {},
  holdUntilJudged: true,
  strength: 'normal',
};
/**
 * How a category shows until the viewer chooses, at `normal` strength. Abusive and spam
 * comments, and the genre categories (instruction, relay, ghosting, privacy, sensitive, R62),
 * are removed from the chat (`hide`, 消す): highlighting or concealing them still draws the eye
 * to them, and the side panel lists them for review (R54). Spoilers are concealed as a bar
 * (`blur`, 伏せる). Questions and important comments are marked (`highlight`, ハイライト).
 */
function baseModeOf(category: CommentCategory): FilterMode {
  switch (category) {
    case 'abusive':
    case 'spam':
    case 'instruction':
    case 'relay':
    case 'ghosting':
    case 'privacy':
    case 'sensitive':
      return 'hide';
    case 'spoiler':
      return 'blur';
    case 'question':
    case 'important':
      return 'highlight';
    case 'chatter':
      return 'show';
  }
}
/** `mild`: nothing is removed outright and nothing is marked — 消す→伏せる, ハイライト→表示. */
const MILD_MODES: Readonly<Record<FilterMode, FilterMode>> = {
  show: 'show',
  highlight: 'show',
  blur: 'blur',
  hide: 'blur',
};
/** `strict`: everything borderline is concealed — 伏せる→消す, ハイライト→伏せる. */
const STRICT_MODES: Readonly<Record<FilterMode, FilterMode>> = {
  show: 'show',
  highlight: 'blur',
  blur: 'hide',
  hide: 'hide',
};
/**
 * How a category shows until the viewer chooses, at the settings' strength: `mild` and
 * `strict` shift the `normal` default one step toward showing or hiding (see
 * `FilterStrength`); `normal` keeps it.
 */
export function defaultModeOf(
  category: CommentCategory,
  strength: FilterStrength = 'normal',
): FilterMode {
  const base = baseModeOf(category);
  if (strength === 'mild') return MILD_MODES[base];
  if (strength === 'strict') return STRICT_MODES[base];
  return base;
}
/** The mode a comment shows with: the viewer's own choice for its category, else the default. */
export const modeOf = (filters: FilterSettings, category: CommentCategory): FilterMode =>
  filters.modes[category] ?? defaultModeOf(category, filters.strength);

/**
 * The defaults of the panel before Task 5d, which saved the mode of each of its six categories
 * (R34); the genre categories (R62) came later.
 */
const PRE_5D_MODES: Readonly<Partial<Record<CommentCategory, FilterMode>>> = {
  abusive: 'blur',
  spam: 'hide',
  spoiler: 'blur',
  question: 'highlight',
  important: 'highlight',
  chatter: 'show',
};
const isLegacyCategory = (key: string): key is CommentCategory => Object.hasOwn(PRE_5D_MODES, key);
/**
 * Settings that list all six categories were saved by the panel before it kept only choices:
 * the entries equal to that panel's defaults were never chosen, so they act as defaults again.
 * A record with fewer entries is kept as it is. Only for records without a version (R56).
 */
function withoutLegacyDefaults(settings: FilterSettings): FilterSettings {
  const entries = Object.entries(settings.modes);
  if (entries.length < Object.keys(PRE_5D_MODES).length) return settings;
  const chosen = entries.filter(
    ([category, mode]) => !isLegacyCategory(category) || PRE_5D_MODES[category] !== mode,
  );
  return { ...settings, modes: Object.fromEntries(chosen) };
}
/** The settings of a decoded saved record: one without a version gets the pre-5d rule (R34). */
export function settingsOf(record: z.output<typeof filterSettingsSchema>): FilterSettings {
  const { v, ...settings } = record;
  return v === undefined ? withoutLegacyDefaults(settings) : settings;
}
/** The record saved for `settings`, with its version (R56). */
export const storedFilters = ({
  translate,
  showOriginal,
  modes,
  holdUntilJudged,
  strength,
}: FilterSettings): z.input<typeof filterSettingsSchema> => ({
  v: FILTERS_VERSION,
  translate,
  showOriginal,
  modes,
  holdUntilJudged,
  strength,
});
/**
 * Extension storage key of one streamer's filter settings (`ownerOf` in stream-context.ts: the
 * streamer, or the stream while the streamer is unknown).
 */
export const filterKey = (site: Site, owner: string): string => `filters:${site}:${owner}`;

export type FilterStore = {
  /** The streamer's saved filters, or the defaults when none are saved. */
  load(this: void, site: Site, streamer: string): Promise<Result<FilterSettings>>;
  save(this: void, site: Site, streamer: string, settings: FilterSettings): Promise<Result<void>>;
};

/** Filter settings per streamer in `area` (`chrome.storage.local`), under `filterKey`. */
export function filterStore(area: StorageArea): FilterStore {
  return {
    async load(site, streamer): Promise<Result<FilterSettings>> {
      const key = filterKey(site, streamer);
      const stored = await capture(() => area.get(key), 'storage_failed');
      if (!stored.ok) return stored;
      const value = stored.value[key];
      if (value === undefined) return Ok(defaultFilterSettings);
      const decoded = decode(filterSettingsSchema, value);
      return decoded.ok ? Ok(settingsOf(decoded.value)) : decoded;
    },
    async save(site, streamer, settings): Promise<Result<void>> {
      const written = await capture(
        () => area.set({ [filterKey(site, streamer)]: storedFilters(settings) }),
        'storage_failed',
      );
      return written.ok ? Ok(undefined) : written;
    },
  };
}

/**
 * Extension storage key of the viewer's spoiler targets: one list for every stream, the newest
 * last, so the notes stay bounded.
 */
export const SPOILER_NOTES_KEY = 'spoilerNotes';
const spoilerNoteSchema = z.strictObject({
  site: commentRecordSchema.shape.site,
  stream: z.string(),
  note: z.string().check(z.minLength(1), z.maxLength(MAX_SPOILER_NOTE)),
});
type SpoilerNote = z.infer<typeof spoilerNoteSchema>;
const noteKey = (site: Site, stream: string): string => `${site}:${stream}`;

/** The readable entries of a stored notes list, oldest first. */
function entriesOf(value: unknown): SpoilerNote[] {
  return (Array.isArray(value) ? value : []).flatMap((item: unknown) => {
    const entry = decode(spoilerNoteSchema, item);
    return entry.ok ? [entry.value] : [];
  });
}
/** A stored notes list as `site:stream` → note; unreadable entries are skipped. */
export function spoilerNotesOf(value: unknown): Map<string, string> {
  return new Map(entriesOf(value).map((entry) => [noteKey(entry.site, entry.stream), entry.note]));
}

export type SpoilerNoteStore = {
  /** The stream's spoiler targets (`''` when none); a video's comments share its stream's. */
  load(this: void, site: Site, partition: string): Promise<Result<string>>;
  /** Saves them, trimmed and cut; an empty note removes the stream's entry. */
  save(this: void, site: Site, partition: string, note: string): Promise<Result<void>>;
};

/**
 * Spoiler targets per stream (R30): what one stream must not spoil (a game, how far it got)
 * does not carry over to the streamer's next stream, unlike the filters. The newest
 * `MAX_SPOILER_NOTES` streams are kept under `SPOILER_NOTES_KEY` in `area`.
 */
export function spoilerNoteStore(area: StorageArea): SpoilerNoteStore {
  async function read(): Promise<Result<SpoilerNote[]>> {
    const stored = await capture(() => area.get(SPOILER_NOTES_KEY), 'storage_failed');
    return stored.ok ? Ok(entriesOf(stored.value[SPOILER_NOTES_KEY])) : stored;
  }
  return {
    async load(site, partition): Promise<Result<string>> {
      const entries = await read();
      if (!entries.ok) return entries;
      const stream = streamOf(partition);
      const found = entries.value.find((entry) => entry.site === site && entry.stream === stream);
      return Ok(found?.note ?? '');
    },
    async save(site, partition, note): Promise<Result<void>> {
      const entries = await read();
      if (!entries.ok) return entries;
      const stream = streamOf(partition);
      const text = cut(note.trim(), MAX_SPOILER_NOTE);
      const others = entries.value.filter(
        (entry) => entry.site !== site || entry.stream !== stream,
      );
      const next = (text === '' ? others : [...others, { site, stream, note: text }]).slice(
        -MAX_SPOILER_NOTES,
      );
      const written = await capture(
        () => area.set({ [SPOILER_NOTES_KEY]: next }),
        'storage_failed',
      );
      return written.ok ? Ok(undefined) : written;
    },
  };
}
