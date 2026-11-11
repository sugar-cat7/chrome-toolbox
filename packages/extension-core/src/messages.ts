import { z } from 'zod/mini';
import {
  capture,
  decode,
  Err,
  failure,
  INTERNAL_ERRORS,
  Ok,
  type InternalErrorCode,
  type Result,
} from '@chrome-toolbox/contracts';
import { connectionStatusSchema, createLlamaClient, type Fetch } from './llm.ts';
import type { Queue } from './queue.ts';

// Every message crossing extension contexts is decoded on both sides. Responses
// carry the serializable Result itself, so failures keep their diagnostic ID.
// Each extension defines its own protocol: a map from message type to the
// request and response schemas, sent as { type, payload }.
export type ProtocolSpec = Record<string, { request: z.ZodMiniType; response: z.ZodMiniType }>;
export type ProtocolHandlers<P extends ProtocolSpec> = {
  [K in keyof P]: (request: z.infer<P[K]['request']>) => Promise<Result<z.infer<P[K]['response']>>>;
};
export type Protocol<P extends ProtocolSpec> = {
  route(handlers: ProtocolHandlers<P>): (message: unknown) => Promise<Result<unknown>>;
  send<K extends keyof P>(
    send: (message: unknown) => Promise<unknown>,
    type: K,
    request: z.infer<P[K]['request']>,
  ): Promise<Result<z.infer<P[K]['response']>>>;
};

const internalCodes = Object.keys(INTERNAL_ERRORS) as [InternalErrorCode, ...InternalErrorCode[]];
const envelope = z.union([
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ internalCode: z.enum(internalCodes), diagnosticId: z.string() }),
  }),
]);
// The one cast of the decode boundary: a schema reached through a generic key is only
// bounded by ZodMiniType, so TypeScript cannot carry z.infer<S> out of safeParse.
function decodeAs<S extends z.ZodMiniType>(
  schema: S,
  input: unknown,
  code: InternalErrorCode,
): Result<z.infer<S>> {
  const parsed = schema.safeParse(input);
  return parsed.success ? Ok(parsed.data as z.infer<S>) : Err(failure(code));
}
const messageSchema = z.object({ type: z.string(), payload: z.unknown() });

export function defineProtocol<P extends ProtocolSpec>(protocol: P): Protocol<P> {
  const isType = (type: string): type is Extract<keyof P, string> => Object.hasOwn(protocol, type);
  return {
    route: (handlers) => {
      async function dispatch<K extends Extract<keyof P, string>>(
        type: K,
        payload: unknown,
      ): Promise<Result<unknown>> {
        const spec: P[K] | undefined = protocol[type];
        if (spec === undefined) return Err(failure('input_invalid'));
        const request = decodeAs<P[K]['request']>(spec.request, payload, 'input_invalid');
        return request.ok ? handlers[type](request.value) : request;
      }
      return async function route(message: unknown): Promise<Result<unknown>> {
        const parsed = messageSchema.safeParse(message);
        if (!parsed.success || !isType(parsed.data.type)) return Err(failure('input_invalid'));
        return dispatch(parsed.data.type, parsed.data.payload);
      };
    },
    send: async function send<K extends keyof P>(
      send: (message: unknown) => Promise<unknown>,
      type: K,
      request: z.infer<P[K]['request']>,
    ): Promise<Result<z.infer<P[K]['response']>>> {
      const response = await capture(() => send({ type, payload: request }), 'ipc_failed');
      if (!response.ok) return response;
      const spec: P[K] | undefined = protocol[type];
      if (spec === undefined) return Err(failure('input_invalid'));
      const decoded = decode(envelope, response.value);
      if (!decoded.ok) return decoded;
      if (!decoded.value.ok) {
        return Err(failure(decoded.value.error.internalCode, decoded.value.error.diagnosticId));
      }
      return decodeAs<P[K]['response']>(spec.response, decoded.value.value, 'response_invalid');
    },
  };
}

export const llmProtocolSpec = {
  'llm/status': {
    request: z.strictObject({ baseUrl: z.string() }),
    response: connectionStatusSchema,
  },
};
/** The messages every extension's service worker answers. */
export const llmProtocol = defineProtocol(llmProtocolSpec);

/** Handlers for llmProtocol; each extension spreads them into its own handlers. */
export function llmHandlers({
  fetch,
  queue,
}: {
  fetch: Fetch;
  queue: Queue;
}): ProtocolHandlers<typeof llmProtocolSpec> {
  return {
    'llm/status': (request) =>
      createLlamaClient({ baseUrl: request.baseUrl, fetch, queue }).status(),
  };
}
