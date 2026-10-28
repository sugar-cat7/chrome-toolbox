import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { applyFiles, digest } from '../generators/files.ts';
import { projectOptions } from '../generators/options.ts';
import { projectFiles } from '../generators/render.ts';
import { lifecycleRehearsal } from '../generators/lifecycle.ts';
import { faultRehearsal } from './faults.ts';
import { hookRehearsal } from './hooks-rehearsal.ts';
import { pnpm } from '../process.ts';
import type * as ProcessModule from '../process.ts';

vi.mock('../process.ts', async (original) => ({
  ...(await original<typeof ProcessModule>()),
  pnpm: vi.fn<typeof pnpm>(),
}));

it.each([
  ['hooks', hookRehearsal, 'starter-hooks-'],
  ['faults', faultRehearsal, 'starter-faults-'],
  ['lifecycle', lifecycleRehearsal, 'starter-lifecycle-'],
] as const)(
  'isolates %s before setup inside an ignored committed parent',
  async (_, rehearse, prefix) => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'rehearsal-boundary-'));
    const temporary = path.join(parent, '.state', 'tmp');
    const project = path.join(parent, 'source');
    const git = (cwd: string, args: string[], env = process.env) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    try {
      git(parent, ['init', '--quiet', '--template=']);
      writeFileSync(path.join(parent, '.gitignore'), '.state/\nsource/\n');
      git(parent, ['add', '.gitignore']);
      git(parent, [
        '-c',
        'user.name=Boundary test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Parent',
      ]);
      const head = git(parent, ['rev-parse', 'HEAD']);
      const config = readFileSync(path.join(parent, '.git/config'));
      applyFiles(
        project,
        projectFiles(
          fileURLToPath(new URL('../..', import.meta.url)),
          projectOptions({ name: 'boundary', scope: '@boundary', preset: 'web' }),
        ),
      );
      const expectedSource = 'a'.repeat(40);
      const lock = Buffer.from('lockfileVersion: 9\n');
      writeFileSync(path.join(project, 'pnpm-lock.yaml'), lock);
      const template = JSON.parse(readFileSync(path.join(project, '.template.json'), 'utf8'));
      template.lockId = digest(lock);
      template.origin.sha = expectedSource;
      template.origin.dirty = false;
      writeFileSync(path.join(project, '.template.json'), JSON.stringify(template));
      mkdirSync(temporary, { recursive: true });
      vi.spyOn(os, 'tmpdir').mockReturnValue(temporary);
      vi.stubEnv('GIT_DIR', path.join(parent, '.git'));
      const marker = new Error('Stop after observing the real setup Git boundary');
      vi.mocked(pnpm).mockImplementation(async (args, options) => {
        expect(args).toEqual(['env:setup']);
        const root = String(options?.cwd);
        expect(path.relative(temporary, root).startsWith(prefix)).toBe(true);
        expect(options?.env?.GIT_DIR).toBeUndefined();
        const generated = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8'));
        expect(generated.origin.sha).toBe(expectedSource);
        expect(generated.origin.dirty).toBe(false);
        expect(realpathSync.native(git(root, ['rev-parse', '--show-toplevel'], options?.env))).toBe(
          realpathSync.native(root),
        );
        expect(() => git(root, ['rev-parse', 'HEAD'], options?.env)).toThrow(
          /Command failed: git rev-parse HEAD/u,
        );
        expect(() => git(root, ['check-ignore', 'package.json'], options?.env)).toThrow(
          /Command failed: git check-ignore package.json/u,
        );
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import { installHooks } from './tools/quality/hooks.ts'; installHooks(process.cwd());",
          ],
          { cwd: root, env: options?.env },
        );
        expect(git(root, ['config', '--local', '--get', 'core.hooksPath'], options?.env)).toBe(
          'tools/quality/git-hooks',
        );
        throw marker;
      });
      await expect(rehearse(project)).rejects.toThrow(marker.message);
      expect(pnpm).toHaveBeenCalledTimes(1);
      expect(git(parent, ['rev-parse', 'HEAD'])).toBe(head);
      expect(readFileSync(path.join(parent, '.git/config'))).toEqual(config);
      expect(readFileSync(path.join(parent, '.gitignore'), 'utf8')).toBe('.state/\nsource/\n');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.mocked(pnpm).mockReset();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
