import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionPanel } from '@chrome-toolbox/ui';
import { sidePanelPort } from '../../runtime.ts';
import './style.css';

const element = document.getElementById('root');
if (element) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <ConnectionPanel title="ページ翻訳" adapter={sidePanelPort()} />
    </StrictMode>,
  );
  // Release React state when Chrome closes the panel document.
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
