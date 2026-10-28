import { pnpm } from '../process.ts';
import { readFileSync } from 'node:fs';

// cf beta.14's TanStack detector rejects --mode for its Vite-based command.
// Keep the tested direct Vite+ entry for Start; ordinary Workers use cf's v2 delegate.
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
};
const command = manifest.dependencies?.['@tanstack/react-start'] ? 'vp' : 'cf';
const cancellation = new AbortController();
const stop = () => cancellation.abort(new Error('Worker build interrupted'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await pnpm(['exec', command, 'build', '--mode', process.env.STARTER_BUILD_MODE ?? 'offline'], {
    cwd: process.cwd(),
    signal: cancellation.signal,
    // Finish nested cleanup before an owning runner's three-second escalation.
    terminationGraceMs: 1_000,
  });
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
