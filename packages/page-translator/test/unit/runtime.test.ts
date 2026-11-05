import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { sidePanelPort, startBackground, type PanelApi } from '../../src/runtime.ts';

afterEach(() => {
  fakeBrowser.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('extension runtime wiring', () => {
  it('answers status messages from the background and removes its listener on cleanup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname === '/health'
          ? Response.json({ status: 'ok' })
          : Response.json({ data: [{ id: 'stub-model' }] }),
      ),
    );
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');
    const reply = await new Promise((resolve) => {
      expect(
        listener?.(
          { type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:18083' } },
          {},
          resolve,
        ),
      ).toBe(true);
    });
    expect(reply).toEqual(Ok({ models: ['stub-model'] }));
    stop();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
  });

  it('saves the side panel URL in extension storage before asking the background', async () => {
    const send = vi.fn<PanelApi['runtime']['sendMessage']>(async () =>
      Ok({ models: ['stub-model'] }),
    );
    const port = sidePanelPort({
      storage: fakeBrowser.storage,
      permissions: { contains: async () => true, request: async () => false },
      runtime: { sendMessage: send },
    });
    expect(await port.load()).toEqual(Ok('http://127.0.0.1:18083'));
    expect(await port.check('http://127.0.0.1:8081/')).toEqual(Ok({ models: ['stub-model'] }));
    expect(send).toHaveBeenCalledWith({
      type: 'llm/status',
      payload: { baseUrl: 'http://127.0.0.1:8081' },
    });
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:8081',
        models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'gemma4-e4b' },
      },
    });
  });
});
