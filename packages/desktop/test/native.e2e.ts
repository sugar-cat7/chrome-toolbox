import { browser, expect } from '@wdio/globals';
import '@wdio/tauri-service';
import { readFile } from 'node:fs/promises';
import { noteSchema, notesSchema, decodePublicError } from '@starter/contracts';

async function reloadNativeWindow() {
  // The embedded driver's refresh returns before WebKit replaces the document.
  // Wait for the new document/plugin before the service's next Rust focus query.
  const marker = crypto.randomUUID();
  await browser.execute((value: string) => {
    document.documentElement.dataset.nativeReload = value;
  }, marker);
  await browser.refresh();
  // Yield to WebKit's queued unload before creating an eval completion callback.
  await browser.pause(100);
  await browser.waitUntil(
    () =>
      browser.execute(
        (value: string) =>
          document.documentElement.dataset.nativeReload !== value &&
          document.readyState === 'complete' &&
          typeof window.wdioTauri?.waitForInit === 'function' &&
          typeof window.__wdio_original_core__?.invoke === 'function',
        marker,
      ),
    { timeout: 5000, interval: 100, timeoutMsg: 'Reloaded native plugin did not initialize' },
  );
  await browser.execute(async () => {
    await window.wdioTauri?.waitForInit();
  });
}

describe('real native Tauri window and Rust IPC', () => {
  it('renders offline UI and validates real CRUD/export permissions', async () => {
    await expect(browser.$('h1')).toHaveText('Notes');
    for (const text of [
      '\uFEFFnative\uFEFF',
      '\u0085',
      '\uFEFF\u0085note\u0085\uFEFF',
      `\uFEFF${'x'.repeat(1000)}\uFEFF`,
      `\uFEFF${'😀'.repeat(500)}\uFEFF`,
    ]) {
      const normalized = noteSchema.parse(
        await browser.tauri.execute(
          (tauri, value: string) => tauri.core.invoke('add_note', { text: value }),
          text,
        ),
      );
      expect(normalized.text).toBe(text.trim());
      await browser.tauri.execute(
        (tauri, id: string) => tauri.core.invoke('delete_note', { id }),
        normalized.id,
      );
    }
    await expect(
      browser.tauri.execute((tauri) => tauri.core.invoke('add_note', { text: '\uFEFF' })),
    ).rejects.toThrow();
    for (const text of ['😀'.repeat(501), `${'😀'.repeat(500)}x`]) {
      await expect(
        browser.tauri.execute(
          (tauri, value: string) => tauri.core.invoke('add_note', { text: value }),
          text,
        ),
      ).rejects.toThrow();
    }
    // Inspect the actual Rust-to-renderer rejection before the WebDriver transport wraps it.
    const publicFailure = decodePublicError(
      await browser.tauri.execute(async (tauri) => {
        try {
          await tauri.core.invoke('add_note', { text: '' });
          return null;
        } catch (error) {
          return error;
        }
      }),
    );
    expect(publicFailure.ok).toBe(true);
    if (!publicFailure.ok)
      throw new Error('Native rejection violated the generated public error policy');
    expect(publicFailure.value.code).toBe('invalid_input');
    expect(publicFailure.value.failureClass).toBe('validation');
    expect(publicFailure.value.retry).toBe('never');
    expect(publicFailure.value.diagnosticId).toMatch(/^[a-f0-9]{32}$/u);
    const note = noteSchema.parse(
      await browser.tauri.execute((tauri) =>
        tauri.core.invoke('add_note', { text: 'Native note' }),
      ),
    );
    await reloadNativeWindow();
    await expect(browser.$(`button[aria-label="Delete Native note"]`)).toExist();
    const mode = process.env.STARTER_EXPORT_CASE ?? 'save';
    if (mode === 'error') {
      await expect(
        browser.tauri.execute((tauri) => tauri.core.invoke('export_notes')),
      ).rejects.toThrow();
    } else {
      const result = await browser.tauri.execute((tauri) => tauri.core.invoke('export_notes'));
      if (mode === 'cancel') expect(result).toBeNull();
      else {
        expect(typeof result).toBe('string');
        const filename = process.env.STARTER_TEST_SAVE_PATH;
        if (!filename) throw new Error('Native export path missing');
        expect(notesSchema.parse(JSON.parse(await readFile(filename, 'utf8')))).toContainEqual(
          note,
        );
      }
    }
    await expect(
      browser.tauri.execute((tauri) => tauri.core.invoke('read_file', { path: '/unrelated' })),
    ).rejects.toThrow();
    await browser.tauri.execute(
      (tauri, id: string) => tauri.core.invoke('delete_note', { id }),
      note.id,
    );
    await reloadNativeWindow();
    await expect(browser.$('section')).toHaveText(expect.stringContaining('No notes yet.'));
  });
});
