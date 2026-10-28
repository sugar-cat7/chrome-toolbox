import { createTelemetry, observeAdapter, type TraceCarrier } from '@starter/observability';
import { invoke } from '@tauri-apps/api/core';
import {
  noteSchema,
  notesSchema,
  capturePublic,
  decode,
  Err,
  Ok,
  publicFailure,
  type Result,
  type PublicError,
} from '@starter/contracts';
import type { NotesAdapter } from '@starter/ui';

async function command(
  name: string,
  carrier: TraceCarrier,
  args?: Record<string, unknown>,
): Promise<Result<unknown, PublicError>> {
  return capturePublic(() => invoke<unknown>(name, { ...args, telemetry: carrier }), 'ipc_failed');
}

const telemetry = createTelemetry({
  service: 'super-starter-desktop-renderer',
  instance: 'super-starter',
  runId: import.meta.env.VITE_OTEL_RUN_ID ?? 'local',
  version: import.meta.env.VITE_OTEL_VERSION ?? 'development',
  ...(import.meta.env.VITE_OTEL_ENDPOINT ? { endpoint: import.meta.env.VITE_OTEL_ENDPOINT } : {}),
});

export const nativeNotes: NotesAdapter = {
  async list() {
    return observeAdapter(telemetry, 'notes.list', async (carrier) => {
      const received = await command('list_notes', carrier);
      if (!received.ok) return received;
      const parsed = decode(notesSchema, received.value);
      return parsed.ok ? parsed : Err(publicFailure(parsed.error));
    });
  },
  async add(input) {
    return observeAdapter(telemetry, 'notes.add', async (carrier) => {
      const received = await command('add_note', carrier, { text: input.text });
      if (!received.ok) return received;
      const parsed = decode(noteSchema, received.value);
      return parsed.ok ? parsed : Err(publicFailure(parsed.error));
    });
  },
  async remove(id) {
    return observeAdapter(telemetry, 'notes.remove', async (carrier) => {
      const received = await command('delete_note', carrier, { id });
      return received.ok ? Ok(undefined) : received;
    });
  },
  async export() {
    return observeAdapter(telemetry, 'notes.export', async (carrier) => {
      const received = await command('export_notes', carrier);
      return received.ok ? Ok(undefined) : received;
    });
  },
};
