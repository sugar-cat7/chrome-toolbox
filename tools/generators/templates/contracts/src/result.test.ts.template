import { describe, expect, it } from 'vitest';
import {
  capture,
  captureSync,
  capturePublic,
  failure,
  publicFailure,
  decodePublicError,
  INTERNAL_ERRORS,
  PUBLIC_ERRORS,
  launch,
} from './index.ts';

describe('single-source failure and Result boundaries', () => {
  it('closes synchronous and asynchronous SDK throws without serializing raw exceptions', async () => {
    const secret = 'private request text and provider credentials';
    const sync = captureSync(() => {
      throw new Error(secret);
    }, 'export_failed');
    const async = await capture(() => Promise.reject(new Error(secret)), 'network_failed');
    const thrown = await capture(() => {
      throw secret;
    }, 'ipc_failed');
    expect(sync).toMatchObject({ ok: false, error: { internalCode: 'export_failed' } });
    expect(async).toMatchObject({ ok: false, error: { internalCode: 'network_failed' } });
    expect(thrown).toMatchObject({ ok: false, error: { internalCode: 'ipc_failed' } });
    expect(JSON.stringify([sync, async, thrown])).not.toContain(secret);
  });
  it('projects every internal code and accepts only the fixed public vocabulary', () => {
    for (const code of Object.keys(INTERNAL_ERRORS) as (keyof typeof INTERNAL_ERRORS)[]) {
      const error = failure(code);
      const wire = publicFailure(error);
      expect(wire.code).toBe(INTERNAL_ERRORS[code]);
      expect(wire.message).toBe(PUBLIC_ERRORS[wire.code].message);
      expect(wire.diagnosticId).toMatch(/^[a-f0-9]{32}$/u);
      expect(decodePublicError(wire)).toEqual({ ok: true, value: wire });
      expect(decodePublicError({ ...wire, message: 'raw private detail' }).ok).toBe(false);
      expect(decodePublicError({ ...wire, diagnosticId: 'invalid' }).ok).toBe(false);
      expect(decodePublicError({ ...wire, internalCode: code }).ok).toBe(false);
    }
  });
  it('preserves validated native JSON failures and replaces unknown rejections', async () => {
    const wire = publicFailure(failure('input_invalid'));
    expect(await capturePublic(() => Promise.reject(wire), 'ipc_failed')).toEqual({
      ok: false,
      error: wire,
    });
    expect(
      await capturePublic(() => Promise.reject({ ...wire, message: 'private' }), 'ipc_failed'),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
  it('replaces invalid diagnostic IDs and closes unexpected synchronous UI failures', async () => {
    expect(failure('input_invalid', 'private/path').diagnosticId).toMatch(/^[a-f0-9]{32}$/u);
    const seen: unknown[] = [];
    launch(
      () => {
        throw new Error('private synchronous details');
      },
      (error) => seen.push(error),
    );
    launch(
      () => Promise.reject(new Error('private rejected details')),
      (error) => seen.push(error),
    );
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([
      expect.objectContaining({ internalCode: 'unexpected_failure' }),
      expect.objectContaining({ internalCode: 'unexpected_failure' }),
    ]);
    expect(JSON.stringify(seen)).not.toContain('private');
  });
});
