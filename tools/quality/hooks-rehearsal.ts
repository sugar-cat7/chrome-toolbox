import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { copyProjectFixture, initializeVerificationGit } from './fixture.ts';
import { foreignGitEnvironment, installHooks, removeOwnedWorktree } from './hooks.ts';
import { pnpm } from '../process.ts';
import { contentId } from './gate.ts';
import { hookPhases } from './definitions.ts';
import { baselineDifferences } from '../generators/baseline.ts';
import { writeEvidenceAfterCleanup } from './evidence.ts';

export async function hookRehearsal(project: string): Promise<void> {
  const environment = foreignGitEnvironment(project);
  const started = performance.now();
  let status: 'passed' | 'failed' = 'failed';
  const owned = mkdtempSync(path.join(os.tmpdir(), 'starter-hooks-'));
  const root = path.join(owned, 'project');
  const remote = path.join(owned, 'remote.git');
  const temporary = path.join(root, '.state', 'hook-tmp');
  const git = (args: string[], expected = true, cwd = root, input?: string): string => {
    const result = spawnSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 10 * 60_000,
      env: { ...environment, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (expected) assert.equal(result.status, 0, output);
    else {
      assert.notEqual(result.status, 0, 'Fault must reject the Git operation');
      assert.match(output, /no-debugger/u, output);
    }
    return output;
  };
  const good = "export const hookProbe = 'valid';\n";
  const bad = "debugger;\nexport const hookProbe = 'invalid';\n";
  try {
    copyProjectFixture(project, root);
    mkdirSync(temporary, { recursive: true });
    initializeVerificationGit(root, environment);
    await pnpm(['env:setup'], { cwd: root, env: environment, timeout: 10 * 60_000 });
    git(['config', 'user.name', 'Template rehearsal']);
    git(['config', 'user.email', 'template-rehearsal@example.invalid']);
    installHooks(root);
    installHooks(root);
    const configuration = readFileSync(path.join(root, '.git/config'));
    const assertIndexCleanup = () => {
      assert.equal(
        readdirSync(temporary).some((name) => name.startsWith('starter-index-')),
        false,
        'Index checks must remove snapshots inside ignored TMPDIR, including rejected commits',
      );
      assert.deepEqual(
        readFileSync(path.join(root, '.git/config')),
        configuration,
        'Index checks must preserve user Git configuration',
      );
    };
    git(['add', '.']);
    git(['commit', '-m', 'Valid initial generated project']);
    assertIndexCleanup();
    const probe = path.join(root, 'tools/hook-probe.ts');
    writeFileSync(probe, good);
    git(['add', 'tools/hook-probe.ts']);
    writeFileSync(probe, bad);
    git(
      ['commit', '-m', 'Valid index with invalid unstaged source'],
      true,
      path.join(root, 'packages'),
    );
    assert.equal(readFileSync(probe, 'utf8'), bad, 'Hook must preserve unstaged content');
    assert.equal(git(['show', 'HEAD:tools/hook-probe.ts']).trim(), good.trim());
    assertIndexCleanup();
    git(['add', 'tools/hook-probe.ts']);
    writeFileSync(probe, good);
    const head = git(['rev-parse', 'HEAD']);
    git(['commit', '-m', 'Invalid index with valid unstaged source'], false);
    assert.equal(git(['rev-parse', 'HEAD']), head, 'Rejected commit must not advance HEAD');
    assert.equal(readFileSync(probe, 'utf8'), good, 'Hook must preserve unstaged correction');
    assert.equal(git(['show', ':tools/hook-probe.ts']).trim(), bad.trim(), 'Hook must not restage');
    assertIndexCleanup();
    git(['add', 'tools/hook-probe.ts']);
    git(['commit', '--allow-empty', '-m', 'Repaired index and empty-diff hook']);
    assertIndexCleanup();
    git(['init', '--bare', '-q', remote]);
    const originalWorktrees = git(['worktree', 'list', '--porcelain']);
    const assertPushCleanup = () => {
      assert.equal(
        git(['worktree', 'list', '--porcelain']),
        originalWorktrees,
        'Push checks must remove their registered worktrees',
      );
      assert.equal(
        readdirSync(temporary).some((name) => name.startsWith('starter-push-')),
        false,
        'Push checks must remove their physical snapshots even after a rejected gate',
      );
    };
    git(['push', remote, 'HEAD:refs/heads/test']);
    assertPushCleanup();
    const before = git(['--git-dir', remote, 'rev-parse', 'refs/heads/test']);
    const blob = git(['hash-object', '-w', '--stdin'], true, root, bad).trim();
    git(['update-index', '--cacheinfo', `100644,${blob},tools/hook-probe.ts`]);
    const invalidTree = git(['write-tree']).trim();
    // Plumbing simulates a commit created through an entry without hooks; CI/push must still reject it.
    const invalidCommit = git(
      ['commit-tree', invalidTree, '-p', 'HEAD'],
      true,
      root,
      'Injected committed lint fault\n',
    ).trim();
    git(['reset', '-q', 'HEAD', '--', 'tools/hook-probe.ts']);
    git(['push', remote, `${invalidCommit}:refs/heads/test`], false);
    assertPushCleanup();
    assert.equal(
      git(['--git-dir', remote, 'rev-parse', 'refs/heads/test']),
      before,
      'Rejected push must preserve remote ref',
    );
    const repairedTree = git(['rev-parse', 'HEAD^{tree}']).trim();
    const repaired = git(
      ['commit-tree', repairedTree, '-p', invalidCommit],
      true,
      root,
      'Repair committed fault\n',
    ).trim();
    git(['push', remote, `${repaired}:refs/heads/test`, `${repaired}:refs/heads/second`]);
    assertPushCleanup();
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/test']).trim(), repaired);
    const linked = path.join(owned, 'linked');
    git(['worktree', 'add', '--detach', linked, 'HEAD']);
    try {
      await pnpm(['env:setup'], { cwd: linked, env: environment, timeout: 10 * 60_000 });
      writeFileSync(path.join(linked, 'tools/linked-probe.ts'), good);
      git(['add', '.'], true, linked);
      git(['commit', '-m', 'Linked worktree hook'], true, path.join(linked, 'packages'));
      assertIndexCleanup();
      assert.equal(
        git(['diff', '--name-only']),
        '',
        'Linked worktree must not change original worktree',
      );
    } finally {
      removeOwnedWorktree(root, linked);
    }
    mkdirSync(path.join(root, 'user-hooks'));
    writeFileSync(path.join(root, 'user-hooks/pre-commit'), 'owned');
    git(['config', '--local', 'core.hooksPath', 'user-hooks']);
    assert.throws(() => installHooks(root), /Existing core.hooksPath/u);
    assert.equal(readFileSync(path.join(root, 'user-hooks/pre-commit'), 'utf8'), 'owned');
    console.log(
      'Real Git ignored-TMPDIR index/partial-stage, subdirectory, push-ref, linked-worktree and existing-hook protection passed',
    );
    status = 'passed';
  } finally {
    writeEvidenceAfterCleanup(
      path.join(project, 'artifacts/hooks.json'),
      () => ({
        schema: 1,
        baselineDifferences: baselineDifferences(project),
        phases: status === 'passed' ? hookPhases : [],
        status,
        origin: (
          JSON.parse(readFileSync(path.join(project, '.template.json'), 'utf8')) as {
            origin?: unknown;
          }
        ).origin,
        contentId: contentId(project),
        os: process.platform,
        milliseconds: Math.round(performance.now() - started),
      }),
      () => rmSync(owned, { recursive: true, force: true }),
    );
  }
}
if (process.argv[1]?.endsWith(`${path.sep}hooks-rehearsal.ts`)) await hookRehearsal(process.cwd());
