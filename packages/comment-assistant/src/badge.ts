import type { Site } from './sites/types.ts';
import { streamOf } from './stream-context.ts';

/** Tabs whose stream the badge remembers, the most recent. */
export const MAX_BADGE_TABS = 64;

export type HiddenBadge = Readonly<{
  /** A tab's top frame shows `partition` of `site`, or no stream (`undefined`). */
  shows(this: void, tabId: number, site: Site, partition: string | undefined): void;
  /**
   * The tab shows no stream now (a page without one after a full navigation, also one the badge
   * did not know after a restart): its badge is emptied.
   */
  leaves(this: void, tabId: number): void;
  /** Whether the tab's stream (or that it shows none) is known. */
  knows(this: void, tabId: number): boolean;
  /** A channel's comments taken out of the chat that have no verdict yet. */
  counted(this: void, site: Site, channel: string, count: number): void;
}>;

/**
 * The number on the extension's toolbar icon (R54): per tab, the comments of the tab's stream
 * taken out of the chat that wait for a verdict (its live chat and its video comments together),
 * empty at 0. It follows the pipeline's counts and the streams the tabs report, and sets a tab's
 * text (`setText`) only when it changed: no polling.
 */
export function createHiddenBadge(setText: (tabId: number, text: string) => void): HiddenBadge {
  /**
   * Each tab's stream (`site:stream`, '' while it shows none) and the text last set on it, the
   * most recently reported last.
   */
  const tabs = new Map<number, { stream: string; text?: string }>();
  /** Counts by channel (`site:channel`); a channel at 0 is forgotten. */
  const counts = new Map<string, Readonly<{ stream: string; count: number }>>();

  const streamKey = (site: Site, partition: string): string => `${site}:${streamOf(partition)}`;
  function textOf(stream: string): string {
    if (stream === '') return '';
    let total = 0;
    for (const entry of counts.values()) if (entry.stream === stream) total += entry.count;
    return total === 0 ? '' : String(total);
  }
  function update(tabId: number, tab: { stream: string; text?: string }): void {
    const text = textOf(tab.stream);
    if (tab.text === text) return;
    tab.text = text;
    setText(tabId, text);
  }
  /** The tab shows `stream` ('' for none) from now on: its badge follows. */
  function show(tabId: number, stream: string): void {
    const tab = tabs.get(tabId) ?? { stream };
    tab.stream = stream;
    tabs.delete(tabId);
    tabs.set(tabId, tab);
    for (const oldest of tabs.keys()) {
      if (tabs.size <= MAX_BADGE_TABS) break;
      tabs.delete(oldest);
    }
    update(tabId, tab);
  }
  return {
    shows(tabId, site, partition) {
      show(tabId, partition === undefined ? '' : streamKey(site, partition));
    },
    leaves(tabId) {
      show(tabId, '');
    },
    knows: (tabId) => tabs.has(tabId),
    counted(site, channel, count) {
      const key = `${site}:${channel}`;
      const stream = streamKey(site, channel);
      if (count === 0) counts.delete(key);
      else counts.set(key, { stream, count });
      for (const [tabId, tab] of tabs) if (tab.stream === stream) update(tabId, tab);
    },
  };
}
