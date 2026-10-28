import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verificationIdentity } from './identity.ts';
import { generationOrigin } from '../generators/render.ts';
import { headSha, ownHeadSha } from '../quality/checkout.ts';
import { runSync } from '../process.ts';
import { digest } from '../generators/files.ts';

it('uses the source SHA without Git or original repository access and rejects mismatched CI inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o11y-identity-'));
  try {
    const sha = 'a'.repeat(40);
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({ kind: 'project', origin: { sha } }),
    );
    expect(verificationIdentity(root, sha)).toBe(sha);
    expect(() => verificationIdentity(root, 'b'.repeat(40))).toThrow(/does not match/u);
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({ kind: 'project', origin: { sha: null } }),
    );
    expect(() => verificationIdentity(root, sha)).toThrow(/known source SHA/u);
  } finally {
    rmSync(root, { recursive: true });
  }
});
it('prefers an owned generated checkout, excludes enclosing Git and keeps no-Git source provenance for regeneration', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'o11y-owned-'));
  const root = path.join(parent, 'project');
  const git = (cwd: string, ...args: string[]) => runSync('git', args, cwd);
  const commit = (cwd: string) => {
    git(cwd, 'init', '--quiet', '--template=');
    git(cwd, 'add', '.');
    git(
      cwd,
      '-c',
      'user.name=Identity test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Input',
    );
    return git(cwd, 'rev-parse', 'HEAD');
  };
  try {
    mkdirSync(root);
    const source = 'a'.repeat(40);
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        kind: 'project',
        managed: { 'package.json': digest('{}') },
        lockId: digest('lock'),
        origin: { sha: source, dirty: false },
      }),
    );
    expect(ownHeadSha(root)).toBeNull();
    expect(verificationIdentity(root, source)).toBe(source);
    expect(generationOrigin(root)).toEqual({ sha: source, dirty: false });
    const enclosing = commit(parent);
    expect(ownHeadSha(root)).toBeNull();
    expect(verificationIdentity(root, source)).toBe(source);
    expect(() => verificationIdentity(root, enclosing)).toThrow(/does not match/u);
    expect(generationOrigin(root)).toEqual({ sha: source, dirty: false });
    vi.stubEnv('GIT_DIR', path.join(parent, '.git'));
    expect(headSha(root)).toBe(enclosing);
    expect(ownHeadSha(root)).toBeNull();
    expect(verificationIdentity(root, source)).toBe(source);
    expect(generationOrigin(root)).toEqual({ sha: source, dirty: false });
    vi.unstubAllEnvs();
    const owned = commit(root);
    expect(ownHeadSha(root)).toBe(owned);
    expect(verificationIdentity(root, owned)).toBe(owned);
    expect(() => verificationIdentity(root, source)).toThrow(/does not match/u);
    expect(generationOrigin(root)).toEqual({ sha: owned, dirty: false });
    writeFileSync(path.join(parent, 'parent-only.txt'), 'Foreign dirty input');
    vi.stubEnv('GIT_DIR', path.join(parent, '.git'));
    expect(headSha(root)).toBe(enclosing);
    expect(ownHeadSha(root)).toBe(owned);
    expect(verificationIdentity(root, owned)).toBe(owned);
    expect(generationOrigin(root)).toEqual({ sha: owned, dirty: false });
    writeFileSync(path.join(root, 'package.json'), '{"changed":true}');
    expect(generationOrigin(root)).toEqual({ sha: owned, dirty: true });
  } finally {
    vi.unstubAllEnvs();
    rmSync(parent, { recursive: true });
  }
});
