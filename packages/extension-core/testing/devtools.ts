// A Chromium started apart (the `realVisibility` fixture): reading its DevTools endpoint and
// never letting it outlive the test worker. Node only, outside src/.
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

/**
 * The DevTools endpoint Chromium prints on stderr. Rejects when Chromium fails to start, exits
 * or prints none within `timeoutMs`. Its later output is read and dropped, so Chromium never
 * blocks on a full pipe.
 */
export function devToolsEndpoint(browserProcess: ChildProcess, timeoutMs: number): Promise<string> {
  const { stderr } = browserProcess;
  return new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      settle();
      reject(new Error(`Chromium printed no DevTools endpoint in ${timeoutMs} ms: ${output}`));
    }, timeoutMs);
    function settle(): void {
      clearTimeout(timer);
      stderr?.off('data', onData);
      stderr?.resume();
      browserProcess.off('exit', onExit);
      browserProcess.off('error', onError);
    }
    function onData(chunk: Buffer): void {
      output += chunk.toString('utf8');
      const found = /DevTools listening on (ws:\/\/\S+)/u.exec(output)?.[1];
      if (found === undefined) return;
      settle();
      resolve(found);
    }
    function onExit(code: number | null): void {
      settle();
      reject(new Error(`Chromium exited (${code}) before DevTools listened: ${output}`));
    }
    function onError(error: Error): void {
      settle();
      reject(error);
    }
    stderr?.on('data', onData);
    browserProcess.once('exit', onExit);
    browserProcess.once('error', onError);
  });
}

/**
 * Kills the browser and removes its profile when this process (the test worker) exits, for
 * whatever reason; returns the removal of that handler, for a browser stopped another way.
 */
export function stopOnExit(browserProcess: ChildProcess, profile: string): () => void {
  function stop(): void {
    browserProcess.kill('SIGKILL');
    // The process is ending: a profile that cannot be removed stays in the temp directory.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Nothing more can be done while exiting.
    }
  }
  process.once('exit', stop);
  return () => {
    process.off('exit', stop);
  };
}
