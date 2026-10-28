import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NotesPanel } from '@starter/ui';
import { nativeNotes } from './native';
import './styles.css';

// The compile-time branch is removed from ordinary renderer artifacts.
if (import.meta.env.MODE === 'e2e') await import('@wdio/tauri-plugin');
const root = document.getElementById('root');
if (!root) {
  document.body.textContent = 'The application could not initialize.';
} else
  createRoot(root).render(
    <StrictMode>
      <main className="p-6">
        <NotesPanel
          adapter={nativeNotes}
          storage="Offline sample: notes are kept in memory until this window closes. JSON exports use the save destination you choose."
        />
      </main>
    </StrictMode>,
  );
