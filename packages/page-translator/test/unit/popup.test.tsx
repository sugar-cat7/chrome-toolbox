// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';

afterEach(() => {
  // The popup unmounts when Chrome closes its document.
  window.dispatchEvent(new Event('pagehide'));
  document.body.replaceChildren();
  fakeBrowser.reset();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A focused window with a background tab and the tab in front, which shows `url`. */
async function windowWith(url: string | undefined): Promise<number | undefined> {
  await fakeBrowser.windows.create({ focused: true });
  await fakeBrowser.tabs.create({ url: 'https://other.fixture.test/' });
  const tab = await fakeBrowser.tabs.create({
    ...(url === undefined ? {} : { url }),
    active: true,
  });
  return tab.id;
}

/** A background that answers every message with `reply`; returns the messages it got. */
function backgroundAnswering(reply: Result<unknown>): unknown[] {
  const received: unknown[] = [];
  fakeBrowser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    received.push(message);
    sendResponse(reply);
    return true;
  });
  return received;
}

/** Opens the popup entrypoint as Chrome does: its document has the root element. */
async function openPopup(): Promise<void> {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  await act(async () => {
    await import('../../src/entrypoints/popup/main.tsx');
  });
}

describe('popup', () => {
  it.each([
    {
      name: 'with the URL activeTab lets it read',
      url: 'https://wiki.fixture.test/a',
      payload: { url: 'https://wiki.fixture.test/a' },
    },
    { name: 'without a URL it may not read', url: undefined, payload: {} },
  ])('starts translating the tab its button was pressed on, $name', async ({ url, payload }) => {
    const tabId = await windowWith(url);
    const received = backgroundAnswering(Ok({}));
    await openPopup();
    await userEvent.click(screen.getByRole('button', { name: 'このページを翻訳' }));
    expect(received).toEqual([{ type: 'page/start', payload: { tabId, ...payload } }]);
    expect(screen.getByRole('status')).toHaveProperty('textContent', '');
  });

  it.each([
    { code: 'page_restricted', text: 'このページは翻訳できません' },
    { code: 'ipc_failed', text: '翻訳を始められませんでした' },
  ] as const)('explains a start that fails with $code', async ({ code, text }) => {
    await windowWith('chrome://settings/');
    const received = backgroundAnswering(Err(failure(code)));
    await openPopup();
    await userEvent.click(screen.getByRole('button', { name: 'このページを翻訳' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(received).toHaveLength(1);
    // The button works again: the viewer may try once more.
    expect(screen.getByRole('button', { name: 'このページを翻訳' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
