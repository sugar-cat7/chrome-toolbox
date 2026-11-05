import { describe, expect, it } from 'vitest';
import { Ok } from '@chrome-toolbox/contracts';
import { defaultSettings, settingsStore, type StorageArea } from './settings.ts';

function memoryArea(initial: Record<string, unknown> = {}): StorageArea & {
  data: Record<string, unknown>;
} {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
}

describe('settingsStore', () => {
  it('defaults to the managed router server and its models', async () => {
    expect(await settingsStore(memoryArea()).load()).toEqual(Ok(defaultSettings));
    expect(defaultSettings).toEqual({
      llamaBaseUrl: 'http://127.0.0.1:18083',
      models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'gemma4-e4b' },
    });
  });

  it('loads a saved URL as saved, including the former default port', async () => {
    const store = settingsStore(memoryArea());
    const saved = await store.save({ ...defaultSettings, llamaBaseUrl: 'http://127.0.0.1:18082' });
    expect(saved).toEqual(Ok({ ...defaultSettings, llamaBaseUrl: 'http://127.0.0.1:18082' }));
    expect(await store.load()).toEqual(saved);
  });

  it('fills models with defaults when a legacy value has only llamaBaseUrl', async () => {
    const area = memoryArea({ settings: { llamaBaseUrl: 'http://192.0.2.20:8080' } });
    expect(await settingsStore(area).load()).toEqual(
      Ok({ llamaBaseUrl: 'http://192.0.2.20:8080', models: defaultSettings.models }),
    );
  });

  it('saves normalized settings and reads them back', async () => {
    const area = memoryArea();
    const store = settingsStore(area);
    const saved = await store.save({ ...defaultSettings, llamaBaseUrl: 'http://127.0.0.1:9000/' });
    expect(saved).toEqual(Ok({ ...defaultSettings, llamaBaseUrl: 'http://127.0.0.1:9000' }));
    expect(await store.load()).toEqual(saved);
  });

  it('rejects stored values with unknown keys', async () => {
    const area = memoryArea({ settings: { llamaBaseUrl: 'http://x', extra: 1 } });
    expect((await settingsStore(area).load()).ok).toBe(false);
  });
});
