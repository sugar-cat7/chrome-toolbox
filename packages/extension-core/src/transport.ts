import {
  capture,
  captureSync,
  Err,
  failure,
  Ok,
  type AppError,
  type Result,
} from '@chrome-toolbox/contracts';

/** The legacy browser fetch port; synchronous throws and rejections are normalized at ingress. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
/** Native adapters return transport failures as values; HTTP errors remain successful Responses. */
export type ResultFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Result<Response, AppError>>;
/** Selects the Result port explicitly so legacy fetch keeps its original settlement timing. */
export type FetchOptions =
  | Readonly<{ fetch: Fetch; resultFetch?: never }>
  | Readonly<{ fetch?: never; resultFetch: ResultFetch }>;

/** Normalizes browser exceptions at SDK ingress without adding an asynchronous wrapper. */
export function normalizeFetch(fetch: Fetch): ResultFetch {
  return (input, init) => capture(() => fetch(input, init), 'network_failed');
}

/** Keeps legacy Body methods intact while bounding ResultFetch adapter bodies. */
export function createFetchTransport(options: FetchOptions) {
  const native = options.resultFetch;
  if (native !== undefined)
    return {
      request: async (input: string, init?: RequestInit): Promise<Result<Response>> => {
        const captured = await capture(() => native(input, init), 'network_failed');
        return captured.ok ? captured.value : captured;
      },
      text: readResponseText,
      json: readResponseJson,
    };
  return {
    request: normalizeFetch(options.fetch),
    text(response: Response, _signal?: AbortSignal): Promise<Result<string>> {
      return capture(() => response.text(), 'response_invalid');
    },
    json(response: Response, _signal?: AbortSignal): Promise<Result<unknown>> {
      return capture((): Promise<unknown> => response.json(), 'response_invalid');
    },
  };
}

/** The native inference boundary and shared parsers accept at most 64 KiB of response bytes. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Bounds streamed bytes before decoding; overflow, read failure and abort cancel the body. */
export async function readResponseText(
  response: Response,
  signal?: AbortSignal,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Result<string>> {
  if (signal?.aborted) return Err(failure('operation_cancelled'));
  if (response.body === null) return Ok('');
  const acquired = captureSync(() => response.body!.getReader(), 'response_invalid');
  if (!acquired.ok) return acquired;
  const reader = acquired.value;
  let cancellation: Promise<Result<void>> | undefined;
  const cancel = (): void => {
    cancellation ??= capture(() => reader.cancel(), 'response_invalid');
  };
  signal?.addEventListener('abort', cancel, { once: true });
  // One SDK ingress owns the whole read, rather than adding a Promise/listener per chunk.
  const captured = await capture(async (): Promise<Result<string>> => {
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    for (;;) {
      const chunk = await reader.read();
      if (signal?.aborted) return Err(failure('operation_cancelled'));
      if (chunk.done) return Ok(text + decoder.decode());
      size += chunk.value.byteLength;
      if (size > maxBytes) return Err(failure('response_invalid'));
      text += decoder.decode(chunk.value, { stream: true });
    }
  }, 'response_invalid');
  signal?.removeEventListener('abort', cancel);
  let result = captured.ok ? captured.value : captured;
  if (!result.ok) cancel();
  if (cancellation) {
    const cancelled = await cancellation;
    if (!cancelled.ok) result = cancelled;
  }
  const released = captureSync(() => reader.releaseLock(), 'response_invalid');
  return released.ok ? result : released;
}

/** Decodes bounded JSON without allowing syntax exceptions across a client boundary. */
export async function readResponseJson(
  response: Response,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  const text = await readResponseText(response, signal);
  return text.ok ? captureSync((): unknown => JSON.parse(text.value), 'response_invalid') : text;
}
