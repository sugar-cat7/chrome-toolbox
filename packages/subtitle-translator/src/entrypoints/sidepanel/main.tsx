import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { panelPort } from '../../panel.ts';
import { App } from './App.tsx';
import './style.css';

const element = document.getElementById('root');
if (element) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App port={panelPort()} />
    </StrictMode>,
  );
  // Release React state, and with it every listener the panel added, when Chrome closes the
  // panel document.
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
