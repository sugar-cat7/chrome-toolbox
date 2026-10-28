import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Servers } from '../dev-environment/servers.ts';
import { pnpm } from '../process.ts';

const root = path.resolve(process.cwd(), '../..');
const state = mkdtempSync(path.join(os.tmpdir(), 'starter-runtime-'));
const servers = new Servers(root, state);
try {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const diagnose = process.env.STARTER_RUNTIME_TRANSPORT_DIAGNOSTICS === 'true';
  let origin: string;
  try {
    if (diagnose) {
      const moduleUrl = pathToFileURL(
        path.join(root, 'tools/cloudflare/transport-diagnostics.ts'),
      ).href;
      process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --import=${moduleUrl}`.trim();
    }
    origin = await servers.workers(path.basename(process.cwd()));
  } finally {
    if (diagnose) {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }
  await pnpm(
    ['exec', 'node', '../../tools/quality/vitest.ts', '--config', 'vitest.runtime.config.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, STARTER_TEST_ORIGIN: origin },
      timeout: 120_000,
    },
  );
  if (servers.failures.length) throw new AggregateError(servers.failures);
} finally {
  await servers.stop();
  rmSync(state, { recursive: true, force: true });
}
