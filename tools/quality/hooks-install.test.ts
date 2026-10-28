import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runSync } from '../process.ts';
import { foreignGitEnvironment, installHooks, removeOwnedWorktree } from './hooks.ts';
import { initializeVerificationGit } from './fixture.ts';

it('protects parent Git metadata during foreign hook installation and linked cleanup', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'foreign-hook-routing-'));
  const project = path.join(parent, 'project');
  const linked = path.join(parent, 'linked');
  try {
    initializeVerificationGit(parent);
    writeFileSync(path.join(parent, '.gitignore'), 'project/\nlinked/\n');
    runSync('git', ['add', '.gitignore'], parent);
    runSync(
      'git',
      [
        '-c',
        'user.name=Hook test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Parent',
      ],
      parent,
    );
    const parentHead = runSync('git', ['rev-parse', 'HEAD'], parent);
    const config = readFileSync(path.join(parent, '.git/config'));
    mkdirSync(path.join(project, 'tools/quality/git-hooks'), { recursive: true });
    initializeVerificationGit(project);
    for (const event of ['pre-commit', 'pre-push'])
      writeFileSync(path.join(project, 'tools/quality/git-hooks', event), '#!/bin/sh\nexit 0\n');
    vi.stubEnv('GIT_DIR', path.join(parent, '.git'));
    const environment = foreignGitEnvironment(project);
    installHooks(project);
    expect(
      runSync('git', ['config', '--local', '--get', 'core.hooksPath'], project, environment),
    ).toBe('tools/quality/git-hooks');
    runSync('git', ['add', '.'], project, environment);
    runSync(
      'git',
      [
        '-c',
        'user.name=Hook test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Project',
      ],
      project,
      environment,
    );
    const projectHead = runSync('git', ['rev-parse', 'HEAD'], project, environment);
    runSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], project, environment);
    removeOwnedWorktree(project, linked);
    expect(existsSync(linked)).toBe(false);
    expect(runSync('git', ['worktree', 'list', '--porcelain'], project, environment)).not.toContain(
      linked,
    );
    expect(runSync('git', ['rev-parse', 'HEAD'], project, environment)).toBe(projectHead);
    expect(readFileSync(path.join(parent, '.git/config'))).toEqual(config);
    expect(runSync('git', ['rev-parse', 'HEAD'], parent)).toBe(parentHead);
  } finally {
    vi.unstubAllEnvs();
    rmSync(parent, { recursive: true, force: true });
  }
});

it('refuses a nested project without writing the parent Git configuration or user files', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'starter-parent-hooks-'));
  const project = path.join(parent, 'artifacts', 'project');
  try {
    runSync('git', ['init', '--quiet'], parent);
    mkdirSync(path.join(project, 'tools/quality/git-hooks'), { recursive: true });
    writeFileSync(path.join(parent, '.gitignore'), 'artifacts/\n');
    writeFileSync(path.join(parent, 'user.txt'), 'Existing user content');
    for (const event of ['pre-commit', 'pre-push'])
      writeFileSync(path.join(project, 'tools/quality/git-hooks', event), '#!/bin/sh\nexit 0\n');
    const configuration = readFileSync(path.join(parent, '.git/config'));
    expect(() => installHooks(project)).toThrow(/Nested project.*git init/u);
    expect(readFileSync(path.join(parent, '.git/config'))).toEqual(configuration);
    expect(readFileSync(path.join(parent, 'user.txt'), 'utf8')).toBe('Existing user content');
    for (const event of ['pre-commit', 'pre-push'])
      expect(readFileSync(path.join(project, 'tools/quality/git-hooks', event), 'utf8')).toBe(
        '#!/bin/sh\nexit 0\n',
      );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
