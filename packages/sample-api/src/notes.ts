import {
  noteInput,
  notesSchema,
  decode,
  capture,
  captureSync,
  Err,
  Ok,
  failure,
  publicFailure,
  errorStatus,
  type Result,
  type Note,
} from '@starter/contracts';
import { createTelemetry, type TraceCarrier, type OperationName } from '@starter/observability';
import { z } from 'zod';

export type SampleBindings = {
  WRITE_MODE: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_INSTANCE?: string;
  OTEL_RUN_ID?: string;
  OTEL_VERSION?: string;
  OTEL_ENDPOINT?: string;
  NOTES?: D1Database;
  NOTE_CACHE?: KVNamespace;
  NOTE_EXPORTS?: R2Bucket;
};
const volatileNotes = new Map<string, Note>();
const extensionInput = z
  .object({ key: z.string().regex(/^[a-z0-9-]{1,64}$/u), value: z.string().max(2000) })
  .strict();

export async function handleNotes(request: Request, env: SampleBindings): Promise<Response> {
  const requestId = crypto.randomUUID();
  const telemetry = createTelemetry({
    service: env.OTEL_SERVICE_NAME ?? 'api',
    instance: env.OTEL_INSTANCE ?? 'local',
    runId: env.OTEL_RUN_ID ?? 'local',
    version: env.OTEL_VERSION ?? 'development',
    ...(env.OTEL_ENDPOINT ? { endpoint: env.OTEL_ENDPOINT } : {}),
  });
  const carrier: TraceCarrier | undefined = request.headers.has('traceparent')
    ? { traceparent: request.headers.get('traceparent')! }
    : undefined;
  const operation = telemetry.start('http.request', carrier, requestId);
  // The SDK boundary owns both rejection and SDK-declared failure; child spans
  // finish before the HTTP owner projects the same finite error/diagnostic ID.
  const binding = async <T>(
    name: OperationName,
    action: () => Promise<T>,
    valid: (value: T) => boolean = () => true,
  ): Promise<Result<T>> => {
    const child = telemetry.start(name, { traceparent: operation.traceparent }, requestId);
    const captured = await capture(action, 'storage_failed');
    const result =
      captured.ok && !valid(captured.value) ? Err(failure('storage_failed')) : captured;
    child.finish(result);
    return result;
  };

  const url = new URL(request.url);
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        'x-request-id': requestId,
        'x-storage-mode': env.NOTES ? 'persistent-d1' : 'volatile-sample',
      },
    });
  const route = async (): Promise<Result<Response>> => {
    if (url.pathname === '/health')
      return Ok(
        json({
          ok: true,
          storage: env.NOTES ? 'd1' : 'volatile',
          writeMode: env.WRITE_MODE,
        }),
      );
    if (request.method !== 'GET' && env.WRITE_MODE !== 'allow')
      return Err(failure('write_forbidden'));
    // Authorized JSON ingress owns the body even when an optional binding is absent.
    // Keep write-denial before any read; never wait for an unauthenticated body.
    const text =
      request.method === 'POST' &&
      ['/api/notes', '/extensions/kv', '/extensions/r2'].includes(url.pathname)
        ? await readBodyText(request)
        : Ok('');
    if (!text.ok) return text;
    let response: Response;
    if (url.pathname === '/api/notes' && request.method === 'GET') {
      let raw: unknown = [...volatileNotes.values()];
      if (env.NOTES) {
        const stored = await binding(
          'binding.d1.read',
          () =>
            env
              .NOTES!.prepare(
                'SELECT id, text, created_at AS createdAt FROM notes ORDER BY created_at, id',
              )
              .all<Note>(),
          (value) => value.success,
        );
        if (!stored.ok) return stored;
        raw = stored.value.results;
      }
      const notes = decode(notesSchema, raw);
      if (!notes.ok) return notes;
      response = json(notes.value);
    } else if (url.pathname === '/api/notes' && request.method === 'POST') {
      const body = parseBody(text.value);
      if (!body.ok) return body;
      const parsed = noteInput.safeParse(body.value);
      if (!parsed.success) return Err(failure('input_invalid'));
      else {
        const note: Note = {
          id: crypto.randomUUID(),
          text: parsed.data.text,
          createdAt: Date.now(),
        };
        if (env.NOTES) {
          const stored = await binding(
            'binding.d1.write',
            () =>
              env
                .NOTES!.prepare('INSERT INTO notes (id, text, created_at) VALUES (?, ?, ?)')
                .bind(note.id, note.text, note.createdAt)
                .run(),
            (value) => value.success,
          );
          if (!stored.ok) return stored;
        } else volatileNotes.set(note.id, note);
        response = json(note, 201);
      }
    } else if (url.pathname.startsWith('/api/notes/') && request.method === 'DELETE') {
      const id = url.pathname.slice('/api/notes/'.length);
      if (!z.uuid().safeParse(id).success) return Err(failure('input_invalid'));
      else {
        let removed: boolean;
        if (env.NOTES) {
          const stored = await binding(
            'binding.d1.write',
            () => env.NOTES!.prepare('DELETE FROM notes WHERE id = ?').bind(id).run(),
            (value) => value.success,
          );
          if (!stored.ok) return stored;
          removed = stored.value.meta.changes > 0;
        } else removed = volatileNotes.delete(id);
        if (!removed) return Err(failure('resource_missing'));
        response = new Response(null, { status: 204, headers: { 'x-request-id': requestId } });
      }
    } else if (url.pathname === '/extensions/kv' && env.NOTE_CACHE) {
      if (request.method === 'POST') {
        const body = parseBody(text.value);
        if (!body.ok) return body;
        const parsed = extensionInput.safeParse(body.value);
        if (!parsed.success) return Err(failure('input_invalid'));
        else {
          const stored = await binding('binding.kv.write', () =>
            env.NOTE_CACHE!.put(parsed.data.key, parsed.data.value),
          );
          if (!stored.ok) return stored;
          response = json({ ok: true });
        }
      } else {
        const stored = await binding('binding.kv.read', () =>
          env.NOTE_CACHE!.get(url.searchParams.get('key') ?? ''),
        );
        if (!stored.ok) return stored;
        response = json({ value: stored.value });
      }
    } else if (url.pathname === '/extensions/r2' && env.NOTE_EXPORTS) {
      if (request.method === 'POST') {
        const body = parseBody(text.value);
        if (!body.ok) return body;
        const parsed = extensionInput.safeParse(body.value);
        if (!parsed.success) return Err(failure('input_invalid'));
        else {
          const stored = await binding('binding.r2.write', () =>
            env.NOTE_EXPORTS!.put(parsed.data.key, parsed.data.value),
          );
          if (!stored.ok) return stored;
          response = json({ ok: true });
        }
      } else {
        const stored = await binding('binding.r2.read', () =>
          env
            .NOTE_EXPORTS!.get(url.searchParams.get('key') ?? '')
            .then((object) => (object ? object.text() : null)),
        );
        if (!stored.ok) return stored;
        response = json({ value: stored.value });
      }
    } else return Err(failure('resource_missing'));
    return Ok(response);
  };
  const captured = await capture(route, 'storage_failed');
  const result = captured.ok ? captured.value : captured;
  operation.finish(result);
  const exported = await telemetry.flush();
  const response = result.ok
    ? result.value
    : json({ error: publicFailure(result.error), requestId }, errorStatus(result.error));
  response.headers.set('traceparent', operation.traceparent);
  response.headers.set(
    'x-telemetry-state',
    !telemetry.status().enabled ? 'disabled' : exported.ok ? 'accepted' : 'failed',
  );
  if (!result.ok) {
    response.headers.set('x-diagnostic-id', result.error.diagnosticId);
    response.headers.set('x-error-code', publicFailure(result.error).code);
  }
  await telemetry.shutdown();
  return response;
}

function parseBody(text: string): Result<unknown> {
  return captureSync(() => JSON.parse(text) as unknown, 'request_json_invalid');
}

async function readBodyText(request: Request): Promise<Result<string>> {
  const opened = captureSync(() => request.body?.getReader(), 'request_json_invalid');
  if (!opened.ok) return opened;
  if (!opened.value) return Ok('');
  const reader = opened.value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure('request_json_invalid')), 3000);
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  let result: Result<string> = Err(failure('request_json_invalid'));
  const expires = performance.now() + 3000;
  let accepting = true;
  const collect = async (): Promise<Result<string>> => {
    // Check wall time as well as bytes/chunks even when a producer starves timers.
    for (let count = 0; count < 65536; count += 1) {
      if (!accepting || performance.now() >= expires) return Err(failure('request_json_invalid'));
      const chunk = await capture(() => reader.read(), 'request_json_invalid');
      if (!chunk.ok) return chunk;
      if (!accepting || performance.now() >= expires) return Err(failure('request_json_invalid'));
      if (chunk.value.done) {
        complete = true;
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const part of chunks) {
          data.set(part, offset);
          offset += part.byteLength;
        }
        return captureSync(() => new TextDecoder().decode(data), 'request_json_invalid');
      }
      if (!(chunk.value.value instanceof Uint8Array)) return Err(failure('request_json_invalid'));
      bytes += chunk.value.value.byteLength;
      if (bytes > 32768) return Err(failure('input_invalid'));
      if (chunk.value.value.byteLength) chunks.push(chunk.value.value);
    }
    return Err(failure('input_invalid'));
  };
  // One race owns the deadline, rather than retaining a reaction per chunk.
  const collected = await capture(
    () => Promise.race([collect(), deadline]),
    'request_json_invalid',
  );
  accepting = false;
  result = collected.ok ? collected.value : collected;
  if (!complete) {
    const cancelled = await capture(
      () => Promise.race([reader.cancel(), deadline]),
      'request_json_invalid',
    );
    if (!cancelled.ok) result = cancelled;
  }
  if (timer) clearTimeout(timer);
  const released = captureSync(() => reader.releaseLock(), 'request_json_invalid');
  return released.ok ? result : released;
}
