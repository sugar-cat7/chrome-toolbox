import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNotes } from '../src/client/notes';

afterEach(() => vi.unstubAllGlobals());
describe('browser adapter contract', () => {
  it('does not turn API failures into successful empty data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    await expect(browserNotes.list()).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
  it('rejects invalid server data before presenting it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([{ id: 'invalid' }])));
    await expect(browserNotes.list()).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
});
