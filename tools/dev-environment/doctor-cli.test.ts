import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { pnpmCommand } from '../process.ts';

it('runs the real doctor CLI without automatic dependency preparation', () => {
  const source = process.cwd();
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-readonly-doctor-'));
  try {
    for (const file of [
      'tools/dev-environment/doctor.ts',
      'tools/quality/graph.ts',
      'tools/process.ts',
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      copyFileSync(path.join(source, file), path.join(root, file));
    }
    const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'readonly-doctor-fixture',
        private: true,
        type: 'module',
        packageManager: manifest.packageManager,
        scripts: { 'env:doctor': 'node tools/dev-environment/doctor.ts' },
        devDependencies: { 'vite-plus': '1.1.0' },
      }),
    );
    copyFileSync(path.join(source, 'mise.toml'), path.join(root, 'mise.toml'));
    // The supplied lock pins the package manager. Application dependencies are
    // intentionally unprepared; offline mode makes any implicit install observable.
    const managerLock = `---\n${
      readFileSync(path.join(source, 'pnpm-lock.yaml'), 'utf8')
        .split(/^---\s*$/mu)
        .filter((part) => part.trim())[0]
    }`;
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), managerLock);
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      `${readFileSync(path.join(source, 'pnpm-workspace.yaml'), 'utf8')}\noffline: true\nstoreDir: .state/store\ncacheDir: .state/cache\n`,
    );
    const invocation = pnpmCommand(['env:doctor']);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Project-local Vite+ required');
    expect(result.stdout).toContain('Template state required');
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /installing dependencies|install that runs before scripts|NO_OFFLINE_META/u,
    );
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(root, '.state'))).toBe(false);
    expect(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(managerLock);
    const javascriptInvocation = pnpmCommand(['env:doctor', '--', '--javascript']);
    const javascript = spawnSync(javascriptInvocation.command, javascriptInvocation.args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(javascript.error).toBeUndefined();
    expect(javascript.status).toBe(1);
    expect(javascript.stdout).toContain('"scope": "javascript"');
    expect(javascript.stdout).toContain('Project-local Vite+ required');
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
    expect(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(managerLock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
