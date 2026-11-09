// llama.cpp as a fake `fetch` for the background's tests, built on the llama stub's replies (its
// page batch and its PLaMo), so no test reaches a real model server.
import {
  defaultResponder,
  withPlamo,
  type Responder,
  type StubChat,
  type StubReply,
  type StubRequest,
} from '@chrome-toolbox/extension-core/testing';
import type { Fetch } from '@chrome-toolbox/extension-core';

/** One request the fake server got: its path, the model it names and its chat body. */
export type Call = Readonly<{
  path: string;
  model: string | undefined;
  chat: StubChat | undefined;
  signal: AbortSignal | undefined;
}>;
/**
 * The fake router, read at each request: every model's slot count (`down`: `/props` answers 503),
 * whether `/v1/models` lists PLaMo and serves it (`withPlamo`), or fails.
 */
export type ServerState = {
  slots: Record<string, number | 'down'>;
  plamo: boolean;
  models: 'up' | 'down';
};
export type Server = {
  fetch: Fetch;
  calls: Call[];
  state: ServerState;
  /** The chat bodies sent to `model`, in order. */
  chats(this: void, model: string): StubChat[];
  /** The `/props` and `/v1/models` requests, as `<path>[?model]`. */
  asked(this: void): string[];
  /** Most chats of `model` that ran at once. */
  peak(this: void, model: string): number;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStubChat = (value: unknown): value is Omit<StubChat, 'audio'> =>
  isRecord(value) && Array.isArray(value['messages']);
/** Rejects once `signal` aborts, as `fetch` does. */
const aborted = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/**
 * llama.cpp as a fake `fetch`: the llama stub's page batch (`訳:` + each text) for Gemma and its
 * PLaMo (`訳P:` + the line) when listed, `total_slots` 3 per model unless `state` says other.
 * `respond` may answer a chat first (`undefined`: the stub answers); `door` holds a chat until
 * it resolves (the fetch's signal still aborts it).
 */
export function llama({
  state: initial = {},
  respond,
  door,
  propsDoor,
}: {
  state?: Partial<ServerState>;
  respond?: (chat: StubChat) => StubReply | undefined;
  door?: (chat: StubChat) => Promise<void>;
  /** Holds every `/props` answer until it resolves (the fetch's signal still aborts it). */
  propsDoor?: () => Promise<void>;
} = {}): Server {
  const state: ServerState = { slots: {}, plamo: true, models: 'up', ...initial };
  const calls: Call[] = [];
  const active = new Map<string, number>();
  const peaks = new Map<string, number>();
  const stub: Responder = (request) =>
    (state.plamo ? withPlamo(defaultResponder) : defaultResponder)(request);
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const chat: StubChat | undefined = isStubChat(body) ? { ...body, audio: 0 } : undefined;
    const model = chat?.model ?? url.searchParams.get('model') ?? undefined;
    calls.push({ path: url.pathname, model, chat, signal: init?.signal ?? undefined });
    if (url.pathname === '/props') {
      await Promise.race([propsDoor?.() ?? Promise.resolve(), aborted(init?.signal ?? undefined)]);
      const total = state.slots[model ?? ''] ?? 3;
      return total === 'down'
        ? Response.json({ error: { code: 503 } }, { status: 503 })
        : Response.json({ total_slots: total });
    }
    if (url.pathname === '/v1/models' && state.models === 'down')
      return Response.json({ error: { code: 503 } }, { status: 503 });
    const request: StubRequest = { method: init?.method ?? 'GET', path: url.pathname, body, chat };
    if (chat === undefined) return answer(await stub(request));
    const name = chat.model ?? '';
    active.set(name, (active.get(name) ?? 0) + 1);
    peaks.set(name, Math.max(peaks.get(name) ?? 0, active.get(name) ?? 0));
    try {
      await Promise.race([door?.(chat) ?? Promise.resolve(), aborted(init?.signal ?? undefined)]);
    } finally {
      active.set(name, (active.get(name) ?? 1) - 1);
    }
    return answer(respond?.(chat) ?? (await stub(request)));
  };
  return {
    fetch,
    calls,
    state,
    chats: (model) =>
      calls.flatMap((call) => (call.chat !== undefined && call.model === model ? [call.chat] : [])),
    asked: () =>
      calls
        .filter((call) => call.chat === undefined)
        .map((call) => `${call.path}${call.path === '/props' ? `?${call.model}` : ''}`),
    peak: (model) => peaks.get(model) ?? 0,
  };
}
const answer = (reply: StubReply): Response =>
  Response.json(reply.body, { status: reply.status ?? 200 });

/** A gate a test opens to let held chats answer. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
/** A short wait, so that held chats overlap. */
export const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
