import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devToolsEndpoint } from './devtools.ts';

/** A stand-in for Chromium: a Node process running `script`, its stderr piped. */
const started: ReturnType<typeof spawn>[] = [];
function fakeBrowser(script: string, executable = process.execPath): ReturnType<typeof spawn> {
  const child = spawn(executable, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  started.push(child);
  return child;
}
afterEach(async () => {
  for (const child of started.splice(0))
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
});

describe('devToolsEndpoint', () => {
  it('reads the endpoint and keeps draining what the browser prints after it', async () => {
    const child = fakeBrowser(`
      process.stderr.write('starting\\nDevTools listening on ws://127.0.0.1:9/devtools/browser/x\\n');
      // Much more output than a pipe holds: it must keep being read.
      setTimeout(() => { process.stderr.write('y'.repeat(1 << 20)); process.exit(0); }, 50);
    `);
    await expect(devToolsEndpoint(child, 5_000)).resolves.toBe(
      'ws://127.0.0.1:9/devtools/browser/x',
    );
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  });

  it('fails when the browser exits first, prints nothing in time or does not start', async () => {
    await expect(devToolsEndpoint(fakeBrowser('process.exit(3)'), 5_000)).rejects.toThrow(
      'Chromium exited (3)',
    );
    await expect(devToolsEndpoint(fakeBrowser('setInterval(() => {}, 1000)'), 200)).rejects.toThrow(
      'no DevTools endpoint in 200 ms',
    );
    await expect(
      devToolsEndpoint(fakeBrowser('', '/nonexistent/chromium-for-test'), 5_000),
    ).rejects.toThrow('ENOENT');
  });
});

describe('stopOnExit', () => {
  it('kills the browser and removes its profile when the worker exits', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'devtools-test-'));
    writeFileSync(path.join(profile, 'Preferences'), '{}');
    // A worker that starts a browser, registers the cleanup and exits without stopping it.
    const worker = `
      import { spawn } from 'node:child_process';
      import { stopOnExit } from ${JSON.stringify(path.join(import.meta.dirname, 'devtools.ts'))};
      const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      stopOnExit(browser, ${JSON.stringify(profile)});
      process.stdout.write(String(browser.pid));
      setTimeout(() => process.exit(0), 300);
    `;
    const pid = Number(execFileSync(process.execPath, ['--input-type=module', '-e', worker]));
    expect(pid).toBeGreaterThan(0);
    expect(existsSync(profile)).toBe(false);
    // Gone (a signal 0 to a dead process fails).
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow('ESRCH'));
  });
});
