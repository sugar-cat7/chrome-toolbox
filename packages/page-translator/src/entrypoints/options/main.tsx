import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionPanel } from '@chrome-toolbox/ui';
import { optionsPort } from '../../runtime.ts';
import './style.css';

const element = document.getElementById('root');
if (element) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <ConnectionPanel title="ページ翻訳" adapter={optionsPort()} />
    </StrictMode>,
  );
  // Release React state when the options tab closes.
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
