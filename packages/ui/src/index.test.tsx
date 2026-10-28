import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ok, Err, failure, publicFailure, type Result, type PublicError } from '@starter/contracts';
import { NotesPanel, type NotesAdapter } from './index';

afterEach(cleanup);
const note = { id: '993a848f-d07f-43a2-85f8-333b05292ed4', text: 'A real note', createdAt: 1 };
const adapter = (): NotesAdapter => ({
  list: vi.fn<NotesAdapter['list']>().mockResolvedValue(Ok([])),
  add: vi.fn<NotesAdapter['add']>().mockResolvedValue(Ok(note)),
  remove: vi.fn<NotesAdapter['remove']>().mockResolvedValue(Ok(undefined)),
  export: vi.fn<NotesAdapter['export']>().mockResolvedValue(Ok(undefined)),
});

describe('platform-independent note UI', () => {
  it('keeps initial input read-only until the adapter is ready, then retains typed text', async () => {
    const actions = adapter();
    let ready: ((notes: Result<(typeof note)[], PublicError>) => void) | undefined;
    vi.mocked(actions.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    render(<NotesPanel adapter={actions} storage="Volatile sample storage" />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('New note');
    const user = userEvent.setup();
    expect(input.readOnly).toBe(true);
    await user.type(input, 'Too early');
    expect(input.value).toBe('');
    if (!ready) throw new Error('Adapter readiness was not requested');
    ready(Ok([]));
    await screen.findByText('No notes yet. Add your first note.');
    expect(input.readOnly).toBe(false);
    await user.type(input, 'Retained text');
    expect(input.value).toBe('Retained text');
  });
  it('shows loading, empty, validation, add, export and delete states', async () => {
    const actions = adapter();
    render(<NotesPanel adapter={actions} storage="Volatile sample storage" />);
    expect(screen.getByText('Loading notes…')).toBeDefined();
    await screen.findByText('No notes yet. Add your first note.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByRole('alert').textContent).toContain('between 1 and 1000');
    expect(actions.add).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('New note'), 'A real note');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await screen.findByText('A real note');
    expect(actions.add).toHaveBeenCalledWith({ text: 'A real note' });
    await user.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(actions.export).toHaveBeenCalledWith([note]));
    await user.click(screen.getByRole('button', { name: 'Delete A real note' }));
    await screen.findByText('No notes yet. Add your first note.');
    expect(actions.remove).toHaveBeenCalledWith(note.id);
  });
  it('retains data on a failed API mutation and permits retry after a load error', async () => {
    const actions = adapter();
    vi.mocked(actions.list)
      .mockResolvedValueOnce(Err(publicFailure(failure('network_failed'))))
      .mockResolvedValue(Ok([note]));
    vi.mocked(actions.remove).mockResolvedValue(Err(publicFailure(failure('storage_failed'))));
    render(<NotesPanel adapter={actions} storage="Volatile sample storage" />);
    await screen.findByRole('alert');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(note.text);
    await user.click(screen.getByRole('button', { name: `Delete ${note.text}` }));
    await screen.findByText('The operation failed. Your existing notes have been kept.');
    expect(screen.getByText(note.text)).toBeDefined();
  });
});
