import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import {
  capture,
  Err,
  failure,
  launch,
  type AppError,
  type Result,
} from '@chrome-toolbox/contracts';
import { pageProtocol } from '../../protocol.ts';
import './style.css';

/**
 * Asks the background to translate the tab the toolbar button was pressed on. The button gave
 * the extension `activeTab` for it, so its URL is readable here.
 */
async function startActiveTab(): Promise<Result<Record<string, never>>> {
  const tabs = await capture(
    () => browser.tabs.query({ active: true, currentWindow: true }),
    'resource_missing',
  );
  if (!tabs.ok) return tabs;
  const [tab] = tabs.value;
  if (tab?.id === undefined) return Err(failure('resource_missing'));
  return pageProtocol.send((message) => browser.runtime.sendMessage(message), 'page/start', {
    tabId: tab.id,
    ...(tab.url === undefined ? {} : { url: tab.url }),
  });
}

const explain = (error: AppError): string =>
  error.internalCode === 'page_restricted'
    ? 'このページは翻訳できません'
    : '翻訳を始められませんでした';

function Popup() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <main className="flex w-72 flex-col gap-3 p-4 text-sm">
      <h1 className="text-base font-semibold">ページ翻訳</h1>
      <button
        type="button"
        disabled={busy}
        className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        onClick={() => {
          setBusy(true);
          setMessage('');
          launch(
            async () => {
              const started = await startActiveTab();
              setBusy(false);
              if (!started.ok) setMessage(explain(started.error));
            },
            (error) => {
              setBusy(false);
              setMessage(explain(error));
            },
          );
        }}
      >
        このページを翻訳
      </button>
      <output aria-live="polite" className="block">
        {message}
      </output>
    </main>
  );
}

const element = document.getElementById('root');
if (element) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
  // Release React state when Chrome closes the popup document.
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
