// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, Ok } from '@chrome-toolbox/contracts';
import {
  defaultSettings,
  PLAMO_LICENSE_URL,
  PLAMO_TRANSLATE_MODEL,
} from '@chrome-toolbox/extension-core';
import { App } from '../../src/entrypoints/options/App.tsx';
import { optionsPort, readHosts, type OptionsApi } from '../../src/options.ts';
import { defaultPageSettings, type PageSettings } from '../../src/settings.ts';

afterEach(() => {
  cleanup();
  // The options entrypoint unmounts when its tab closes.
  window.dispatchEvent(new Event('pagehide'));
  document.body.replaceChildren();
  fakeBrowser.reset();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** The manifest's own hosts (wxt.config.ts): Chrome refuses to take them back. */
const REQUIRED = ['http://localhost/*', 'http://127.0.0.1/*'];
const WIKI = 'https://wiki.fixture.test/*';
const LLAMA = 'http://llm.fixture.test/*';
const PLAMO = 'PLaMo 3 Translate 2B（任意。Built with PLaMo）';

/**
 * The options page's Chrome: storage is WXT's fake browser's, `granted` the sites Chrome grants;
 * the background answers every status check with two models.
 */
function fakeApi(granted: readonly string[] = []): { api: OptionsApi; calls: string[] } {
  const calls: string[] = [];
  const sites = new Set([...REQUIRED, ...granted]);
  const api: OptionsApi = {
    storage: { local: fakeBrowser.storage.local },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => sites.has(origin)),
      request: async ({ origins }) => {
        calls.push(`request ${origins.join(' ')}`);
        return false;
      },
      remove: async ({ origins }) => {
        calls.push(`remove ${origins.join(' ')}`);
        for (const origin of origins) sites.delete(origin);
        return true;
      },
    },
    runtime: {
      sendMessage: async (message) => {
        calls.push(`send ${JSON.stringify(message)}`);
        return Ok({ models: ['gemma4-e4b', PLAMO_TRANSLATE_MODEL] });
      },
      getManifest: () => ({ manifest_version: 3, host_permissions: REQUIRED }),
    },
  };
  return { api, calls };
}

const storePage = (change: Partial<PageSettings>): Promise<void> =>
  fakeBrowser.storage.local.set({ page: { ...defaultPageSettings, ...change } });
const stored = async (key: 'page' | 'settings'): Promise<unknown> =>
  (await fakeBrowser.storage.local.get(key))[key];

const field = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const element = screen.getByLabelText(label);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element;
  throw new Error(`${label} is no text field`);
};
const radio = (name: string): HTMLInputElement => {
  const element = screen.getByRole('radio', { name });
  if (element instanceof HTMLInputElement) return element;
  throw new Error(`${name} is no radio`);
};
const saveButton = (): HTMLButtonElement => {
  const element = screen.getByRole('button', { name: '保存' });
  if (element instanceof HTMLButtonElement) return element;
  throw new Error('保存 is no button');
};
/** Renders the options page and waits for both settings to be read. */
async function openOptions(api: OptionsApi): Promise<void> {
  render(<App port={optionsPort(api)} />);
  await waitFor(() => expect(saveButton().disabled).toBe(false));
}

describe('readHosts', () => {
  it.each([
    { name: 'nothing', text: '', hosts: [] },
    { name: 'a host name', text: 'bank.example', hosts: ['bank.example'] },
    {
      name: 'URLs, blank lines, a trailing dot and a repeat',
      text: ' https://Bank.Example:8443/login \n\nmail.example.\r\nbank.example\n',
      hosts: ['bank.example', 'mail.example'],
    },
  ])('reads $name', ({ text, hosts }) => {
    expect(readHosts(text)).toEqual(Ok(hosts));
  });

  it.each([
    { text: 'bank.example\nhttps://bad host/', line: 'https://bad host/' },
    { text: '*.example', line: '*.example' },
    { text: 'ftp://files.example/', line: 'ftp://files.example/' },
  ])('stops at the malformed line $line', ({ text, line }) => {
    expect(readHosts(text)).toEqual(Err({ line }));
  });
});

describe('optionsPort', () => {
  it('saves the llama.cpp URL in extension storage before asking the background', async () => {
    const { api, calls } = fakeApi();
    const port = optionsPort(api);
    expect(await port.connection.load()).toEqual(Ok('http://127.0.0.1:18083'));
    expect(await port.connection.check('http://127.0.0.1:8081/')).toEqual(
      Ok({ models: ['gemma4-e4b', PLAMO_TRANSLATE_MODEL] }),
    );
    expect(calls).toEqual([
      `send ${JSON.stringify({ type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:8081' } })}`,
    ]);
    expect(await stored('settings')).toEqual({
      ...defaultSettings,
      llamaBaseUrl: 'http://127.0.0.1:8081',
    });
  });
});

describe('options page', () => {
  it('shows the connection, the translator, the Gemma model name and the never list as stored', async () => {
    const { api } = fakeApi();
    await fakeBrowser.storage.local.set({
      settings: {
        ...defaultSettings,
        models: { ...defaultSettings.models, translate: 'gemma4-e2b' },
      },
    });
    await storePage({ never: ['bank.example', 'mail.example'] });
    await openOptions(api);
    expect(field('llama.cpp の接続先').value).toBe('http://127.0.0.1:18083');
    expect(radio('Gemma').checked).toBe(true);
    expect(radio(PLAMO).checked).toBe(false);
    expect(field('Gemma のモデル名').value).toBe('gemma4-e2b');
    expect(field('翻訳しないサイト').value).toBe('bank.example\nmail.example');
    // PLaMo's name is fixed (P5): there is no field for it.
    expect(screen.queryByLabelText(/PLaMo のモデル名/u)).toBeNull();
    expect(
      screen.getByText(
        `PLaMo は llama.cpp のサーバーに別に入れます（docs/llama-server.md）。モデル名は ${PLAMO_TRANSLATE_MODEL} です`,
      ),
    ).toBeTruthy();
  });

  it('shows Built with PLaMo and the license link only while PLaMo is chosen', async () => {
    const { api } = fakeApi();
    await openOptions(api);
    expect(screen.queryByText('Built with PLaMo')).toBeNull();
    expect(screen.queryByRole('link', { name: 'PLaMo Community License' })).toBeNull();
    await userEvent.click(radio(PLAMO));
    expect(screen.getByText('Built with PLaMo')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'PLaMo Community License' });
    expect(link.getAttribute('href')).toBe(PLAMO_LICENSE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    await userEvent.click(radio('Gemma'));
    expect(screen.queryByText('Built with PLaMo')).toBeNull();
    expect(screen.queryByRole('link', { name: 'PLaMo Community License' })).toBeNull();
  });

  it('shows Built with PLaMo when PLaMo is the stored translator', async () => {
    const { api } = fakeApi();
    await storePage({ translator: 'plamo' });
    await openOptions(api);
    expect(radio(PLAMO).checked).toBe(true);
    expect(screen.getByText('Built with PLaMo')).toBeTruthy();
  });

  it('saves the translator, the Gemma model name and the never list, and nothing else', async () => {
    const { api } = fakeApi();
    await storePage({ always: [WIKI], mode: 'pair' });
    await openOptions(api);
    await userEvent.click(radio(PLAMO));
    await userEvent.clear(field('Gemma のモデル名'));
    await userEvent.type(field('Gemma のモデル名'), ' gemma4-e2b ');
    await userEvent.type(
      field('翻訳しないサイト'),
      'https://Bank.Example:8443/login{Enter}{Enter}mail.example.{Enter}bank.example',
    );
    // Meanwhile the background adds an always site and the connection check saves another URL:
    // the page saves its own fields onto what is stored now.
    await storePage({ always: [WIKI, 'https://docs.fixture.test/*'], mode: 'pair' });
    await fakeBrowser.storage.local.set({
      settings: { ...defaultSettings, llamaBaseUrl: 'http://127.0.0.1:8081' },
    });
    await userEvent.click(saveButton());
    expect(await screen.findByText('設定を保存しました')).toBeTruthy();
    expect(await stored('page')).toEqual({
      ...defaultPageSettings,
      mode: 'pair',
      always: [WIKI, 'https://docs.fixture.test/*'],
      translator: 'plamo',
      never: ['bank.example', 'mail.example'],
    });
    expect(await stored('settings')).toEqual({
      llamaBaseUrl: 'http://127.0.0.1:8081',
      models: { ...defaultSettings.models, translate: 'gemma4-e2b' },
    });
    // The list shows the host names as saved.
    expect(field('翻訳しないサイト').value).toBe('bank.example\nmail.example');
  });

  it('rejects a malformed host with its line', async () => {
    const { api } = fakeApi();
    await openOptions(api);
    await userEvent.type(field('翻訳しないサイト'), 'bank.example{Enter}https://bad host/');
    await userEvent.click(saveButton());
    expect(
      await screen.findByText('ホスト名の形式が正しくありません: https://bad host/'),
    ).toBeTruthy();
    expect(await stored('page')).toBeUndefined();
    expect(await stored('settings')).toBeUndefined();
  });

  it('asks for a Gemma model name', async () => {
    const { api } = fakeApi();
    await openOptions(api);
    await userEvent.clear(field('Gemma のモデル名'));
    await userEvent.click(saveButton());
    expect(await screen.findByText('Gemma のモデル名を入れてください')).toBeTruthy();
    expect(await stored('page')).toBeUndefined();
  });

  it('keeps the never list the user is typing when settings load late', async () => {
    const { api } = fakeApi();
    await storePage({ never: ['bank.example'], translator: 'plamo' });
    const port = optionsPort(api);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { load } = port.pageSettings;
    render(
      <App
        port={{
          ...port,
          pageSettings: {
            ...port.pageSettings,
            // The first read is late; the one before saving answers at once.
            load: vi
              .fn<typeof load>()
              .mockImplementationOnce(async () => {
                await held;
                return load();
              })
              .mockImplementation(load),
          },
        }}
      />,
    );
    await userEvent.type(field('翻訳しないサイト'), 'mail.example');
    await act(async () => {
      release();
      await held;
    });
    // The fields the viewer did not touch take the stored values; the typed one stays.
    await waitFor(() => expect(radio(PLAMO).checked).toBe(true));
    expect(field('翻訳しないサイト').value).toBe('mail.example');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await userEvent.click(saveButton());
    expect(await screen.findByText('設定を保存しました')).toBeTruthy();
    expect(await stored('page')).toEqual({
      ...defaultPageSettings,
      translator: 'plamo',
      never: ['mail.example'],
    });
  });

  it('removes an always site and gives its permission back, but not the llama.cpp host', async () => {
    const { api, calls } = fakeApi([WIKI, LLAMA]);
    await fakeBrowser.storage.local.set({
      settings: { ...defaultSettings, llamaBaseUrl: 'http://llm.fixture.test:18083' },
    });
    await storePage({ always: [WIKI, LLAMA], never: ['bank.example'] });
    await openOptions(api);
    const list = screen.getByRole('list', { name: '常に翻訳するサイト' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['https://wiki.fixture.test外す', 'http://llm.fixture.test外す']);
    await userEvent.click(screen.getByRole('button', { name: 'https://wiki.fixture.test を外す' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(await stored('page')).toEqual({
      ...defaultPageSettings,
      always: [LLAMA],
      never: ['bank.example'],
    });
    expect(calls).toEqual([`remove ${WIKI}`]);
    await userEvent.click(screen.getByRole('button', { name: 'http://llm.fixture.test を外す' }));
    expect(await screen.findByText('まだありません')).toBeTruthy();
    // llama.cpp is reached through that host: its permission stays.
    expect(calls).toEqual([`remove ${WIKI}`]);
    expect(await stored('page')).toEqual({ ...defaultPageSettings, never: ['bank.example'] });
  });

  it('says that always takes a site off the never list', async () => {
    const { api } = fakeApi();
    await openOptions(api);
    expect(screen.getByText(/足したサイトは「翻訳しないサイト」から外れます/u)).toBeTruthy();
  });

  it('tells how to start llama.cpp when every paragraph stays in the original', async () => {
    const { api } = fakeApi();
    await openOptions(api);
    const help = screen.getByRole('region', { name: '困ったとき' });
    expect(help.textContent).toContain('--parallel 2');
  });
});

describe('options entrypoint', () => {
  it('runs on the extension APIs', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await act(async () => {
      await import('../../src/entrypoints/options/main.tsx');
    });
    expect(await screen.findByDisplayValue('http://127.0.0.1:18083')).toBe(
      screen.getByLabelText('llama.cpp の接続先'),
    );
    await waitFor(() => expect(field('Gemma のモデル名').value).toBe('gemma4-e4b'));
  });
});
