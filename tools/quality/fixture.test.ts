import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { copyProjectFixture, initializeVerificationGit } from './fixture.ts';
import { runSync } from '../process.ts';
import { installHooks } from './hooks.ts';

it('isolates retained verification output from parent ignore rules and hook configuration', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'verification-parent-'));
  const project = path.join(parent, 'artifacts', 'verification');
  try {
    runSync('git', ['init', '--quiet'], parent);
    writeFileSync(path.join(parent, '.gitignore'), 'artifacts/\n');
    mkdirSync(path.join(project, 'tools/quality/git-hooks'), { recursive: true });
    writeFileSync(path.join(project, 'input.ts'), 'export const value = 1;\n');
    for (const event of ['pre-commit', 'pre-push'])
      writeFileSync(path.join(project, 'tools/quality/git-hooks', event), '#!/bin/sh\nexit 0\n');
    const configuration = readFileSync(path.join(parent, '.git/config'));
    expect(runSync('git', ['check-ignore', 'input.ts'], project)).toBe('input.ts');
    initializeVerificationGit(project);
    expect(realpathSync.native(runSync('git', ['rev-parse', '--show-toplevel'], project))).toBe(
      realpathSync.native(project),
    );
    expect(() => runSync('git', ['check-ignore', 'input.ts'], project)).toThrow('git failed:');
    installHooks(project);
    const alias = path.join(parent, 'logical-alias');
    symlinkSync(project, alias, 'junction');
    installHooks(alias);
    expect(runSync('git', ['config', '--local', '--get', 'core.hooksPath'], project)).toBe(
      'tools/quality/git-hooks',
    );
    expect(readFileSync(path.join(parent, '.git/config'))).toEqual(configuration);
    expect(readFileSync(path.join(project, 'input.ts'), 'utf8')).toBe('export const value = 1;\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

it.each(['.git', '.GIT'])(
  'protects existing %s metadata instead of reinitializing a user repository',
  (metadata) => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'verification-owned-'));
    try {
      mkdirSync(path.join(project, metadata));
      writeFileSync(path.join(project, metadata, 'user.txt'), 'Preserve user Git data');
      expect(() => initializeVerificationGit(project)).toThrow(
        'existing Git metadata is protected',
      );
      expect(readFileSync(path.join(project, metadata, 'user.txt'), 'utf8')).toBe(
        'Preserve user Git data',
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  },
);

it('rehearses the complete first-party input when legal apps and source resemble SDK outputs', () => {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'rehearsal-input-'));
  const source = path.join(owned, 'source');
  const destination = path.join(owned, 'copy');
  const put = (file: string, contents: string) => {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), contents);
  };
  try {
    for (const name of ['dist', 'target', 'generated', 'icons', 'gen', 'artifacts']) {
      put(
        `packages/${name}/package.json`,
        JSON.stringify({ name: `@example/${name}`, starter: { runtime: 'desktop' } }),
      );
      for (const directory of ['target', 'dist', 'generated', 'icons', 'gen', 'artifacts'])
        put(`packages/${name}/src/${directory}/user.ts`, `export const value = '${name}';`);
      put(`packages/${name}/dist/bundle.js`, 'generated output');
      put(`packages/${name}/src-tauri/target/binary`, 'native output');
      put(`packages/${name}/.env.local`, 'local credential');
    }
    put('tools/generated/user.ts', 'first-party tooling');
    put('.env', 'local credential');
    copyProjectFixture(source, destination);
    for (const name of ['dist', 'target', 'generated', 'icons', 'gen', 'artifacts']) {
      expect(existsSync(path.join(destination, `packages/${name}/package.json`))).toBe(true);
      for (const directory of ['target', 'dist', 'generated', 'icons', 'gen', 'artifacts'])
        expect(
          readFileSync(path.join(destination, `packages/${name}/src/${directory}/user.ts`), 'utf8'),
        ).toBe(`export const value = '${name}';`);
      expect(existsSync(path.join(destination, `packages/${name}/dist`))).toBe(false);
      expect(existsSync(path.join(destination, `packages/${name}/src-tauri/target`))).toBe(false);
      expect(existsSync(path.join(destination, `packages/${name}/.env.local`))).toBe(false);
    }
    expect(readFileSync(path.join(destination, 'tools/generated/user.ts'), 'utf8')).toBe(
      'first-party tooling',
    );
    expect(existsSync(path.join(destination, '.env'))).toBe(false);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
