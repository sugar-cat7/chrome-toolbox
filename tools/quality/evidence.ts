import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pnpmCommand, runSync } from '../process.ts';
import { walk } from '../generators/files.ts';
import { workspacePackages } from './graph.ts';

export function writeEvidenceAfterCleanup<T extends { status: string; error?: string }>(
  filename: string,
  report: T | (() => T),
  cleanup: () => void,
): void {
  const failures: unknown[] = [];
  let result: { status: string; error?: string };
  try {
    result = typeof report === 'function' ? report() : report;
  } catch (error) {
    failures.push(error);
    result = { status: 'failed', error: `Evidence preparation failed: ${String(error)}` };
  }
  try {
    cleanup();
  } catch (error) {
    failures.push(error);
    result.status = 'failed';
    result.error = [result.error, `Evidence cleanup failed: ${String(error)}`]
      .filter(Boolean)
      .join('\n');
  }
  try {
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Evidence finalization failed');
}

export function toolVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = { node: process.version };
  const manager = pnpmCommand(['--version']);
  versions.pnpm = runSync(manager.command, manager.args, root);
  for (const directory of ['.', ...workspacePackages(root).map((pkg) => pkg.directory)]) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      const file = path.join(root, directory, 'node_modules', dependency, 'package.json');
      if (existsSync(file))
        versions[dependency] = (
          JSON.parse(readFileSync(file, 'utf8')) as { version: string }
        ).version;
    }
  }
  return versions;
}

export function artifactSizes(root: string): { path: string; bytes: number; gzipBytes?: number }[] {
  const sizes: { path: string; bytes: number; gzipBytes?: number }[] = [];
  for (const pkg of workspacePackages(root)) {
    for (const directory of ['dist', '.cloudflare/output/v0/workers/default/bundle']) {
      const relative = `${pkg.directory}/${directory}`;
      if (!existsSync(path.join(root, relative))) continue;
      for (const file of walk(path.join(root, relative))) {
        const contents = readFileSync(path.join(root, relative, file));
        sizes.push({
          path: `${relative}/${file}`,
          bytes: contents.length,
          gzipBytes: gzipSync(contents).length,
        });
      }
    }
    if (pkg.runtime === 'desktop') {
      const cargo = readFileSync(path.join(root, pkg.directory, 'src-tauri/Cargo.toml'), 'utf8');
      const name = /^name = "([^"]+)"/mu.exec(cargo)?.[1];
      for (const target of ['release', 'e2e']) {
        const relative = `.state/${path.basename(pkg.directory)}/target-${target}/release/${name}${process.platform === 'win32' ? '.exe' : ''}`;
        if (existsSync(path.join(root, relative)))
          sizes.push({ path: relative, bytes: statSync(path.join(root, relative)).size });
      }
    }
  }
  return sizes;
}
