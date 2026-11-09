import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import type { FrontState } from '../../src/front.ts';
import { tabFronts } from '../../src/tab-fronts.ts';

afterEach(() => {
  fakeBrowser.reset();
});
const session = () => fakeBrowser.storage.session;
const active: FrontState = { state: 'active' };
const muted: FrontState = { state: 'pause', reason: 'muted' };
const ad: FrontState = { state: 'away', reason: 'ad' };

describe('tab fronts kept in storage.session', () => {
  it('reads a tab front back in a new store, as a restarted service worker does', async () => {
    const fronts = tabFronts(session());
    expect(await fronts.report(3, active)).toEqual(Ok(undefined));
    expect(await fronts.report(3, muted)).toEqual(Ok(undefined));
    const restarted = tabFronts(session());
    expect(await restarted.get(3)).toEqual(Ok(muted));
  });

  it('reports a tab that told nothing, or was forgotten, as away', async () => {
    const fronts = tabFronts(session());
    expect(await fronts.get(4)).toEqual(Ok({ state: 'away' }));
    await fronts.report(4, active);
    expect(await fronts.forget(4)).toEqual(Ok(undefined));
    for (const store of [fronts, tabFronts(session())])
      expect(await store.get(4)).toEqual(Ok({ state: 'away' }));
  });

  it('keeps the 16 tabs reported last', async () => {
    const fronts = tabFronts(session());
    for (let tab = 0; tab <= 16; tab += 1) await fronts.report(tab, active);
    const restarted = tabFronts(session());
    expect(await restarted.get(0)).toEqual(Ok({ state: 'away' }));
    expect(await restarted.get(16)).toEqual(Ok(active));
  });

  it('tells each listener every change of a tab front, until it is removed', async () => {
    const fronts = tabFronts(session());
    const seen: [number, FrontState][] = [];
    const off = fronts.onFront((tabId, front) => {
      seen.push([tabId, front]);
    });
    await fronts.report(1, active);
    // The same state again is no change.
    await fronts.report(1, active);
    await fronts.report(2, active);
    await fronts.report(1, ad);
    off();
    await fronts.report(1, active);
    expect(seen).toEqual([
      [1, active],
      [2, active],
      [1, ad],
    ]);
  });
});
