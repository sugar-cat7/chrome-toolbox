import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ciPlan } from './ci-plan.ts';

it('plans runtime checks on the changed real application, skips unrelated native work, and restores all checks for infrastructure changes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-ci-plan-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI planning test');
    git('config', 'user.email', 'test@example.invalid');
    for (const [name, runtime, dependencies] of [
      ['api', 'worker', {}],
      ['web', 'worker', { '@test/api': 'workspace:*' }],
      ['desktop', 'desktop', {}],
    ] as const) {
      mkdirSync(path.join(root, 'packages', name), { recursive: true });
      writeFileSync(
        path.join(root, 'packages', name, 'package.json'),
        JSON.stringify({
          name: `@test/${name}`,
          starter: { runtime },
          dependencies,
          scripts: { test: 'test', build: 'build', 'test:runtime': 'runtime' },
        }),
      );
    }
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'packages/api/source.ts'), 'broken implementation');
    git('add', '.');
    git('commit', '-qm', 'API change');
    const api = ciPlan(root, base);
    expect(api.selected).toEqual(['@test/api', '@test/web']);
    expect(api.checks).toContain('@test/api/runtime');
    expect(api.native).toBe(false);
    expect(api.fixtures).toBe(false);
    expect(api.observability).toBe(false);
    writeFileSync(path.join(root, 'mise.toml'), 'changed infrastructure');
    git('add', '.');
    git('commit', '-qm', 'root change');
    const all = ciPlan(root, base);
    expect(all.nativeMatrix.include).toHaveLength(3);
    expect(all.fixtures).toBe(true);
    expect(all.observability).toBe(true);
    expect(all.checks).toContain('@test/desktop/native');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('minimal CI execution with an actual committed diff', () => {
  const fixtureGit = (root: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=CI scope test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  const createBaseline = (desktop: boolean) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'starter-ci-baseline-'));
    const git = (...args: string[]) => fixtureGit(root, ...args);
    try {
      git('init', '-q');
      for (const [name, runtime, dependencies] of [
        ['contracts', 'library', {}],
        ['ui', 'library', { '@test/contracts': 'workspace:*' }],
        ['observability', 'library', { '@test/contracts': 'workspace:*' }],
        [
          'api',
          'worker',
          { '@test/contracts': 'workspace:*', '@test/observability': 'workspace:*' },
        ],
        [
          'web',
          'worker',
          {
            '@test/api': 'workspace:*',
            '@test/ui': 'workspace:*',
            '@test/observability': 'workspace:*',
          },
        ],
        ['desktop', 'desktop', { '@test/ui': 'workspace:*', '@test/observability': 'workspace:*' }],
      ] as const) {
        if (name === 'desktop' && !desktop) continue;
        mkdirSync(path.join(root, 'packages', name), { recursive: true });
        writeFileSync(
          path.join(root, 'packages', name, 'package.json'),
          JSON.stringify({
            name: `@test/${name}`,
            starter: { runtime },
            dependencies,
            scripts: { test: 'test', build: 'build', 'test:runtime': 'runtime' },
          }),
        );
      }
      const state = {
        version: '0.1.0',
        kind: 'project',
        options: { name: 'test', scope: '@test', preset: 'fullstack-desktop', features: [] },
        packages: [
          'contracts',
          'ui',
          'observability',
          'api',
          'web',
          ...(!desktop ? [] : ['desktop']),
        ],
        managed: {} as Record<string, string>,
        lock: 'baseline-lock',
      };
      writeFileSync(path.join(root, '.template.json'), JSON.stringify(state));
      git('add', '.');
      git('commit', '-qm', 'baseline');
      const base = git('rev-parse', 'HEAD');
      return { root, base, state };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  };
  const baselines = new Map<boolean, ReturnType<typeof createBaseline>>();
  afterAll(() => {
    for (const { root } of baselines.values()) rmSync(root, { recursive: true, force: true });
  });
  const planFor = (
    files: string[],
    full = false,
    unknown = false,
    configuration: {
      desktop?: boolean;
      metadata?: 'options' | 'lock' | 'version' | 'invalid-hash' | 'orphan-hash' | 'removed-state';
    } = {},
  ) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'starter-ci-scope-'));
    const git = (...args: string[]) => fixtureGit(root, ...args);
    try {
      const desktop = configuration.desktop !== false;
      let baseline = baselines.get(desktop);
      if (!baseline) {
        baseline = createBaseline(desktop);
        baselines.set(desktop, baseline);
      }
      // Each case owns a byte copy of the real repository, including refs/index.
      // It still commits its own input and exercises actual Git diff/show logic.
      cpSync(baseline.root, root, { recursive: true });
      const { base } = baseline;
      const state = JSON.parse(
        readFileSync(path.join(root, '.template.json'), 'utf8'),
      ) as ReturnType<typeof createBaseline>['state'];
      for (const file of files) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        const value =
          file === 'packages/api/package.json'
            ? JSON.stringify({
                name: '@test/api',
                starter: { runtime: 'worker' },
                dependencies: {
                  '@test/contracts': 'workspace:*',
                  '@test/observability': 'workspace:*',
                },
                scripts: { test: 'test', build: 'build', 'test:runtime': 'runtime' },
                description: 'changed',
              })
            : 'changed';
        writeFileSync(path.join(root, file), value);
        state.managed[file] = createHash('sha256').update(value).digest('hex');
      }
      // Real sync/init keeps ownership hashes current even for README changes.
      // Test that input, rather than omitting the state diff that used to expand CI.
      if (configuration.metadata === 'options') state.options.scope = '@renamed';
      if (configuration.metadata === 'lock') state.lock = 'new-lock';
      if (configuration.metadata === 'version') state.version = '0.2.0';
      if (configuration.metadata === 'invalid-hash') state.managed[files[0]!] = 'unverified';
      if (configuration.metadata === 'orphan-hash') state.managed['uncommitted.md'] = 'unverified';
      if (configuration.metadata === 'removed-state') rmSync(path.join(root, '.template.json'));
      else writeFileSync(path.join(root, '.template.json'), JSON.stringify(state));
      git('add', '.');
      git('commit', '--allow-empty', '-qm', 'scope change');
      return ciPlan(root, unknown ? 'unavailable-base' : base, full);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  it('runs no application, generated, native, Windows Worker or O11y work for docs-only changes', () => {
    const plan = planFor(['README.md', 'docs/quality.md', '.agents/skills/frontend/SKILL.md']);
    expect(plan.selected).toEqual([]);
    expect(plan.checks).toEqual([]);
    expect(plan.rawChanged).toContain('.template.json');
    expect(plan.changed).not.toContain('.template.json');
    expect([plan.fixtures, plan.native, plan.workers, plan.observability]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
  it('keeps ordinary API changes on its real consumers and avoids unrelated rehearsals', () => {
    const plan = planFor(['packages/api/src/index.ts']);
    expect(plan.selected).toEqual(['@test/api', '@test/web']);
    expect(plan.workers).toBe(true);
    expect(plan.fixturesMatrix.include).toEqual([]);
    expect(plan.native).toBe(false);
    expect(plan.observability).toBe(false);
  });
  it('does not treat a Desktop style change as a telemetry producer change', () => {
    const plan = planFor(['packages/desktop/src/styles.css']);
    expect(plan.nativeMatrix.include).toHaveLength(3);
    expect(plan.observability).toBe(false);
  });
  it('runs Desktop on all three actual operating systems without generating every preset', () => {
    const plan = planFor(['packages/desktop/src-tauri/src/main.rs']);
    expect(plan.selected).toEqual(['@test/desktop']);
    expect(plan.nativeMatrix.include).toHaveLength(3);
    expect(plan.fixtures).toBe(false);
    expect(plan.workers).toBe(false);
    expect(plan.observability).toBe(true);
    expect(plan.nativeBase).toBe('unknown');
  });
  it('selects only Web-consuming blueprint configurations, with renderer-only validation for unrelated Desktop', () => {
    const plan = planFor(['tools/generators/templates/web/src/routes/about.tsx.template']);
    expect(plan.selected).toEqual(['@test/web']);
    expect(plan.native).toBe(false);
    expect(plan.observability).toBe(false);
    expect(plan.fixturesMatrix.include.map((row) => row.preset)).toEqual([
      'web',
      'fullstack',
      'fullstack-desktop',
      'web-bindings',
      'web-d1',
      'web-kv',
      'web-r2',
    ]);
    expect(
      plan.fixturesMatrix.include.every(
        (row) => !row.native && !row.faults && !row.hooks && !row.lifecycle,
      ),
    ).toBe(true);
  });
  it('retains cross-runtime coverage for shared contracts and skips unrelated generation', () => {
    const plan = planFor(['packages/contracts/src/index.ts']);
    expect(plan.selected).toHaveLength(6);
    expect(plan.native).toBe(true);
    expect(plan.workers).toBe(true);
    expect(plan.fixtures).toBe(false);
  });
  it('keeps planner/test-only changes lightweight', () => {
    const plan = planFor(['tools/quality/ci-plan.ts', 'tools/quality/ci-plan.test.ts']);
    expect(plan.selected).toEqual([]);
    expect([plan.fixtures, plan.native, plan.workers, plan.observability]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
  it('validates O11y-only changes with fresh native provenance even when app reverse dependencies are empty', () => {
    const plan = planFor(['tools/o11y/policy.ts']);
    expect(plan.selected).toEqual([]);
    expect(plan.observability).toBe(true);
    expect(plan.nativeMatrix.include).toHaveLength(3);
    expect(plan.nativeBase).toBe('unknown');
    expect(plan.fixtures).toBe(false);
    expect(plan.workers).toBe(false);
  });
  it('separates gate faults from unrelated Hook and cold/warm lifecycle runs', () => {
    const plan = planFor(['tools/quality/gate.ts']);
    expect(plan.fixturesMatrix.include).toHaveLength(8);
    expect(plan.fixturesMatrix.include.some((row) => row.faults)).toBe(true);
    expect(plan.fixturesMatrix.include.every((row) => !row.hooks && !row.lifecycle)).toBe(true);
  });
  it.each(['tools/quality/fixture.ts', 'tools/quality/checkout.ts'])(
    'runs owning rehearsals for %s',
    (file) => {
      const plan = planFor([file]);
      expect(plan.selected).toHaveLength(6);
      expect([plan.native, plan.workers, plan.observability]).toEqual([true, true, false]);
      expect(plan.fixturesMatrix.include.filter((row) => row.hooks)).toEqual([
        expect.objectContaining({ preset: 'web', os: 'ubuntu-24.04' }),
        expect.objectContaining({ preset: 'desktop', os: 'windows-2025' }),
      ]);
      expect(plan.fixturesMatrix.include.filter((row) => row.lifecycle)).toEqual([
        expect.objectContaining({ preset: 'web', os: 'ubuntu-24.04' }),
      ]);
    },
  );
  it('retains full preset and native coverage for generator/setup inputs and unknown roots', () => {
    for (const file of [
      'tools/generators/render.ts',
      'mise.toml',
      'new-root-config.json',
      'tools/new-helper.ts',
    ]) {
      const plan = planFor([file]);
      expect(plan.fixturesMatrix.include).toHaveLength(15);
      expect(plan.nativeMatrix.include).toHaveLength(3);
    }
  });
  it('retains broad validation for semantic or unverifiable template state changes', () => {
    for (const metadata of [
      'options',
      'lock',
      'version',
      'invalid-hash',
      'orphan-hash',
      'removed-state',
    ] as const) {
      const plan = planFor(['README.md'], false, false, { metadata });
      expect(plan.changed).toContain('.template.json');
      expect(plan.fixturesMatrix.include).toHaveLength(15);
      expect(plan.nativeMatrix.include).toHaveLength(3);
    }
  });
  it('compiles generated Desktop natively on three OS even when the source project has no Desktop', () => {
    for (const file of [
      'tools/generators/templates/desktop/src/styles.css.template',
      'tools/quality/gate.ts',
    ]) {
      const plan = planFor([file], false, false, { desktop: false });
      expect(plan.native).toBe(false);
      expect(plan.fixturesMatrix.include.filter((row) => row.preset === 'desktop')).toEqual([
        expect.objectContaining({ os: 'ubuntu-24.04', native: true }),
        expect.objectContaining({ os: 'macos-15', native: true }),
        expect.objectContaining({ os: 'windows-2025', native: true }),
      ]);
    }
  });
  it('selects real signal verification at application producer and Result boundaries', () => {
    for (const file of [
      'packages/api/src/notes.ts',
      'packages/web/src/server.ts',
      'packages/web/src/client/notes.ts',
      'packages/desktop/src/native.ts',
      'packages/desktop/src-tauri/src/telemetry.rs',
      'packages/contracts/src/result.ts',
      'packages/api/cloudflare.config.ts',
      'packages/web/cloudflare.config.ts',
      'packages/web/vite.config.ts',
      'packages/desktop/vite.config.ts',
      'packages/api/package.json',
      'packages/desktop/src-tauri/Cargo.toml',
      'packages/desktop/src-tauri/Cargo.lock',
      'tools/generators/templates/worker/notes.ts.template',
      'tools/generators/templates/web/src/server.ts.template',
      'tools/generators/templates/web/src/client/notes.ts.template',
      'tools/generators/templates/desktop/src/native.ts.template',
      'tools/generators/templates/desktop/src-tauri/src/main.rs.template',
      'tools/generators/templates/desktop/src-tauri/src/telemetry.rs.template',
      'tools/generators/templates/contracts/src/result.ts.template',
      'tools/generators/templates/api/cloudflare.config.ts.template',
      'tools/generators/templates/web/cloudflare.config.ts.template',
      'tools/generators/templates/web/vite.config.ts.template',
      'tools/generators/templates/desktop/vite.config.ts.template',
      'tools/generators/templates/api/package.json.template',
      'tools/generators/templates/desktop/src-tauri/Cargo.toml.template',
      'tools/generators/templates/desktop/src-tauri/Cargo.lock.template',
    ]) {
      const plan = planFor([file]);
      expect({ file, observability: plan.observability, nativeBase: plan.nativeBase }).toEqual({
        file,
        observability: true,
        nativeBase: 'unknown',
      });
      expect(plan.nativeMatrix.include).toHaveLength(3);
    }
    expect(planFor(['packages/web/src/routes/about.tsx']).observability).toBe(false);
    expect(planFor(['packages/observability/src/index.test.ts']).observability).toBe(false);
  });
  it('can explicitly request full validation and falls back safely for an unavailable base', () => {
    for (const plan of [planFor(['README.md'], true), planFor(['README.md'], false, true)]) {
      expect(plan.full).toBe(true);
      expect(plan.fixturesMatrix.include).toHaveLength(15);
      expect(plan.nativeMatrix.include).toHaveLength(3);
      expect(plan.fixturesMatrix.include.find((row) => row.preset === 'web')).toMatchObject({
        faults: true,
        hooks: true,
        lifecycle: true,
      });
    }
  });
});
