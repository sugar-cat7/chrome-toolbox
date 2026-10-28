import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest, walk } from '../generators/files.ts';
import { it, expect } from 'vitest';

it('replaces stale success on actual CLI readiness and input failures without starting producers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o11y-startup-'));
  try {
    cpSync(fileURLToPath(new URL('../', import.meta.url)), path.join(root, 'tools'), {
      recursive: true,
    });
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const sha = 'a'.repeat(40);
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'fixture lock');
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        kind: 'project',
        origin: { sha },
        managed: Object.fromEntries(
          walk(path.join(root, 'tools'), 'tools').map((file) => [
            file,
            digest(readFileSync(path.join(root, file))),
          ]),
        ),
        lockId: digest('fixture lock'),
      }),
    );
    const filename = path.join(root, 'artifacts/o11y/verified.json');
    mkdirSync(path.dirname(filename), { recursive: true });
    for (const expected of [
      {
        result: 'not_run',
        ciSha: sha,
        phase: 'readiness',
        sha,
        health: { initialized: false, collectable: false, queryReady: false },
      },
      { result: 'failed', ciSha: 'b'.repeat(40), phase: 'input', sha: null, health: null },
    ]) {
      writeFileSync(filename, JSON.stringify({ result: 'passed', runId: 'stale' }));
      const invocation = spawnSync(process.execPath, ['tools/o11y/verify.ts'], {
        cwd: root,
        env: { ...process.env, CI_HEAD_SHA: expected.ciSha },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(invocation.error).toBeUndefined();
      expect(invocation.status).not.toBe(0);
      const report = JSON.parse(readFileSync(filename, 'utf8'));
      expect(report).toMatchObject({
        result: expected.result,
        phase: expected.phase,
        sha: expected.sha,
        health: expected.health,
        contentId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(report.runId).not.toBe('stale');
      expect(report.finishedAt).toEqual(expect.any(String));
      expect(report.native).toContain('NOT RUN');
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});
