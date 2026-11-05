import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { benchMeta, writeResults } from './results.ts';

describe('bench results', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('records /props build info, git SHA and settings in the meta record', async () => {
    const urls: string[] = [];
    const meta = await benchMeta({
      bench: 'translate',
      server: 'http://127.0.0.1:8080/',
      model: 'qwen',
      settings: { temperature: 0 },
      fetch: (async (url: string) => {
        urls.push(url);
        return Response.json({
          build_info: 'b11475-7e8324f',
          model_path: '/models/q.gguf',
          total_slots: 2,
          chat_template: 'long template',
        });
      }) as typeof fetch,
    });
    expect(urls).toEqual(['http://127.0.0.1:8080/props']);
    expect(meta).toMatchObject({
      type: 'meta',
      bench: 'translate',
      server: 'http://127.0.0.1:8080/',
      model: 'qwen',
      serverProps: { build_info: 'b11475-7e8324f', model_path: '/models/q.gguf', total_slots: 2 },
      settings: { temperature: 0 },
    });
    expect(meta.serverProps).not.toHaveProperty('chat_template');
    expect(meta.gitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(Number.isNaN(Date.parse(meta.timestamp))).toBe(false);
  });

  it.each([
    { name: 'has no /props (whisper.cpp)', reply: () => new Response('', { status: 404 }) },
    {
      name: 'is unreachable',
      reply: (): Response => {
        throw new TypeError('fetch failed');
      },
    },
  ])('records null server props when the server $name', async ({ reply }) => {
    const meta = await benchMeta({
      bench: 'asr',
      server: 'http://127.0.0.1:8081',
      model: undefined,
      settings: {},
      fetch: (async () => reply()) as typeof fetch,
    });
    expect(meta).toMatchObject({ serverProps: null, model: null });
  });

  it('writes the meta record as the first JSONL line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-results-'));
    dirs.push(dir);
    const out = path.join(dir, 'nested', 'run.jsonl');
    const meta = await benchMeta({
      bench: 'clef',
      server: 'http://127.0.0.1:1',
      model: undefined,
      settings: {},
      fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    writeResults(out, meta, [{ id: 'a' }, { id: 'b' }]);
    const lines = readFileSync(out, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([meta, { id: 'a' }, { id: 'b' }]);
  });
});
