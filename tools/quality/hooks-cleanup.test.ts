import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runSync } from '../process.ts';
import { removeOwnedWorktree } from './hooks.ts';
import { initializeVerificationGit } from './fixture.ts';

function fixture() {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'starter-cleanup-'));
  const root = path.join(owned, 'repository');
  const snapshot = path.join(owned, 'snapshot');
  try {
    // The foreign-root probe needs an actual unborn repository even when
    // the caller's TMPDIR is inside another committed checkout.
    initializeVerificationGit(owned);
    mkdirSync(root);
    const git = (args: string[]) => runSync('git', args, root);
    git(['init', '-q']);
    git(['config', '--local', 'user.name', 'Cleanup regression']);
    git(['config', '--local', 'user.email', 'cleanup@example.invalid']);
    git(['config', '--local', 'core.longpaths', 'false']);
    writeFileSync(path.join(root, 'tracked.txt'), 'tracked input');
    git(['add', 'tracked.txt']);
    git(['commit', '-qm', 'Initial input']);
    const originalWorktrees = git(['worktree', 'list', '--porcelain']);
    git(['worktree', 'add', '--detach', snapshot, 'HEAD']);
    return { owned, root, snapshot, git, originalWorktrees };
  } catch (error) {
    rmSync(owned, { recursive: true, force: true });
    throw error;
  }
}

describe('owned hook worktree cleanup', () => {
  it('isolates foreign Git routing during an actual linked-worktree pre-push event', () => {
    const { owned, root, snapshot, git } = fixture();
    try {
      const originalHead = git(['rev-parse', 'HEAD']);
      writeFileSync(path.join(snapshot, 'tracked.txt'), 'Separate pushed input');
      runSync('git', ['add', 'tracked.txt'], snapshot);
      runSync('git', ['commit', '-qm', 'Linked input'], snapshot);
      const pushedHead = runSync('git', ['rev-parse', 'HEAD'], snapshot);
      expect(pushedHead).not.toBe(originalHead);
      const hooks = path.join(owned, 'hooks');
      const remote = path.join(owned, 'remote.git');
      const probe = path.join(owned, 'probe.mjs');
      const receipt = path.join(owned, 'routing.json');
      mkdirSync(hooks);
      writeFileSync(
        probe,
        `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { foreignGitEnvironment } from ${JSON.stringify(new URL('./hooks.ts', import.meta.url).href)};
const environment = foreignGitEnvironment(${JSON.stringify(snapshot)});
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ${JSON.stringify(root)}, env: environment, encoding: 'utf8' });
const unborn = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ${JSON.stringify(owned)}, env: environment, encoding: 'utf8' });
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ exportedRouting: Boolean(process.env.GIT_DIR), head: head.stdout.trim(), unbornStatus: unborn.status }));
if (head.status !== 0 || head.stdout.trim() !== ${JSON.stringify(originalHead)} || unborn.status === 0) process.exitCode = 1;
`,
      );
      // Git's portable hook shell invokes the actual Node probe; no direct
      // handler call substitutes for the linked-worktree push event.
      writeFileSync(
        path.join(hooks, 'pre-push'),
        `#!/bin/sh\nexec node '${probe.replaceAll("'", "'\\''")}'\n`,
        { mode: 0o755 },
      );
      git(['config', '--local', 'core.hooksPath', hooks]);
      runSync('git', ['init', '--bare', '-q', remote], owned);
      runSync('git', ['push', remote, 'HEAD:refs/heads/probe'], snapshot);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({
        exportedRouting: true,
        head: originalHead,
        unbornStatus: 128,
      });
      expect(runSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/probe'], owned)).toBe(
        pushedHead,
      );
      expect(git(['rev-parse', 'HEAD'])).toBe(originalHead);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it('removes deep dependency paths without changing Git config or following an outside junction', () => {
    const { owned, root, snapshot, git, originalWorktrees } = fixture();
    try {
      const deep = path.join(
        snapshot,
        'node_modules',
        '.pnpm',
        ...Array.from({ length: 6 }, (_, i) => `${i}-${'resolved-package-'.repeat(5)}`),
        'file.txt',
      );
      expect(deep.length).toBeGreaterThan(320);
      mkdirSync(path.dirname(deep), { recursive: true });
      writeFileSync(deep, 'owned dependency bytes');
      const outside = path.join(owned, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve sibling');
      symlinkSync(outside, path.join(snapshot, 'outside-link'), 'junction');
      removeOwnedWorktree(root, snapshot);
      expect(existsSync(snapshot)).toBe(false);
      expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserve sibling');
      expect(git(['config', '--local', '--get', 'core.longpaths'])).toBe('false');
      expect(git(['worktree', 'list', '--porcelain'])).toBe(originalWorktrees);
      expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('tracked input');
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it('propagates a refused cleanup and removes only the owned worktree after unlocking', () => {
    const { owned, root, snapshot, git } = fixture();
    try {
      git(['worktree', 'lock', '--reason', 'Preserve locked fixture', snapshot]);
      expect(() => removeOwnedWorktree(root, snapshot)).toThrow(/locked/u);
      expect(existsSync(snapshot)).toBe(true);
      expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('tracked input');
      git(['worktree', 'unlock', snapshot]);
      removeOwnedWorktree(root, snapshot);
      expect(existsSync(snapshot)).toBe(false);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });
});
