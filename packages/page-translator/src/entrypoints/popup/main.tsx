import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { popupPort } from '../../popup.ts';
import { App } from './App.tsx';
import './style.css';

const element = document.getElementById('root');
if (element) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App port={popupPort()} />
    </StrictMode>,
  );
  // Release React state, and with it the progress port, when Chrome closes the popup document.
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
