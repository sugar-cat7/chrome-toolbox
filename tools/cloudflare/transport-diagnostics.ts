import { channel } from 'node:diagnostics_channel';

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value) ? value : null;

console.error('WORKER_TRANSPORT_DIAGNOSTIC_READY');

// Opt-in SDK subprocess diagnostics: identifiers only, never URLs, headers,
// request bodies, exception messages, stacks or socket addresses.
channel('undici:request:error').subscribe((message: unknown) => {
  const error = record(record(message).error);
  const cause = record(error.cause);
  console.error(
    'WORKER_TRANSPORT_DIAGNOSTIC',
    JSON.stringify({
      name: identifier(error.name),
      code: identifier(error.code),
      cause: { code: identifier(cause.code) },
      socketPresent: Boolean(error.socket ?? cause.socket),
    }),
  );
});
