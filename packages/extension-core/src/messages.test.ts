import { describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { z } from 'zod/mini';
import { defineProtocol, llmHandlers, llmProtocol, llmProtocolSpec } from './messages.ts';
import { createQueue } from './queue.ts';
import { connectionPort, type HostPermissions } from './connection.ts';
import { defaultSettings, settingsStore, type StorageArea } from './settings.ts';

const code = (result: Result<unknown>): string => (result.ok ? 'ok' : result.error.internalCode);
const memoryArea = (): StorageArea & { items: Record<string, unknown> } => {
  const items: Record<string, unknown> = {};
  return {
    items,
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    set: async (values) => {
      Object.assign(items, values);
    },
  };
};

const echo = defineProtocol({
  'x/echo': {
    request: z.strictObject({ n: z.number() }),
    response: z.strictObject({ n: z.number() }),
  },
});

describe('extension message protocol', () => {
  it.each([
    { message: { type: 'x/echo', payload: { n: 1 } }, expected: Ok({ n: 1 }) },
    { message: { type: 'x/echo', payload: { n: 'a' } }, expected: 'input_invalid' },
    { message: { type: 'x/echo', payload: { n: 1, extra: true } }, expected: 'input_invalid' },
    { message: { type: 'x/echo' }, expected: 'input_invalid' },
    { message: { type: 'nope', payload: {} }, expected: 'input_invalid' },
    { message: { type: 'toString', payload: {} }, expected: 'input_invalid' },
    { message: 'x/echo', expected: 'input_invalid' },
  ])('routes $message', async ({ message, expected }) => {
    const handler = vi.fn<(req: { n: number }) => Promise<Result<{ n: number }>>>(async (req) =>
      Ok(req),
    );
    const route = echo.route({ 'x/echo': handler });
    const result = await route(message);
    expect(typeof expected === 'string' ? !result.ok && result.error.internalCode : result).toEqual(
      expected,
    );
    expect(handler).toHaveBeenCalledTimes(typeof expected === 'string' ? 0 : 1);
  });

  it('send wraps the request as { type, payload }', async () => {
    const send = vi.fn<(message: unknown) => Promise<unknown>>(async () => Ok({ n: 2 }));
    expect(await echo.send(send, 'x/echo', { n: 2 })).toEqual(Ok({ n: 2 }));
    expect(send).toHaveBeenCalledWith({ type: 'x/echo', payload: { n: 2 } });
  });

  it('send decodes the remote Result envelope including failures', async () => {
    const remote = echo.route({
      'x/echo': async () => Err(failure('queue_full', 'd'.repeat(32))),
    });
    const result = await echo.send(remote, 'x/echo', { n: 1 });
    expect(code(result)).toBe('queue_full');
    expect(!result.ok && result.error.diagnosticId).toBe('d'.repeat(32));
  });

  it.each([
    { name: 'success', reply: Ok({ models: ['m'] }), expected: 'ok' },
    {
      name: 'failure',
      reply: Err(failure('network_failed', 'a'.repeat(32))),
      expected: 'network_failed',
    },
    {
      name: 'malformed',
      reply: { ok: true, value: { models: 'm' } },
      expected: 'response_invalid',
    },
    {
      name: 'unknown code',
      reply: { ok: false, error: { internalCode: 'x', diagnosticId: 'y' } },
      expected: 'response_invalid',
    },
  ])('decodes a $name response', async ({ reply, expected }) => {
    const result = await llmProtocol.send(async () => reply, 'llm/status', {
      baseUrl: 'http://127.0.0.1:8080',
    });
    expect(code(result)).toBe(expected);
    // A background failure keeps its diagnostic ID; local decode failures mint a new one.
    expect(!result.ok && result.error.diagnosticId === 'a'.repeat(32)).toBe(
      expected === 'network_failed',
    );
  });

  it('reports a closed receiver as an IPC failure', async () => {
    const result = await llmProtocol.send(
      () => Promise.reject(new Error('no receiver')),
      'llm/status',
      { baseUrl: 'http://127.0.0.1:8080' },
    );
    expect(code(result)).toBe('ipc_failed');
  });

  it('answers status from the shared llm handlers', async () => {
    const route = llmProtocol.route(
      llmHandlers({
        queue: createQueue(),
        fetch: async (input) =>
          new URL(input).pathname === '/health'
            ? Response.json({ status: 'ok' })
            : Response.json({ data: [{ id: 'gemma' }] }),
      }),
    );
    expect(await route({ type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:9' } })).toEqual(
      Ok({ models: ['gemma'] }),
    );
  });

  it('lets an extension spread the shared handlers into its own protocol', async () => {
    const own = defineProtocol({
      ...llmProtocolSpec,
      'x/echo': {
        request: z.strictObject({ n: z.number() }),
        response: z.strictObject({ n: z.number() }),
      },
    });
    const route = own.route({
      ...llmHandlers({ queue: createQueue(), fetch: async () => Response.json({}) }),
      'x/echo': async (req) => Ok(req),
    });
    expect(await route({ type: 'x/echo', payload: { n: 3 } })).toEqual(Ok({ n: 3 }));
  });
});

describe('settings and side panel connection port', () => {
  it('loads defaults, normalizes saved URLs and rejects invalid ones', async () => {
    const area = memoryArea();
    const store = settingsStore(area);
    expect(await store.load()).toEqual(Ok(defaultSettings));
    expect(
      await store.save({ ...defaultSettings, llamaBaseUrl: 'http://192.0.2.20:8080/' }),
    ).toEqual(Ok({ ...defaultSettings, llamaBaseUrl: 'http://192.0.2.20:8080' }));
    expect(code(await store.save({ ...defaultSettings, llamaBaseUrl: 'file:///etc' }))).toBe(
      'input_invalid',
    );
    expect(await store.load()).toEqual(
      Ok({ ...defaultSettings, llamaBaseUrl: 'http://192.0.2.20:8080' }),
    );
    const broken = settingsStore({ ...area, get: () => Promise.reject(new Error('quota')) });
    expect(code(await broken.load())).toBe('storage_failed');
  });

  it.each([
    { name: 'already granted', contains: true, request: false, expected: 'ok', prompted: false },
    { name: 'granted on prompt', contains: false, request: true, expected: 'ok', prompted: true },
    {
      name: 'denied on prompt',
      contains: false,
      request: false,
      expected: 'host_permission_denied',
      prompted: true,
    },
  ])('checks a LAN host that is $name', async ({ contains, request, expected, prompted }) => {
    const area = memoryArea();
    const permissions = {
      contains: vi.fn<HostPermissions['contains']>(async () => contains),
      request: vi.fn<HostPermissions['request']>(async () => request),
    };
    const send = vi.fn<(message: unknown) => Promise<unknown>>(async () =>
      Ok({ models: ['qwen'] }),
    );
    const port = connectionPort({ settings: settingsStore(area), permissions, send });
    const result = await port.check('http://192.0.2.20:8080');
    expect(code(result)).toBe(expected);
    expect(permissions.request).toHaveBeenCalledTimes(prompted ? 1 : 0);
    expect(permissions.contains).toHaveBeenCalledWith({ origins: ['http://192.0.2.20/*'] });
    expect(send).toHaveBeenCalledTimes(expected === 'ok' ? 1 : 0);
    expect(area.items.settings).toEqual(
      expected === 'ok'
        ? { ...defaultSettings, llamaBaseUrl: 'http://192.0.2.20:8080' }
        : undefined,
    );
  });
});
