import { browser, expect } from '@wdio/globals';
import '@wdio/tauri-service';
import { decodePublicError } from '@chrome-toolbox/contracts';
import { relayStatusSchema } from '../src/native';

describe('real native relay control window and Rust IPC', () => {
  it('starts stopped and reads status without starting inference', async () => {
    await expect(browser.$('h1')).toHaveText('OBS コメント中継');
    const status = relayStatusSchema.parse(
      await browser.tauri.execute((tauri) => tauri.core.invoke('get_status')),
    );
    expect(status.source).toBe('stopped');
    expect(status.inference).toBe('idle');
    await browser.$('button=状態を取得').click();
    await expect(browser.$('output')).toHaveText('取得: stopped / 推論: idle');
  });
  it('denies main ingestion, unknown commands and arbitrary model paths', async () => {
    await expect(
      browser.tauri.execute((tauri) => tauri.core.invoke('chat_ingest', { input: {} })),
    ).rejects.toThrow();
    await expect(
      browser.tauri.execute((tauri) => tauri.core.invoke('read_file', { path: '/unrelated' })),
    ).rejects.toThrow();
    const decoded = decodePublicError(
      await browser.tauri.execute(async (tauri) => {
        try {
          await tauri.core.invoke('select_model_file', {
            input: { model: 'clef', path: '/unrelated' },
          });
          return null;
        } catch (error) {
          return error;
        }
      }),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('Native rejection violated the generated public policy');
    expect(decoded.value.code).toBe('relay_invalid_input');
    expect(decoded.value.diagnosticId).toMatch(/^[a-f0-9]{32}$/u);
  });
});
