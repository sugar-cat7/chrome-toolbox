import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import {
  defaultFilterSettings,
  defaultModeOf,
  filterKey,
  filterStore,
  MAX_SPOILER_NOTE,
  MAX_SPOILER_NOTES,
  spoilerNoteStore,
  spoilerNotesOf,
  type FilterSettings,
} from '../../src/filters.ts';

afterEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const hideSpoilers: FilterSettings = {
  ...defaultFilterSettings,
  showOriginal: true,
  modes: { ...defaultFilterSettings.modes, spoiler: 'hide' },
};

describe('defaultModeOf', () => {
  it.each([
    // R54: abuse and spam are removed, spoilers concealed, questions and news highlighted.
    { category: 'abusive', mode: 'hide' },
    { category: 'spam', mode: 'hide' },
    { category: 'spoiler', mode: 'blur' },
    { category: 'question', mode: 'highlight' },
    { category: 'important', mode: 'highlight' },
    { category: 'chatter', mode: 'show' },
    // R62: the genre categories are removed (消す) until the viewer chooses.
    { category: 'instruction', mode: 'hide' },
    { category: 'relay', mode: 'hide' },
    { category: 'ghosting', mode: 'hide' },
    { category: 'privacy', mode: 'hide' },
    { category: 'sensitive', mode: 'hide' },
  ] as const)('shows $category as $mode by default', ({ category, mode }) => {
    expect(defaultModeOf(category)).toBe(mode);
  });

  it('reads a version-2 record that lists only the old six categories as it is (R56, R62)', async () => {
    const store = filterStore(fakeBrowser.storage.local);
    const modes = {
      abusive: 'blur',
      spam: 'hide',
      spoiler: 'blur',
      question: 'highlight',
      important: 'highlight',
      chatter: 'show',
    } as const;
    await fakeBrowser.storage.local.set({
      'filters:youtube:@FixtureStreamer': {
        v: 2,
        translate: true,
        showOriginal: false,
        modes,
        holdUntilJudged: true,
      },
    });
    const loaded = await store.load('youtube', '@FixtureStreamer');
    expect(loaded).toEqual(Ok({ ...defaultFilterSettings, modes }));
  });
});

describe('filterStore', () => {
  it('gives a streamer without saved filters the defaults, with no mode chosen', async () => {
    const store = filterStore(fakeBrowser.storage.local);
    expect(await store.load('youtube', '@FixtureStreamer')).toEqual(Ok(defaultFilterSettings));
    expect(defaultFilterSettings.modes).toEqual({});
    expect(defaultModeOf('abusive')).toBe('hide');
  });

  const preFiveD = {
    abusive: 'blur',
    spam: 'hide',
    spoiler: 'blur',
    question: 'highlight',
    important: 'highlight',
    chatter: 'show',
  } as const;

  it.each([
    { name: 'all pre-5d defaults', modes: preFiveD, expected: {} },
    {
      name: 'one real choice among the old defaults',
      modes: { ...preFiveD, spoiler: 'hide', chatter: 'highlight' },
      expected: { spoiler: 'hide', chatter: 'highlight' },
    },
    // Fewer than six entries are choices made with the new panel: kept as they are.
    {
      name: 'a partial record',
      modes: { spam: 'hide', chatter: 'show' },
      expected: { spam: 'hide', chatter: 'show' },
    },
  ] as const)(
    'loads $name saved without a version as settings with only the real choices (R34)',
    async ({ modes, expected }) => {
      await fakeBrowser.storage.local.set({
        'filters:youtube:@FixtureStreamer': { translate: false, showOriginal: true, modes },
      });
      const store = filterStore(fakeBrowser.storage.local);
      expect(await store.load('youtube', '@FixtureStreamer')).toEqual(
        Ok({ translate: false, showOriginal: true, modes: expected, holdUntilJudged: true }),
      );
    },
  );

  it('keeps every mode of a record saved with version 2, an explicit 伏せる for abusive too (R56)', async () => {
    const store = filterStore(fakeBrowser.storage.local);
    // All six chosen in the panel; abusive concealed although the pre-5d panel had that default.
    const chosen = { ...preFiveD, chatter: 'highlight' } as const;
    await fakeBrowser.storage.local.set({
      'filters:youtube:@FixtureStreamer': {
        v: 2,
        translate: true,
        showOriginal: false,
        modes: chosen,
        holdUntilJudged: true,
      },
    });
    expect(await store.load('youtube', '@FixtureStreamer')).toEqual(
      Ok({ ...defaultFilterSettings, modes: chosen }),
    );
    // Saved again, the record keeps its version.
    expect(
      await store.save('youtube', '@FixtureStreamer', { ...defaultFilterSettings, modes: chosen }),
    ).toEqual(Ok(undefined));
    expect(await fakeBrowser.storage.local.get('filters:youtube:@FixtureStreamer')).toEqual({
      'filters:youtube:@FixtureStreamer': { v: 2, ...defaultFilterSettings, modes: chosen },
    });
    expect((await store.load('youtube', '@FixtureStreamer')).ok).toBe(true);
    // The same six without a version still read as saved before Task 5d.
    await fakeBrowser.storage.local.set({
      'filters:youtube:@FixtureStreamer': { translate: true, showOriginal: false, modes: chosen },
    });
    expect(await store.load('youtube', '@FixtureStreamer')).toEqual(
      Ok({ ...defaultFilterSettings, modes: { chatter: 'highlight' } }),
    );
  });

  it('lets a line in only once it is judged unless the viewer turned it off (R52)', async () => {
    const store = filterStore(fakeBrowser.storage.local);
    expect(defaultFilterSettings.holdUntilJudged).toBe(true);
    // Settings saved before the switch existed wait too.
    await fakeBrowser.storage.local.set({
      'filters:youtube:@FixtureStreamer': { translate: true, showOriginal: false, modes: {} },
    });
    expect(await store.load('youtube', '@FixtureStreamer')).toEqual(Ok(defaultFilterSettings));
    const off: FilterSettings = { ...defaultFilterSettings, holdUntilJudged: false };
    expect(await store.save('youtube', '@FixtureStreamer', off)).toEqual(Ok(undefined));
    expect(await fakeBrowser.storage.local.get('filters:youtube:@FixtureStreamer')).toEqual({
      'filters:youtube:@FixtureStreamer': { v: 2, ...off },
    });
    expect(await store.load('youtube', '@FixtureStreamer')).toEqual(Ok(off));
  });

  it('saves one streamer under filters:<site>:<streamer> and loads it back', async () => {
    const store = filterStore(fakeBrowser.storage.local);
    expect(await store.save('youtube', '@FixtureStreamer', hideSpoilers)).toEqual(Ok(undefined));
    expect(filterKey('youtube', '@FixtureStreamer')).toBe('filters:youtube:@FixtureStreamer');
    expect(await fakeBrowser.storage.local.get('filters:youtube:@FixtureStreamer')).toEqual({
      'filters:youtube:@FixtureStreamer': { v: 2, ...hideSpoilers },
    });
    expect(await store.load('youtube', '@FixtureStreamer')).toEqual(Ok(hideSpoilers));
    // Other streamers, and the same name on another site, keep their own (default) filters.
    expect(await store.load('youtube', '@OtherStreamer')).toEqual(Ok(defaultFilterSettings));
    expect(await store.load('twitch', '@FixtureStreamer')).toEqual(Ok(defaultFilterSettings));
  });

  it('reports saved filters it cannot read instead of guessing', async () => {
    await fakeBrowser.storage.local.set({ 'filters:youtube:@FixtureStreamer': { modes: 'x' } });
    const store = filterStore(fakeBrowser.storage.local);
    expect(await store.load('youtube', '@FixtureStreamer')).toMatchObject({
      ok: false,
      error: { internalCode: 'response_invalid' },
    });
  });

  it('reports a storage failure as storage_failed', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValueOnce(new Error('unreadable'));
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota'));
    const store = filterStore(fakeBrowser.storage.local);
    expect(await store.load('youtube', '@FixtureStreamer')).toMatchObject({
      ok: false,
      error: { internalCode: 'storage_failed' },
    });
    expect(await store.save('youtube', '@FixtureStreamer', hideSpoilers)).toMatchObject({
      ok: false,
      error: { internalCode: 'storage_failed' },
    });
  });
});

describe('spoilerNoteStore', () => {
  it('keeps one note per stream, not per streamer (R30), and none for a new stream', async () => {
    const notes = spoilerNoteStore(fakeBrowser.storage.local);
    expect(await notes.load('youtube', 'fixture0001')).toEqual(Ok(''));
    expect(await notes.save('youtube', 'fixture0001', ' past the frozen bridge ')).toEqual(
      Ok(undefined),
    );
    expect(await notes.save('twitch', 'fixturechannel', 'any% route')).toEqual(Ok(undefined));
    expect(await notes.load('youtube', 'fixture0001')).toEqual(Ok('past the frozen bridge'));
    // The video's comments are the same stream.
    expect(await notes.load('youtube', 'fixture0001#comments')).toEqual(
      Ok('past the frozen bridge'),
    );
    expect(await notes.load('youtube', 'fixture0002')).toEqual(Ok(''));
    const stored = await fakeBrowser.storage.local.get('spoilerNotes');
    expect(spoilerNotesOf(stored['spoilerNotes'])).toEqual(
      new Map([
        ['youtube:fixture0001', 'past the frozen bridge'],
        ['twitch:fixturechannel', 'any% route'],
      ]),
    );
    // An empty note removes the stream's entry.
    await notes.save('youtube', 'fixture0001', '   ');
    expect(
      spoilerNotesOf((await fakeBrowser.storage.local.get('spoilerNotes'))['spoilerNotes']),
    ).toEqual(new Map([['twitch:fixturechannel', 'any% route']]));
  });

  it(`cuts a note to ${MAX_SPOILER_NOTE} characters and keeps the newest ${MAX_SPOILER_NOTES} streams`, async () => {
    const notes = spoilerNoteStore(fakeBrowser.storage.local);
    await notes.save('twitch', 'long', 'x'.repeat(MAX_SPOILER_NOTE + 50));
    expect(await notes.load('twitch', 'long')).toEqual(Ok('x'.repeat(MAX_SPOILER_NOTE)));
    for (let i = 0; i < MAX_SPOILER_NOTES; i += 1)
      await notes.save('youtube', `video${i}`, `note ${i}`);
    expect(await notes.load('twitch', 'long')).toEqual(Ok(''));
    expect(await notes.load('youtube', 'video0')).toEqual(Ok('note 0'));
    // Saving again makes a stream the newest.
    await notes.save('youtube', 'video0', 'note 0 again');
    await notes.save('youtube', 'video100', 'note 100');
    expect(await notes.load('youtube', 'video0')).toEqual(Ok('note 0 again'));
    expect(await notes.load('youtube', 'video1')).toEqual(Ok(''));
  });

  it('skips unreadable entries and reports a storage failure', async () => {
    await fakeBrowser.storage.local.set({
      spoilerNotes: [{ site: 'youtube', stream: 'fixture0001', note: 'ok' }, { bad: true }, 'x'],
    });
    const notes = spoilerNoteStore(fakeBrowser.storage.local);
    expect(await notes.load('youtube', 'fixture0001')).toEqual(Ok('ok'));
    expect(spoilerNotesOf('not a list')).toEqual(new Map());
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValueOnce(new Error('unreadable'));
    expect(await notes.load('youtube', 'fixture0001')).toMatchObject({
      ok: false,
      error: { internalCode: 'storage_failed' },
    });
  });
});
