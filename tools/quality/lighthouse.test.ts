import { expect, it } from 'vitest';
import { lighthouseRoutes, lighthousePackages } from './lighthouse.ts';
import { lighthouseScores } from './test-results.ts';
import { packageChecks } from './definitions.ts';

const report = () => ({
  configSettings: {
    formFactor: 'mobile',
    throttlingMethod: 'simulate',
    skipAudits: null,
    onlyAudits: null,
    onlyCategories: null,
  },
  categories: Object.fromEntries(
    ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'].map((id) => [
      id,
      { score: 1 as number | null },
    ]),
  ),
  audits: { 'first-contentful-paint': { scoreDisplayMode: 'numeric' } },
});

it('rejects sub-100, missing/error and selectively filtered results instead of rounding or trusting CLI exit zero', () => {
  expect(Object.keys(lighthouseScores(report(), 'mobile'))).toHaveLength(5);
  for (const score of [0.999, 0.99, null]) {
    const value = report();
    value.categories.performance!.score = score;
    expect(() => lighthouseScores(value, 'mobile')).toThrow('requires every category to score 100');
  }
  const missing = report();
  delete missing.categories.seo;
  expect(() => lighthouseScores(missing, 'mobile')).toThrow('missing required category');
  expect(() =>
    lighthouseScores({ ...report(), runtimeError: { code: 'NO_FCP' } }, 'mobile'),
  ).toThrow('must complete');
  expect(() => lighthouseScores({ ...report(), audits: {} }, 'mobile')).toThrow(
    'collected no audits',
  );
  expect(() =>
    lighthouseScores({ ...report(), audits: { broken: { scoreDisplayMode: 'error' } } }, 'mobile'),
  ).toThrow('failed to execute');
  for (const field of ['skipAudits', 'onlyAudits', 'onlyCategories'])
    expect(() =>
      lighthouseScores(
        { ...report(), configSettings: { ...report().configSettings, [field]: [] } },
        'mobile',
      ),
    ).toThrow('without exclusions');
  expect(() => lighthouseScores(report(), 'desktop')).toThrow('official mobile/desktop');
  expect(() =>
    lighthouseScores(
      { ...report(), configSettings: { ...report().configSettings, throttlingMethod: 'provided' } },
      'mobile',
    ),
  ).toThrow('must complete');
});

it('takes all actual page routes, requires local dynamic fixtures and rejects missing or mismatched coverage', () => {
  const tree =
    "export interface FileRoutesByFullPath { '/': unknown; '/about': unknown; '/notes/$id': unknown; }";
  expect(lighthouseRoutes(tree, { '/notes/$id': '/notes/example' })).toEqual([
    '/',
    '/about',
    '/notes/example',
  ]);
  expect(() => lighthouseRoutes(tree)).toThrow('needs a local fixture URL');
  for (const target of [
    'https://example.test/notes/example',
    '//example.test/notes/example',
    '/about',
    '/notes/example#ignore',
  ])
    expect(() => lighthouseRoutes(tree, { '/notes/$id': target })).toThrow(
      /Lighthouse (?:route needs a local fixture URL|fixture does not cover route)/u,
    );
  expect(() => lighthouseRoutes(tree, { '/missing': '/' })).toThrow('unknown route');
  expect(() => lighthouseRoutes('export interface FileRoutesByFullPath {}')).toThrow(
    'no page routes',
  );
  for (const route of ['/posts/{-$slug}', '/files/{$name}.txt'])
    expect(() =>
      lighthouseRoutes(
        `export interface FileRoutesByFullPath { '/': unknown; '${route}': unknown; '/terms': unknown; }`,
      ),
    ).toThrow('SDK fixture-matcher review');
  expect(() => lighthouseRoutes('export interface FileRoutesByFullPath {')).toThrow(
    'failed to parse',
  );
  expect(
    lighthouseRoutes("export interface FileRoutesByFullPath { '/files/$': unknown }", {
      '/files/$': '/files/a/b.txt',
    }),
  ).toEqual(['/files/a/b.txt']);
});

it('keeps the Web Lighthouse check mandatory when its package script is accidentally removed', () => {
  const checks = packageChecks(
    {
      name: '@test/web',
      directory: 'packages/site',
      runtime: 'worker',
      dependencies: ['@tanstack/react-start'],
      scripts: { test: 'test', build: 'build', 'test:runtime': 'runtime' },
    },
    'full',
  );
  expect(checks.find((check) => check.id === '@test/web/lighthouse')?.command).toEqual([
    '--filter',
    '@test/web',
    'test:lighthouse',
  ]);
  const packages = [
    {
      name: '@test/web',
      directory: 'packages/site',
      runtime: 'worker' as const,
      dependencies: ['@tanstack/react-start'],
      scripts: {},
    },
  ];
  expect(() => lighthousePackages(packages, '/project', '/project')).toThrow(
    'requires test:lighthouse',
  );
  expect(lighthousePackages(packages, '/project', '/project/packages/api')).toEqual([]);
});
