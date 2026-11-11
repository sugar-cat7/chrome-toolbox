import { Ok, type Result } from '@chrome-toolbox/contracts';
import type { StorageArea } from '@chrome-toolbox/extension-core';
import type { FrontState } from './front.ts';
import { frontStateSchema } from './protocol.ts';
import { TAB_STATE_MAX, tabSessionStore } from './tab-session.ts';

/** A tab that reported no front (no watch page, or forgotten) processes nothing. */
export const UNKNOWN_FRONT: FrontState = { state: 'away' };

/** The `storage.session` key of the tab fronts. */
const SESSION_KEY = 'subs:fronts';

export type TabFronts = {
  /** Keeps what the tab's watch page reported, and tells the listeners when it changed. */
  report(this: void, tabId: number, front: FrontState): Promise<Result<void>>;
  /** What the tab reported last; `UNKNOWN_FRONT` (away) when it reported nothing. */
  get(this: void, tabId: number): Promise<Result<FrontState>>;
  /** Forgets a tab that closed. */
  forget(this: void, tabId: number): Promise<Result<void>>;
  /** Calls `listener` on each change of a tab's front (the capture follows it); returns the removal. */
  onFront(this: void, listener: (tabId: number, front: FrontState) => void): () => void;
};

const same = (a: FrontState | undefined, b: FrontState): boolean =>
  a?.state === b.state && a.reason === b.reason;

/**
 * Whether each watch page has its video in front (`subs/front`), for the 16 tabs reported last,
 * kept in memory and in `storage.session` (`tabSessionStore`) across service worker restarts. A
 * report that differs from what memory holds goes to the listeners at once, in the order of the
 * reports; after a restart the first report of a tab counts as a change.
 */
export function tabFronts(area: StorageArea, max = TAB_STATE_MAX): TabFronts {
  const store = tabSessionStore({ area, key: SESSION_KEY, schema: frontStateSchema, max });
  const listeners = new Set<(tabId: number, front: FrontState) => void>();
  return {
    report(tabId, front) {
      const changed = !same(store.known(tabId), front);
      const kept = store.report(tabId, front);
      if (changed) for (const listener of listeners) listener(tabId, front);
      return kept;
    },
    async get(tabId): Promise<Result<FrontState>> {
      const stored = await store.get(tabId);
      return stored.ok ? Ok(stored.value ?? UNKNOWN_FRONT) : stored;
    },
    forget: store.forget,
    onFront(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
