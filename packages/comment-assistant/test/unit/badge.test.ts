import { describe, expect, it } from 'vitest';
import { createHiddenBadge, MAX_BADGE_TABS } from '../../src/badge.ts';

/** The badge texts set, in order, as `tabId:text`. */
function badge(): {
  sets: string[];
  texts: Map<number, string>;
  hidden: ReturnType<typeof createHiddenBadge>;
} {
  const sets: string[] = [];
  const texts = new Map<number, string>();
  const hidden = createHiddenBadge((tabId, text) => {
    sets.push(`${tabId}:${text}`);
    texts.set(tabId, text);
  });
  return { sets, texts, hidden };
}

describe('createHiddenBadge', () => {
  it("counts the stream's comments removed without a verdict, per tab, chat and video comments together (R54)", () => {
    const { sets, texts, hidden } = badge();
    // A watch page reports its video's comments; its live chat frame shares the stream.
    hidden.shows(1, 'youtube', 'fixtureVid01#comments');
    hidden.shows(2, 'twitch', 'fixturechannel');
    expect(sets).toEqual(['1:', '2:']);
    hidden.counted('youtube', 'fixtureVid01', 2);
    hidden.counted('youtube', 'fixtureVid01#comments', 1);
    hidden.counted('twitch', 'fixturechannel', 4);
    // Another stream's count changes no tab.
    hidden.counted('youtube', 'fixtureVid02', 7);
    expect(texts).toEqual(
      new Map([
        [1, '3'],
        [2, '4'],
      ]),
    );
    // A verdict lowers the count; an unchanged count sets nothing again.
    hidden.counted('youtube', 'fixtureVid01', 1);
    hidden.counted('youtube', 'fixtureVid01', 1);
    expect(texts.get(1)).toBe('2');
    expect(sets.filter((set) => set.startsWith('1:'))).toEqual(['1:', '1:2', '1:3', '1:2']);
    // The tab moves to another stream, then leaves streams: its badge follows, empty at 0.
    hidden.shows(1, 'youtube', 'fixtureVid02');
    expect(texts.get(1)).toBe('7');
    hidden.shows(1, 'youtube', undefined);
    expect(texts.get(1)).toBe('');
    // A page without a stream after a full navigation empties it too.
    hidden.shows(2, 'twitch', 'fixturechannel');
    hidden.leaves(2);
    expect(texts.get(2)).toBe('');
    hidden.shows(2, 'twitch', 'fixturechannel');
    expect(hidden.knows(1)).toBe(true);
    hidden.counted('twitch', 'fixturechannel', 0);
    expect(texts.get(2)).toBe('');
  });

  it(`keeps the streams of the ${MAX_BADGE_TABS} most recent tabs`, () => {
    const { hidden } = badge();
    for (let tab = 1; tab <= MAX_BADGE_TABS + 1; tab += 1)
      hidden.shows(tab, 'twitch', `channel${tab}`);
    expect(hidden.knows(1)).toBe(false);
    expect(hidden.knows(MAX_BADGE_TABS + 1)).toBe(true);
  });
});
