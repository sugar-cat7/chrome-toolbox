import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeRelay } from '../src/native';
import { publicFailure, failure } from '@chrome-toolbox/contracts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn<typeof invoke>() }));
describe('minimal relay control adapter', () => {
  it('validates status returned by the native boundary', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ source: 'reading', unexpected: true });
    await expect(nativeRelay.status()).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
  it('propagates the generated public error without exposing a native cause', async () => {
    const error = publicFailure(failure('relay_settings_corrupt'));
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(nativeRelay.status()).resolves.toEqual({ ok: false, error });
  });
  it('checks a connection only on explicit invocation and sends no URL or headers', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      health: { status: 200, headers: {}, body: '{"status":"ok"}' },
      models: { status: 503, headers: {}, body: 'not ready' },
    });
    await expect(nativeRelay.check()).resolves.toMatchObject({
      ok: true,
      value: { models: { status: 503 } },
    });
    expect(invoke).toHaveBeenLastCalledWith('check_connection');
  });
});
