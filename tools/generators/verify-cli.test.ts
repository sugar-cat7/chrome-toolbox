import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('rejects ambiguous, unknown and duplicate case selection before writing a generated destination', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-verification-selection-'));
  try {
    const output = path.join(root, 'projects');
    for (const selection of [
      ['--cases', 'web,api', '--preset', 'web'],
      ['--cases', 'web,unknown'],
      ['--cases', 'web,web'],
      ['--cases', 'web,'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['tools/generators/verify.ts', '--generate-only', '--output', output, ...selection],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /Use either --preset or --cases|distinct known verification cases/u,
      );
      expect(existsSync(output)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
