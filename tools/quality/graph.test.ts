import { describe, expect, it } from 'vitest';
import { affectedPackages, type WorkspacePackage } from './graph.ts';

const pkg = (name: string, dependencies: string[] = []): WorkspacePackage => ({
  name,
  directory: `packages/${name}`,
  runtime: 'library',
  dependencies,
  scripts: {},
});
const graph = [
  pkg('contracts'),
  pkg('ui', ['contracts']),
  pkg('web', ['ui', 'contracts']),
  pkg('api', ['contracts']),
  pkg('desktop', ['ui']),
];

describe('affected workspace selection', () => {
  it('keeps an app-only change local', () => {
    expect(affectedPackages(graph, ['packages/api/src/index.ts']).map((p) => p.name)).toEqual([
      'api',
    ]);
  });
  it('expands reverse dependencies transitively', () => {
    expect(affectedPackages(graph, ['packages/ui/src/index.tsx']).map((p) => p.name)).toEqual([
      'ui',
      'web',
      'desktop',
    ]);
  });
  it('selects every consumer of a shared contract', () => {
    expect(affectedPackages(graph, ['packages/contracts/src/index.ts']).map((p) => p.name)).toEqual(
      graph.map((p) => p.name),
    );
  });
  it('selects all for runtime configuration, unknown base, deleted package and execution tooling', () => {
    for (const change of [
      undefined,
      ['pnpm-lock.yaml'],
      ['packages/removed/src/x.ts'],
      ['tools/quality/gate.ts'],
      ['vite.config.ts'],
    ]) {
      expect(affectedPackages(graph, change).map((p) => p.name)).toEqual(graph.map((p) => p.name));
    }
  });
  it('keeps docs, standalone tooling tests, CI selection and optional security plumbing out of app execution', () => {
    for (const file of [
      'README.md',
      'docs/quality.md',
      '.agents/skills/frontend/SKILL.md',
      'packages/web/README.md',
      'tools/quality/ci-plan.ts',
      'tools/quality/graph.test.ts',
      'tools/security/scan.ts',
      'renovate.json',
    ])
      expect(affectedPackages(graph, [file])).toEqual([]);
  });
  it('does not classify a runtime markdown asset or unknown Agent script as documentation', () => {
    expect(affectedPackages(graph, ['packages/web/src/help.md']).map((p) => p.name)).toEqual([
      'web',
    ]);
    expect(affectedPackages(graph, ['.agents/run.ts'])).toEqual(graph);
    expect(affectedPackages(graph, ['docs/policy.ts'])).toEqual(graph);
    expect(affectedPackages(graph, ['packages/web/docs/policy.ts']).map((p) => p.name)).toEqual([
      'web',
    ]);
    expect(affectedPackages(graph, ['packages/web/docs/runtime.json']).map((p) => p.name)).toEqual([
      'web',
    ]);
  });
  it('maps a portable blueprint to its manifest consumers', () => {
    expect(
      affectedPackages(graph, ['tools/generators/templates/ui/src/index.tsx.template']).map(
        (p) => p.name,
      ),
    ).toEqual(['ui', 'web', 'desktop']);
  });
  it('accounts for both paths of a rename', () => {
    expect(
      affectedPackages(graph, ['packages/web/src/old.ts', 'packages/api/src/new.ts']).map(
        (p) => p.name,
      ),
    ).toEqual(['web', 'api']);
  });
  it('does not invent app work for an empty diff', () => {
    expect(affectedPackages(graph, [])).toEqual([]);
  });
});
