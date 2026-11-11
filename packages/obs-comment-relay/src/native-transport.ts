import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod/mini';
import {
  capturePublic,
  captureSync,
  decode,
  Err,
  failure,
  launch,
  Ok,
  type AppError,
  type Result,
} from '@chrome-toolbox/contracts';
import type { ResultFetch } from '@chrome-toolbox/extension-core';

const httpReplySchema = z.strictObject({
  status: z.int().check(z.gte(100), z.lte(599)),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
type HttpReply = z.infer<typeof httpReplySchema>;

const OPERATIONS = {
  '/health': 'health',
  '/v1/models': 'models',
  '/models': 'models',
  '/v1/systemone': 'clef',
  '/v1/chat/completions': 'plamo',
} as const;
type Operation = (typeof OPERATIONS)[keyof typeof OPERATIONS];

function operationFor(input: string): Result<Operation> {
  const url = captureSync(() => new URL(input), 'input_invalid');
  if (!url.ok) return Err(url.error);
  const operation = OPERATIONS[url.value.pathname as keyof typeof OPERATIONS];
  return operation ? Ok(operation) : Err(failure('input_invalid'));
}

const NULL_BODY = new Set([101, 204, 205, 304]);

function toResponse(reply: HttpReply): Response {
  return new Response(NULL_BODY.has(reply.status) ? null : reply.body, {
    status: reply.status,
    headers: reply.headers,
  });
}

/**
 * ResultFetch over the native `llama_request` command: the URL path selects the allowlisted
 * operation and aborts cancel the reservation by request id. Nothing reaches the network
 * directly; the Rust proxy owns loopback, redirects and the 64 KiB reply bound.
 */
export const nativeResultFetch: ResultFetch = async (
  input,
  init,
): Promise<Result<Response, AppError>> => {
  const operation = operationFor(input);
  if (!operation.ok) return Err(operation.error);
  if (init?.signal?.aborted) return Err(failure('operation_cancelled'));

  let body: unknown;
  const raw = init?.body;
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = captureSync(() => JSON.parse(raw), 'request_json_invalid');
    if (!parsed.ok) return Err(parsed.error);
    body = parsed.value;
  }
  const requestId = crypto.randomUUID();
  const onAbort = () => {
    launch(
      async () => {
        await invoke('cancel_llama', { input: { requestId } });
      },
      () => undefined,
    );
  };
  init?.signal?.addEventListener('abort', onAbort, { once: true });
  const result = await capturePublic(
    () =>
      invoke<unknown>('llama_request', {
        input: { requestId, operation: operation.value, body: body ?? null },
      }),
    'ipc_failed',
  );
  init?.signal?.removeEventListener('abort', onAbort);
  if (!result.ok) return Err(failure('ipc_failed', result.error.diagnosticId));
  const reply = decode(httpReplySchema, result.value);
  if (!reply.ok) return Err(reply.error);
  if (init?.signal?.aborted) return Err(failure('operation_cancelled'));
  return captureSync(() => toResponse(reply.value), 'response_invalid');
};
