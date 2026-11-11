import { z } from 'zod/mini';
import { captureSync, decode, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { createQueue, type Queue } from './queue.ts';
import { createFetchTransport, type FetchOptions } from './transport.ts';

export type { Fetch, ResultFetch } from './transport.ts';
export type ChatMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
/** One part of a multi-part message (OpenAI `content` array); `data` is WAV as plain base64. */
export type ChatContentPart =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'input_audio'; input_audio: Readonly<{ data: string; format: 'wav' }> }>;
/** A user message made of parts, e.g. text plus audio; `ChatMessage` stays text-only. */
export type ChatPartsMessage = Readonly<{ role: 'user'; content: readonly ChatContentPart[] }>;
export type ChatRequest = Readonly<{
  messages: readonly (ChatMessage | ChatPartsMessage)[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** llama-server slot to pin the request to (`id_slot`). */
  slot?: number;
  /** Reuse the cached prompt prefix (`cache_prompt`); defaults to true. */
  cachePrompt?: boolean;
  /** JSON Schema constraining the reply (`response_format`). */
  jsonSchema?: Record<string, unknown>;
  /** GBNF grammar constraining the reply (llama-server `grammar`); not combined with `jsonSchema`. */
  grammar?: string;
  /** Extra chat-template variables (`chat_template_kwargs`), e.g. `{ enable_thinking: false }`. */
  templateKwargs?: Record<string, unknown>;
  /** Strings that end the reply (`stop`); the key is left out when absent. */
  stop?: readonly string[];
  /**
   * Report an HTTP 4xx/5xx answer as `model_refused` instead of `network_failed`, so a caller
   * can tell a server that answered "no" from one it cannot reach.
   */
  tellRefusal?: boolean;
  signal?: AbortSignal;
}>;
export type ChatTiming = Readonly<{
  promptMs: number;
  predictedMs: number;
  predictedTokens: number;
}>;
/** A chat reply; `finishReason` is llama-server's `finish_reason` (`stop`, `length`) when sent. */
export type ChatReply = Readonly<{
  text: string;
  timing: ChatTiming | undefined;
  finishReason: string | undefined;
}>;
export const connectionStatusSchema = z.strictObject({ models: z.array(z.string()) });
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
/** `audio` is `modalities.audio` (an audio projector is loaded); undefined when not reported. */
export type ServerProps = Readonly<{ totalSlots: number; audio: boolean | undefined }>;
/** One slot of `GET /slots`: its `id` and whether it is generating now (`is_processing`). */
export type SlotState = Readonly<{ id: number; processing: boolean }>;
export type LlamaClient = {
  health(this: void, signal?: AbortSignal): Promise<Result<void>>;
  models(this: void, signal?: AbortSignal): Promise<Result<string[]>>;
  /**
   * `GET /props`; `totalSlots` is the server's `--parallel` slot count. A llama.cpp router
   * answers with its own info (no `total_slots`) unless `model` selects `/props?model=<name>`.
   */
  props(
    this: void,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<Result<ServerProps>>;
  /**
   * `GET /slots` (`/slots?model=<name>` on a router): each slot's `id` and `is_processing` at
   * this instant. Not queued behind chats. A server without the endpoint (`--no-slots`) answers
   * an HTTP error: `network_failed`.
   */
  slots(
    this: void,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<Result<readonly SlotState[]>>;
  status(this: void, signal?: AbortSignal): Promise<Result<ConnectionStatus>>;
  chat(this: void, request: ChatRequest): Promise<Result<ChatReply>>;
  chatJson<T>(
    this: void,
    request: ChatRequest & { jsonSchema: Record<string, unknown> },
    output: z.ZodMiniType<T>,
  ): Promise<Result<{ value: T; timing: ChatTiming | undefined }>>;
};

// llama-server answers 200 {"status":"ok"} once a model is loaded and 503 while loading.
const healthSchema = z.object({ status: z.literal('ok') });
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const propsSchema = z.object({
  total_slots: z.int().check(z.nonnegative()),
  modalities: z.optional(z.object({ audio: z.optional(z.boolean()) })),
});
// Only id and is_processing are read; params, next_token and the rest are dropped.
const slotsSchema = z.array(
  z.object({ id: z.int().check(z.nonnegative()), is_processing: z.boolean() }),
);
// What llama-server answers (HTTP 400) to input_audio when no audio projector is loaded.
const audioUnsupportedSchema = z.object({
  error: z.object({ message: z.string().check(z.includes('audio input is not supported')) }),
});
const chatSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        // Read leniently like timings: a missing or odd reason never fails a usable reply.
        finish_reason: z.optional(z.unknown()),
      }),
    )
    .check(z.minLength(1)),
  // Decoded on its own: diagnostics must never turn a usable reply into a failure.
  timings: z.optional(z.unknown()),
});
const timingsSchema = z.object({
  prompt_ms: z.number(),
  predicted_ms: z.number(),
  predicted_n: z.number(),
});

/**
 * Whether `max_tokens` may have stopped the reply: llama-server says `length`, or, without a
 * finish reason, the reply used the whole budget or reported no timings.
 */
export function cutByMaxTokens(
  reply: Readonly<{ finishReason: string | undefined; timing: ChatTiming | undefined }>,
  maxTokens: number,
): boolean {
  if (reply.finishReason !== undefined) return reply.finishReason === 'length';
  return (reply.timing?.predictedTokens ?? maxTokens) >= maxTokens;
}

/** Normalizes a user-entered llama.cpp origin; only plain HTTP(S) origins are accepted. */
export function parseBaseUrl(input: string): Result<string> {
  const parsed = captureSync(() => new URL(input.trim()), 'input_invalid');
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return Err(failure('input_invalid'));
  return Ok(`${url.origin}${url.pathname.replace(/\/+$/u, '')}`);
}

/** Chrome host permission pattern for a base URL; match patterns ignore the port. */
export function hostPattern(baseUrl: string): Result<string> {
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed.ok) return parsed;
  return Ok(`${new URL(parsed.value).protocol}//${new URL(parsed.value).hostname}/*`);
}

export function createLlamaClient(
  options: FetchOptions & {
    baseUrl: string;
    timeoutMs?: number;
    queue?: Queue;
  },
): LlamaClient {
  const { baseUrl, timeoutMs = 10_000, queue = createQueue() } = options;
  const transport = createFetchTransport(options);
  async function request<T>(
    schema: z.ZodMiniType<T>,
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    tellRefusal = false,
  ): Promise<Result<T>> {
    const origin = parseBaseUrl(baseUrl);
    if (!origin.ok) return origin;
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await transport.request(`${origin.value}${path}`, {
      ...init,
      signal: requestSignal,
    });
    if (signal?.aborted) return Err(failure('operation_cancelled'));
    if (!response.ok) return response;
    if (!response.value.ok) {
      // The body is read only to tell the no-projector 400; every other answer ignores it.
      if (response.value.status === 400) {
        const text = await transport.text(response.value, requestSignal);
        const parsed = text.ok
          ? captureSync((): unknown => JSON.parse(text.value), 'response_invalid')
          : text;
        if (signal?.aborted) return Err(failure('operation_cancelled'));
        if (parsed.ok && decode(audioUnsupportedSchema, parsed.value).ok)
          return Err(failure('audio_unsupported'));
      }
      return Err(failure(tellRefusal ? 'model_refused' : 'network_failed'));
    }
    const body = await transport.json(response.value, requestSignal);
    if (signal?.aborted) return Err(failure('operation_cancelled'));
    if (!body.ok) return body;
    return decode(schema, body.value);
  }
  async function health(signal?: AbortSignal): Promise<Result<void>> {
    const result = await request(healthSchema, '/health', { method: 'GET' }, signal);
    return result.ok ? Ok(undefined) : result;
  }
  async function models(signal?: AbortSignal): Promise<Result<string[]>> {
    const result = await request(modelsSchema, '/v1/models', { method: 'GET' }, signal);
    return result.ok ? Ok(result.value.data.map((model) => model.id)) : result;
  }
  async function props({ model, signal }: { model?: string; signal?: AbortSignal } = {}): Promise<
    Result<ServerProps>
  > {
    const path = model === undefined ? '/props' : `/props?model=${encodeURIComponent(model)}`;
    const result = await request(propsSchema, path, { method: 'GET' }, signal);
    return result.ok
      ? Ok({ totalSlots: result.value.total_slots, audio: result.value.modalities?.audio })
      : result;
  }
  async function slots({ model, signal }: { model?: string; signal?: AbortSignal } = {}): Promise<
    Result<readonly SlotState[]>
  > {
    const path = model === undefined ? '/slots' : `/slots?model=${encodeURIComponent(model)}`;
    const result = await request(slotsSchema, path, { method: 'GET' }, signal);
    return result.ok
      ? Ok(result.value.map((slot) => ({ id: slot.id, processing: slot.is_processing })))
      : result;
  }
  async function status(signal?: AbortSignal): Promise<Result<ConnectionStatus>> {
    const alive = await health(signal);
    if (!alive.ok) return alive;
    const available = await models(signal);
    return available.ok ? Ok({ models: available.value }) : available;
  }
  function chat(input: ChatRequest): Promise<Result<ChatReply>> {
    return queue.run(async (signal): Promise<Result<ChatReply>> => {
      const result = await request(
        chatSchema,
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: input.messages,
            stream: false,
            cache_prompt: input.cachePrompt ?? true,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.slot === undefined ? {} : { id_slot: input.slot }),
            ...(input.templateKwargs === undefined
              ? {}
              : { chat_template_kwargs: input.templateKwargs }),
            ...(input.stop === undefined ? {} : { stop: input.stop }),
            ...(input.grammar === undefined ? {} : { grammar: input.grammar }),
            ...(input.jsonSchema === undefined
              ? {}
              : {
                  response_format: {
                    type: 'json_schema',
                    json_schema: { name: 'output', schema: input.jsonSchema },
                  },
                }),
          }),
        },
        signal,
        input.tellRefusal,
      );
      if (!result.ok) return result;
      const timings = decode(timingsSchema, result.value.timings);
      const finishReason = result.value.choices[0]?.finish_reason;
      return Ok({
        text: result.value.choices[0]?.message.content ?? '',
        finishReason: typeof finishReason === 'string' ? finishReason : undefined,
        timing: timings.ok
          ? {
              promptMs: timings.value.prompt_ms,
              predictedMs: timings.value.predicted_ms,
              predictedTokens: timings.value.predicted_n,
            }
          : undefined,
      });
    }, input.signal);
  }
  async function chatJson<T>(
    input: ChatRequest & { jsonSchema: Record<string, unknown> },
    output: z.ZodMiniType<T>,
  ): Promise<Result<{ value: T; timing: ChatTiming | undefined }>> {
    const reply = await chat(input);
    if (!reply.ok) return reply;
    const parsed = captureSync((): unknown => JSON.parse(reply.value.text), 'response_invalid');
    if (!parsed.ok) return parsed;
    const decoded = decode(output, parsed.value);
    return decoded.ok ? Ok({ value: decoded.value, timing: reply.value.timing }) : decoded;
  }
  return { health, models, props, slots, status, chat, chatJson };
}
