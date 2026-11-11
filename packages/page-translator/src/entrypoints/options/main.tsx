import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { optionsPort } from '../../options.ts';
import { App } from './App.tsx';
import './style.css';

const element = document.getElementById('root');
if (element) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App port={optionsPort()} />
    </StrictMode>,
  );
  // Release React state when the options tab closes.
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
