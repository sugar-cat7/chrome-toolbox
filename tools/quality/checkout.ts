import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { runSync } from '../process.ts';

export function foreignGitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // An explicit project root owns its Git metadata, including linked worktrees.
  for (const name of runSync('git', ['rev-parse', '--local-env-vars'], root).split('\n'))
    delete environment[name];
  return environment;
}

export function headSha(root: string, environment = process.env): string | null {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return head.status === 0 ? head.stdout.trim() : null;
}
export function ownHeadSha(root: string): string | null {
  let environment: NodeJS.ProcessEnv;
  try {
    environment = foreignGitEnvironment(root);
  } catch {
    return null;
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (top.status !== 0 || realpathSync.native(top.stdout.trim()) !== realpathSync.native(root))
    return null;
  return headSha(root, environment);
}

export function assertCheckout(root: string, expected: string): void {
  const head = runSync('git', ['rev-parse', 'HEAD'], root);
  if (head !== expected)
    throw new Error(`Checkout HEAD changed: expected ${expected}, got ${head}`);
  const difference = spawnSync('git', ['diff', '--name-only', expected, '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (difference.status !== 0) throw new Error('Unable to inspect checkout changes');
  const untracked = runSync('git', ['ls-files', '--others', '--exclude-standard'], root);
  const names = [difference.stdout.trim(), untracked].filter(Boolean).join('\n');
  if (names) throw new Error(`Preparation changed the committed input:\n${names}`);
  console.log(`Verified immutable checkout ${head}`);
}

if (process.argv[1]?.endsWith(`${path.sep}checkout.ts`)) {
  const expected = process.env.CI_HEAD_SHA ?? process.argv[2];
  if (!expected) throw new Error('Provide the expected checkout SHA');
  assertCheckout(process.cwd(), expected);
}
