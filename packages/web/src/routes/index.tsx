import { createFileRoute } from '@tanstack/react-router';
import { NotesPanel } from '@starter/ui';
import { browserNotes } from '../client/notes';

export const Route = createFileRoute('/')({
  component: () => <NotesPanel adapter={browserNotes} storage="Local D1 persistence" />,
});
