import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runSync } from '../process.ts';
import { assertCheckout, headSha } from './checkout.ts';
import { initializeVerificationGit } from './fixture.ts';

it('records no SHA for an unborn repository and the real SHA only after a commit', () => {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'checkout-unborn-'));
  const root = path.join(owned, 'project');
  try {
    // TMPDIR can belong to a committed parent checkout. An independent unborn
    // boundary retains the no-HEAD assertion without inheriting that history.
    initializeVerificationGit(owned);
    mkdirSync(root);
    expect(headSha(root)).toBeNull();
    runSync('git', ['init', '--quiet', '--template='], root);
    expect(headSha(root)).toBeNull();
    writeFileSync(path.join(root, 'input.txt'), 'Actual commit input');
    runSync('git', ['add', 'input.txt'], root);
    runSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Input'],
      root,
    );
    expect(headSha(root)).toBe(runSync('git', ['rev-parse', '--verify', 'HEAD'], root));
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});

it('rejects preparation edits and first-party untracked files against the requested commit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'checkout-input-'));
  const git = (args: string[]) => runSync('git', args, root);
  try {
    git(['init', '-q']);
    writeFileSync(path.join(root, 'input.txt'), 'committed');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'input',
    ]);
    const sha = git(['rev-parse', 'HEAD']);
    assertCheckout(root, sha);
    writeFileSync(path.join(root, 'input.txt'), 'autofixed by setup');
    expect(() => assertCheckout(root, sha)).toThrow(
      /Preparation changed the committed input.*input.txt/su,
    );
    git(['checkout', '--', 'input.txt']);
    writeFileSync(path.join(root, 'unexpected.ts'), 'new generated source');
    expect(() => assertCheckout(root, sha)).toThrow(/unexpected.ts/u);
    expect(() => assertCheckout(root, '0'.repeat(40))).toThrow(/Checkout HEAD changed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
