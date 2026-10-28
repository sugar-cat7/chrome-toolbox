import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Reference sync updates ownership hashes even for docs-only edits. Compare the
// metadata's meaning, not its filename; unverifiable state stays a broad change.
export function executionChanges(root: string, changed: string[], base?: string): string[] {
  if (!changed.includes('.template.json') || !base || !/^[a-f0-9]{40,64}$/u.test(base))
    return changed;
  try {
    const previous = spawnSync('git', ['show', `${base}:.template.json`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (previous.status !== 0) return changed;
    const before = JSON.parse(previous.stdout) as Record<string, unknown>;
    const after = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (!isDeepStrictEqual({ ...before, managed: undefined }, { ...after, managed: undefined }))
      return changed;
    const oldHashes = before.managed;
    const newHashes = after.managed;
    if (
      !oldHashes ||
      !newHashes ||
      typeof oldHashes !== 'object' ||
      typeof newHashes !== 'object' ||
      Array.isArray(oldHashes) ||
      Array.isArray(newHashes)
    )
      return changed;
    const oldEntries = oldHashes as Record<string, unknown>;
    const newEntries = newHashes as Record<string, unknown>;
    for (const file of new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)])) {
      if (oldEntries[file] === newEntries[file]) continue;
      if (
        !changed.includes(file) ||
        file === '.template.json' ||
        !file ||
        file.split('/').some((part) => part === '..') ||
        path.isAbsolute(file)
      )
        return changed;
      const target = path.join(root, file);
      const hash = newEntries[file];
      if (hash === undefined) {
        if (existsSync(target)) return changed;
      } else if (
        typeof hash !== 'string' ||
        createHash('sha256').update(readFileSync(target)).digest('hex') !== hash
      )
        return changed;
    }
    return changed.filter((file) => file !== '.template.json');
  } catch {
    return changed;
  }
}

export type WorkspacePackage = {
  name: string;
  directory: string;
  runtime: 'library' | 'worker' | 'desktop';
  dependencies: string[];
  scripts: Record<string, string>;
};

export function workspacePackages(root: string): WorkspacePackage[] {
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(packages, entry.name, 'package.json')),
    )
    .map((entry) => {
      const directory = `packages/${entry.name}`;
      const manifest = JSON.parse(
        readFileSync(path.join(root, directory, 'package.json'), 'utf8'),
      ) as {
        name: string;
        starter?: { runtime?: string };
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const runtime = manifest.starter?.runtime ?? 'library';
      if (!['library', 'worker', 'desktop'].includes(runtime))
        throw new Error(`Unknown starter.runtime ${runtime} in ${directory}/package.json`);
      return {
        name: manifest.name,
        directory,
        runtime: runtime as WorkspacePackage['runtime'],
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
        }),
        scripts: manifest.scripts ?? {},
      };
    });
}

export function affectedPackages(
  packages: WorkspacePackage[],
  changed: readonly string[] | undefined,
): WorkspacePackage[] {
  if (changed === undefined) return packages;
  const selected = new Set<string>();
  for (const filename of changed) {
    if (documentationChange(filename) || toolingOnlyChange(filename)) continue;
    const blueprint = /^tools\/generators\/templates\/([^/]+)\//u.exec(filename)?.[1];
    if (blueprint) {
      const owners = packages.filter((pkg) =>
        blueprint === 'worker'
          ? pkg.runtime === 'worker'
          : blueprint === 'desktop'
            ? pkg.runtime === 'desktop'
            : pkg.directory === `packages/${blueprint}`,
      );
      if (!owners.length) return packages;
      for (const owner of owners) selected.add(owner.name);
      continue;
    }
    if (!filename.startsWith('packages/')) return packages;
    const owner = packages.find(
      (pkg) => filename === pkg.directory || filename.startsWith(`${pkg.directory}/`),
    );
    // A removed or unrecognised package can still have consumers in the base.
    if (!owner) return packages;
    selected.add(owner.name);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const pkg of packages) {
      if (!selected.has(pkg.name) && pkg.dependencies.some((name) => selected.has(name))) {
        selected.add(pkg.name);
        expanded = true;
      }
    }
  }
  return packages.filter((pkg) => selected.has(pkg.name));
}

// These paths still receive global static/tooling checks. They do not change an
// application runtime; unknown paths deliberately retain the broad fallback.
export function documentationChange(filename: string): boolean {
  return (
    /^(?:docs\/.*\.(?:md|txt|rst|adoc)$|\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE))/u.test(
      filename,
    ) ||
    /^\.agents\/.*\.md$/u.test(filename) ||
    /^(?:[^/]+\.md|LICENSE|NOTICE)$/u.test(filename) ||
    /^packages\/[^/]+\/(?:README\.md$|docs\/.*\.(?:md|txt|rst|adoc)$)/u.test(filename)
  );
}

export function toolingOnlyChange(filename: string): boolean {
  return (
    /^tools\/.*\.test\.ts$/u.test(filename) ||
    /^tools\/(?:security|o11y)\//u.test(filename) ||
    /^tools\/quality\/(?:ci-plan|graph|acceptance)\.ts$/u.test(filename) ||
    /^(?:mise\.(?:security|o11y)\.toml|renovate\.json|\.semgrepignore|\.github\/workflows\/security\.yml)$/u.test(
      filename,
    )
  );
}
