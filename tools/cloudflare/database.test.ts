import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareDatabase } from './database.ts';
import { pnpm } from '../process.ts';
import type * as ProcessModule from '../process.ts';

vi.mock('../process.ts', async (original) => ({
  ...(await original<typeof ProcessModule>()),
  pnpm: vi.fn<typeof pnpm>(),
}));

it('keeps offline build, migration and seed children inside the supplied environment', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'database-environment-'));
  const state = path.join(root, '.state');
  try {
    mkdirSync(path.join(root, 'migrations'));
    const config = path.join(root, '.cloudflare/output/v0/workers/default/worker.config.json');
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(
      config,
      JSON.stringify({
        name: 'environment-probe',
        compatibilityDate: '2026-10-09',
        env: { DATABASE: { type: 'd1', id: 'local-test' } },
      }),
    );
    vi.stubEnv('GIT_DIR', 'foreign-parent');
    const environment = { ...process.env, GIT_DIR: undefined, STARTER_ENVIRONMENT_PROBE: 'owned' };
    vi.mocked(pnpm).mockImplementation(async (_, options) => {
      execFileSync(
        process.execPath,
        [
          '-e',
          "if(process.env.GIT_DIR||process.env.STARTER_ENVIRONMENT_PROBE!=='owned')throw new Error('Foreign environment leaked');require('node:fs').appendFileSync('environment-children','owned\\n');",
        ],
        { cwd: root, env: options?.env },
      );
    });
    await prepareDatabase(root, state, undefined, environment);
    expect(readFileSync(path.join(root, 'environment-children'), 'utf8')).toBe('owned\n'.repeat(3));
    expect(readFileSync(path.join(state, path.basename(root), '.seeded'), 'utf8')).toBe('1\n');
    await prepareDatabase(root, state, undefined, environment);
    expect(readFileSync(path.join(root, 'environment-children'), 'utf8')).toBe('owned\n'.repeat(5));
    expect(
      vi.mocked(pnpm).mock.calls.every(([, options]) => options?.env?.GIT_DIR === undefined),
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    vi.mocked(pnpm).mockReset();
    rmSync(root, { recursive: true, force: true });
  }
});
