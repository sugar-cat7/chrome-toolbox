import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { sanitize } from './sanitize.ts';

it('scans applications named like caches and their built output, with exact exceptions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sanitize-'));
  try {
    for (const file of [
      'packages/generated/src/index.ts',
      'packages/generated/dist/index.js',
      'packages/generated/src/target/config.json',
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), 'source-marker');
    }
    writeFileSync(
      path.join(root, 'packages/generated/package.json'),
      JSON.stringify({ name: '@example/generated', starter: { runtime: 'worker' } }),
    );
    const failures = sanitize(root, [
      {
        id: 'source',
        pattern: 'source-marker',
        allow: [
          { file: 'packages/generated/src/index.ts', reason: 'Required attribution example' },
        ],
      },
    ]);
    expect(failures).toEqual([
      { file: 'packages/generated/dist/index.js', rule: 'source' },
      { file: 'packages/generated/src/target/config.json', rule: 'source' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
