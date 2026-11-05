import { createFileRoute } from '@tanstack/react-router';
import { NotesPanel } from '@chrome-toolbox/ui';
import { browserNotes } from '../client/notes';

export const Route = createFileRoute('/')({
  component: () => (
    <NotesPanel
      adapter={browserNotes}
      storage="Volatile sample — resets when the Worker restarts"
    />
  ),
});
