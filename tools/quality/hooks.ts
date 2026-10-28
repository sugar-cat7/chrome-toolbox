import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { pnpm, runSync, run } from '../process.ts';
import { workspacePackages } from './graph.ts';
import { initializeVerificationGit } from './fixture.ts';
import { foreignGitEnvironment } from './checkout.ts';
export { foreignGitEnvironment } from './checkout.ts';

const hookPath = 'tools/quality/git-hooks';
export function removeOwnedWorktree(root: string, snapshot: string): void {
  runSync(
    'git',
    ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', snapshot],
    root,
    foreignGitEnvironment(root),
  );
  // Git deliberately retains Windows junctions and their ancestors while
  // unregistering the worktree. Finish only the successfully removed owned
  // snapshot; Node removes junctions without following their targets.
  rmSync(snapshot, { recursive: true, force: true });
}
export function installHooks(root: string): void {
  const environment = foreignGitEnvironment(root);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  });
  if (git.status !== 0) {
    console.log('Hooks not_required: no Git repository (run env:setup after git init)');
    return;
  }
  if (realpathSync.native(git.stdout.trim()) !== realpathSync.native(root))
    throw new Error(
      'Nested project belongs to a parent Git repository; run git init in this project, then env:setup. Parent Git configuration and hooks were left unchanged',
    );
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  }).stdout.trim();
  if (configured && configured !== hookPath)
    throw new Error(
      `Existing core.hooksPath ${configured}; preserve it and explicitly migrate before installing repository hooks`,
    );
  if (!configured) {
    const defaults = runSync('git', ['rev-parse', '--git-path', 'hooks'], root, environment);
    const directory = path.resolve(root, defaults);
    if (
      existsSync(directory) &&
      readdirSync(directory).some(
        (filename) =>
          !filename.endsWith('.sample') && lstatSync(path.join(directory, filename)).isFile(),
      )
    )
      throw new Error(
        'Existing user hooks found in Git hooks directory; explicit migration required',
      );
  }
  runSync('git', ['config', '--local', 'core.hooksPath', hookPath], root, environment);
  for (const event of ['pre-commit', 'pre-push'])
    chmodSync(path.join(root, hookPath, event), 0o755);
  console.log('Repository-local Git hooks installed');
}

function linkDependencies(
  source: string,
  destination: string,
  originalRoot: string,
  snapshot: string,
): void {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      linkDependencies(from, to, originalRoot, snapshot);
      continue;
    }
    const resolved = realpathSync(from);
    if (!lstatSync(resolved).isDirectory()) {
      copyFileSync(resolved, to);
      continue;
    }
    const relative = path.relative(originalRoot, resolved);
    const replacement =
      relative.startsWith(`packages${path.sep}`) &&
      !relative.includes(`${path.sep}node_modules${path.sep}`)
        ? path.join(snapshot, relative)
        : resolved;
    symlinkSync(
      replacement,
      to,
      entry.isDirectory() || lstatSync(resolved).isDirectory() ? 'junction' : 'file',
    );
  }
}

export async function indexCheck(root: string): Promise<void> {
  const environment = foreignGitEnvironment(root);
  const snapshot = mkdtempSync(path.join(os.tmpdir(), 'starter-index-'));
  try {
    runSync(
      'git',
      ['checkout-index', '--all', `--prefix=${snapshot.split(path.sep).join('/')}/`],
      root,
    );
    // TMPDIR may be inside this repository's ignored .state directory. Give
    // the exact index its own Git boundary so tools cannot inherit the parent
    // ignore rules or Git's exported routing to the user's original index.
    initializeVerificationGit(snapshot, environment);
    linkDependencies(
      path.join(root, 'node_modules'),
      path.join(snapshot, 'node_modules'),
      root,
      snapshot,
    );
    for (const pkg of workspacePackages(snapshot))
      linkDependencies(
        path.join(root, pkg.directory, 'node_modules'),
        path.join(snapshot, pkg.directory, 'node_modules'),
        root,
        snapshot,
      );
    // pnpm 12 can prepare dependencies implicitly in a copied index tree. The
    // index must stay immutable, so invoke the already-installed local CLI.
    const vp = path.join(snapshot, 'node_modules/vite-plus/bin/vp');
    await run(process.execPath, [vp, 'fmt', '--check'], {
      cwd: snapshot,
      env: environment,
      timeout: 120_000,
    });
    // Staged checks intentionally use lint rather than worktree typegen/runtime.
    await run(process.execPath, [vp, 'lint'], {
      cwd: snapshot,
      env: { ...environment, STARTER_CHECK_PHASE: 'index' },
      timeout: 120_000,
    });
    await run(process.execPath, ['tools/quality/structure.ts'], {
      cwd: snapshot,
      env: environment,
      timeout: 120_000,
    });
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith(`${path.sep}hooks.ts`)) {
  const event = process.argv[2];
  const root =
    event === 'install'
      ? process.cwd()
      : runSync('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (event === 'install') installHooks(root);
  else if (event === 'pre-commit') await indexCheck(root);
  else if (event === 'pre-push') {
    const environment = foreignGitEnvironment(root);
    let input = '';
    for await (const chunk of process.stdin) input += String(chunk);
    const commits = new Map<string, Set<string>>();
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const [, local, , remote] = line.split(' ');
      if (!local || /^0+$/u.test(local)) continue;
      const bases = commits.get(local) ?? new Set<string>();
      bases.add(remote && !/^0+$/u.test(remote) ? remote : 'unknown');
      commits.set(local, bases);
    }
    for (const [local, bases] of commits) {
      const base = bases.size === 1 ? [...bases][0]! : 'unknown';
      // Validate the actual pushed commit, including when HEAD is different.
      const snapshot = mkdtempSync(path.join(os.tmpdir(), 'starter-push-'));
      rmSync(snapshot, { recursive: true });
      try {
        runSync('git', ['worktree', 'add', '--detach', snapshot, local], root);
        await pnpm(['install', '--frozen-lockfile'], { cwd: snapshot, env: environment });
        await pnpm(['env:setup', '--', '--javascript'], { cwd: snapshot, env: environment });
        await run(process.execPath, ['tools/quality/checkout.ts', local], {
          cwd: snapshot,
          env: { ...environment, CI_HEAD_SHA: local },
        });
        await pnpm(['gate:push', '--', '--base', base], { cwd: snapshot, env: environment });
      } finally {
        removeOwnedWorktree(root, snapshot);
      }
    }
  } else throw new Error(`Unknown hook event: ${event}`);
}
