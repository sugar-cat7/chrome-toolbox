import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { digest } from './files.ts';
import { baselineDifferences } from './baseline.ts';

it.each(['web', 'desktop'])(
  'keeps added %s shared UI owned when syncing an API reference',
  async (kind) => {
    const { main } = await import('./cli.ts');
    const { projectFiles } = await import('./render.ts');
    const { projectOptions } = await import('./options.ts');
    const { applyFiles } = await import('./files.ts');
    const root = mkdtempSync(path.join(os.tmpdir(), 'reference-shared-sync-'));
    try {
      const options = projectOptions({
        name: 'shared-example',
        scope: '@shared-example',
        preset: 'api',
      });
      applyFiles(
        root,
        projectFiles(path.resolve(import.meta.dirname, '../..'), options, 'reference'),
      );
      writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'fixture lock');
      await main(['add', '--target', root, '--kind', kind, '--name', 'companion', '--no-install']);
      await main(['sync', '--target', root, '--no-install']);
      await main(['sync', '--target', root, '--check', '--no-install']);
      const state = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8'));
      expect(state.packages).toContain('ui');
      expect(state.packages).toContain('companion');
      expect(baselineDifferences(root)).toEqual([]);
      const ui = path.join(root, 'packages/ui/src/index.tsx');
      const edited = `${readFileSync(ui, 'utf8')}\n// user UI change\n`;
      writeFileSync(ui, edited);
      await expect(main(['sync', '--target', root, '--no-install'])).rejects.toThrow(
        'User change or collision',
      );
      expect(readFileSync(ui, 'utf8')).toBe(edited);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('regenerates an added reference service and protects edits without changing the original app', async () => {
  const { main } = await import('./cli.ts');
  const { projectFiles } = await import('./render.ts');
  const { projectOptions } = await import('./options.ts');
  const { applyFiles } = await import('./files.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'reference-service-sync-'));
  try {
    const options = projectOptions({
      name: 'service-example',
      scope: '@service-example',
      preset: 'api',
    });
    applyFiles(
      root,
      projectFiles(path.resolve(import.meta.dirname, '../..'), options, 'reference'),
    );
    const original = readFileSync(path.join(root, 'packages/api/src/index.ts'));
    await main([
      'add',
      '--target',
      root,
      '--kind',
      'api',
      '--name',
      'jobs',
      '--features',
      'kv',
      '--no-install',
    ]);
    await main(['sync', '--target', root, '--no-install']);
    await main(['sync', '--target', root, '--check', '--no-install']);
    const state = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8'));
    expect(state.packages).toContain('jobs');
    expect(state.referenceApps.jobs).toMatchObject({
      preset: 'api',
      features: ['kv'],
      scope: '@service-example',
    });
    expect(readFileSync(path.join(root, 'packages/jobs/cloudflare.config.ts'), 'utf8')).toContain(
      'bindings.kv',
    );
    expect(readFileSync(path.join(root, 'packages/api/src/index.ts'))).toEqual(original);
    const service = path.join(root, 'packages/jobs/src/index.ts');
    const edited = `${readFileSync(service, 'utf8')}\n// user change\n`;
    writeFileSync(service, edited);
    await expect(main(['sync', '--target', root, '--no-install'])).rejects.toThrow(
      'User change or collision',
    );
    expect(readFileSync(service, 'utf8')).toBe(edited);
    expect(readFileSync(path.join(root, 'packages/api/src/index.ts'))).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('syncs the reference lock baseline after dependency updates without rewriting the lock', async () => {
  const { main } = await import('./cli.ts');
  const { projectFiles } = await import('./render.ts');
  const { projectOptions } = await import('./options.ts');
  const { applyFiles } = await import('./files.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'reference-lock-sync-'));
  try {
    const options = projectOptions({ name: 'lock-example', scope: '@lock-example', preset: 'api' });
    applyFiles(
      root,
      projectFiles(path.resolve(import.meta.dirname, '../..'), options, 'reference'),
    );
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'updated lock');
    expect(baselineDifferences(root)).toContain('pnpm-lock.yaml');
    await main(['sync', '--target', root, '--no-install']);
    expect(baselineDifferences(root)).toEqual([]);
    expect(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('updated lock');
    await main(['sync', '--target', root, '--check']);
    const state = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8'));
    state.kind = 'project';
    writeFileSync(path.join(root, '.template.json'), JSON.stringify(state));
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'user lock change');
    await expect(main(['sync', '--target', root, '--no-install'])).rejects.toThrow(
      'sync is only for the reference workspace',
    );
    expect(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('user lock change');
    expect(baselineDifferences(root)).toContain('pnpm-lock.yaml');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('distinguishes an unchanged generated baseline from feature edits and extra source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-baseline-'));
  try {
    const files = {
      'packages/example/package.json': JSON.stringify({
        name: '@scope/example',
        starter: { runtime: 'library' },
      }),
      'packages/example/src/index.ts': 'export const value=1;',
      'pnpm-lock.yaml': 'lock',
    };
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        managed: Object.fromEntries(
          Object.entries(files)
            .filter(([name]) => name !== 'pnpm-lock.yaml')
            .map(([name, text]) => [name, digest(text)]),
        ),
        lockId: digest('lock'),
      }),
    );
    expect(baselineDifferences(root)).toEqual([]);
    writeFileSync(path.join(root, 'packages/example/src/index.ts'), 'export const value=2;');
    writeFileSync(path.join(root, 'packages/example/src/extra.test.ts'), 'feature regression');
    expect(baselineDifferences(root)).toEqual([
      'packages/example/src/extra.test.ts',
      'packages/example/src/index.ts',
    ]);
    expect(readFileSync(path.join(root, 'packages/example/src/index.ts'), 'utf8')).toContain(
      'value=2',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('inherits canonical provenance without Git only while the generated baseline is unchanged', async () => {
  const { generationOrigin } = await import('./render.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-origin-'));
  const sha = 'a'.repeat(40);
  try {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        kind: 'project',
        managed: { 'package.json': digest('{}') },
        lockId: digest('lock'),
        origin: { sha, dirty: false },
      }),
    );
    expect(generationOrigin(root)).toEqual({ sha, dirty: false });
    rmSync(path.join(root, 'pnpm-lock.yaml'));
    expect(generationOrigin(root)).toEqual({ sha: null, dirty: true });
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(path.join(root, 'package.json'), 'feature');
    expect(generationOrigin(root)).toEqual({ sha: null, dirty: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('renders renamed Desktop locks in Cargo order without changing locked dependencies', async () => {
  const { appFiles } = await import('./render.ts');
  const { projectOptions } = await import('./options.ts');
  const source = path.resolve(import.meta.dirname, '../..');
  const blueprint = readFileSync(
    path.join(source, 'tools/generators/templates/desktop/src-tauri/Cargo.lock.template'),
    'utf8',
  );
  const blocks = (lock: string) =>
    lock
      .split('[[package]]\n')
      .slice(1)
      .map((block) => block.trimEnd());
  const dependencyBlocks = blocks(blueprint)
    .filter((block) => !block.includes('name = "__PROJECT__-__APP__"'))
    .sort();
  for (const name of ['aaa-notes', 'zzz-notes']) {
    const options = projectOptions({ name, scope: '@renamed', preset: 'desktop' });
    const lock = appFiles(source, options, 'desktop', 'desktop', false)
      .get('packages/desktop/src-tauri/Cargo.lock')!
      .toString();
    const packages = blocks(lock);
    const names = packages.map((block) => /^name = "([^"]+)"/mu.exec(block)![1]!);
    expect(names).toEqual([...names].sort());
    expect(packages.filter((block) => !block.includes(`name = "${name}-desktop"`)).sort()).toEqual(
      dependencyBlocks,
    );
  }
});

it('fingerprints legal app names and first-party directories that resemble generated caches', async () => {
  const { contentId } = await import('../quality/gate.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-fingerprint-'));
  try {
    mkdirSync(path.join(root, 'packages/dist/src/target'), { recursive: true });
    mkdirSync(path.join(root, 'packages/dist/dist'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/dist/package.json'),
      JSON.stringify({ name: '@example/dist', starter: { runtime: 'library' } }),
    );
    const before = contentId(root);
    writeFileSync(path.join(root, 'packages/dist/src/target/user.ts'), 'source');
    const after = contentId(root);
    expect(after).not.toBe(before);
    writeFileSync(path.join(root, 'packages/dist/dist/generated.mjs'), 'build');
    expect(contentId(root)).toBe(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('renders identical frozen Cargo locks and binding-free config from LF and CRLF blueprints', async () => {
  const { appFiles } = await import('./render.ts');
  const { projectOptions } = await import('./options.ts');
  const source = path.resolve(import.meta.dirname, '../..');
  const copy = mkdtempSync(path.join(os.tmpdir(), 'crlf-blueprints-'));
  try {
    const templates = 'tools/generators/templates';
    mkdirSync(path.join(copy, 'tools/generators'), { recursive: true });
    cpSync(path.join(source, templates), path.join(copy, templates), { recursive: true });
    mkdirSync(path.join(copy, 'tools/errors'), { recursive: true });
    cpSync(
      path.join(source, 'tools/errors/catalog.json'),
      path.join(copy, 'tools/errors/catalog.json'),
    );
    for (const file of [
      'desktop/src-tauri/Cargo.lock.template',
      'web/cloudflare.config.ts.template',
    ]) {
      const filename = path.join(copy, templates, file);
      writeFileSync(filename, readFileSync(filename, 'utf8').replaceAll('\n', '\r\n'));
    }
    const configs: string[] = [];
    for (const preset of ['desktop', 'web']) {
      const options = projectOptions({ name: 'zzz-notes', scope: '@new-os', preset });
      const expected = appFiles(source, options, preset, preset, false);
      const actual = appFiles(copy, options, preset, preset, false);
      expect([...actual]).toEqual([...expected]);
      const config = actual.get('packages/web/cloudflare.config.ts')?.toString();
      if (config) configs.push(config);
    }
    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toContain('const required');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
