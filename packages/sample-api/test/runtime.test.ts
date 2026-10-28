import { describe, expect, it } from 'vitest';
import { noteSchema, notesSchema } from '@starter/contracts';

const origin = process.env.STARTER_TEST_ORIGIN;
if (!origin) throw new Error('Use pnpm test:runtime to start real workerd before HTTP tests');
const fetchLocal = (route: string, init?: RequestInit) => fetch(new URL(route, origin), init);
const fetchStatus = async (route: string, init?: RequestInit) => {
  const response = await fetchLocal(route, init);
  await response.arrayBuffer();
  return response.status;
};

describe('real workerd HTTP contract', () => {
  it('serves health, validates input and completes CRUD', async () => {
    expect(await fetchStatus('/health')).toBe(200);
    const invalid = await fetchLocal('/api/notes', { method: 'POST', body: '{"text":""}' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_input' } });
    const added = await fetchLocal('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ text: 'Runtime note' }),
    });
    expect(added.status).toBe(201);
    const note = noteSchema.parse(await added.json());
    const listed = await fetchLocal('/api/notes');
    expect(listed.headers.get('x-storage-mode')).toBe('volatile-sample');
    expect(notesSchema.parse(await listed.json())).toContainEqual(note);
    expect(await fetchStatus(`/api/notes/${note.id}`, { method: 'DELETE' })).toBe(204);
    expect(await fetchStatus(`/api/notes/${note.id}`, { method: 'DELETE' })).toBe(404);
    expect(await fetchStatus('/api/notes/not-a-uuid', { method: 'DELETE' })).toBe(400);
  });
  it('enforces the normalized UTF-16 text boundary over real HTTP', async () => {
    const text = '😀'.repeat(500);
    const added = await fetchLocal('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ text: `\uFEFF${text}\uFEFF` }),
    });
    expect(added.status).toBe(201);
    const note = noteSchema.parse(await added.json());
    expect(note.text).toBe(text);
    expect(await fetchStatus(`/api/notes/${note.id}`, { method: 'DELETE' })).toBe(204);
    for (const text of ['😀'.repeat(501), `${'😀'.repeat(500)}x`]) {
      const invalid = await fetchLocal('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ text: `\uFEFF${text}\uFEFF` }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_input' } });
    }
  });
  it('exercises only the selected KV and R2 bindings, and refuses absent features', async () => {
    for (const [feature, selected] of [
      ['kv', false],
      ['r2', false],
    ] as const) {
      const response = await fetchLocal(`/extensions/${feature}`, {
        method: 'POST',
        body: JSON.stringify({ key: 'runtime-test', value: 'stored locally' }),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(selected ? 200 : 404);
      const read = await fetchLocal(`/extensions/${feature}?key=runtime-test`);
      const body = await read.text();
      if (read.status !== (selected ? 200 : 404))
        console.error(`Unexpected ${feature} GET status ${read.status}: ${body}`);
      expect(read.status).toBe(selected ? 200 : 404);
      expect(JSON.parse(body)).toMatchObject(
        selected ? { value: 'stored locally' } : { error: { code: 'not_found' } },
      );
    }
  });
  it('keeps the next request usable after oversized and absent-feature JSON ingress', async () => {
    const oversized = await fetchLocal('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ text: 'x' }).padEnd(32769, ' '),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: 'invalid_input' } });
    for (const [feature, selected] of [
      ['kv', false],
      ['r2', false],
    ] as const) {
      const invalid = await fetchLocal(`/extensions/${feature}`, {
        method: 'POST',
        body: 'INVALID-JSON',
      });
      expect(invalid.status).toBe(selected ? 400 : 404);
      expect(await invalid.json()).toMatchObject({
        error: { code: selected ? 'invalid_json' : 'not_found' },
      });
      const health = await fetchLocal('/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });
    }
  });
});
