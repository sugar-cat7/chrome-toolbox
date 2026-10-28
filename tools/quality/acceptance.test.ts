import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { acceptance, workerEvidenceValid } from './acceptance.ts';
import { globalChecks, packageChecks } from './definitions.ts';
import { projectOptions, verificationCases } from '../generators/options.ts';
import { projectFiles } from '../generators/render.ts';
import { applyFiles } from '../generators/files.ts';
import { workspacePackages } from './graph.ts';
import { fileURLToPath } from 'node:url';
import { contentId } from './gate.ts';

it('selects a complete canonical baseline after an earlier passed feature report', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acceptance-selection-'));
  const sha = 'a'.repeat(40);
  try {
    const project = path.join(root, 'project');
    const options = projectOptions({ name: 'fixture', scope: '@fixture', preset: 'api' });
    applyFiles(project, projectFiles(fileURLToPath(new URL('../..', import.meta.url)), options));
    const workspace = workspacePackages(project);
    const report = {
      schema: 1,
      os: 'linux/x64',
      sha: 'uncommitted',
      status: 'passed',
      contentId: 'b'.repeat(64),
      origin: { sha, dirty: false, contentId: 'c'.repeat(64) },
      configuration: options,
      workspace,
      tools: {},
      checks: [...globalChecks, ...workspace.flatMap((pkg) => packageChecks(pkg, 'full'))].map(
        (check) => ({ ...check, status: 'passed', milliseconds: 1 }),
      ),
    };
    for (const [folder, actual] of [
      ['000-feature', { ...report, workspace: [] }],
      ['999-baseline', report],
    ] as const) {
      const target = path.join(root, folder);
      mkdirSync(target);
      writeFileSync(path.join(target, 'gate-full-all-linux.json'), JSON.stringify(actual));
      writeFileSync(
        path.join(target, 'generation.json'),
        JSON.stringify({ ...actual, baselineDifferences: [] }),
      );
    }
    const result = acceptance(root, sha);
    const api = result.rows.find((row) => row.preset === 'api' && row.os === 'linux');
    expect(api?.status).toBe('passed');
    expect(api?.evidence).toBe('999-baseline/gate-full-all-linux.json');
    expect(result.mechanisms.find((entry) => entry.id === 'worker-win32')?.status).toBe('blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires exact-source actual Windows Worker commands and rejects other OS or incomplete reports', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acceptance-windows-'));
  const sha = 'a'.repeat(40);
  try {
    const configuration = projectOptions({
      name: 'fixture',
      scope: '@fixture',
      preset: 'fullstack',
    });
    applyFiles(root, projectFiles(fileURLToPath(new URL('../..', import.meta.url)), configuration));
    const workspace = workspacePackages(root);
    const expected = { sha, contentId: contentId(root), configuration, workspace };
    const report = {
      schema: 1,
      sha,
      contentId: expected.contentId,
      os: 'win32/x64',
      variant: 'worker',
      status: 'passed',
      configuration,
      workspace,
      tools: {},
      checks: [
        ...globalChecks,
        ...workspace
          .filter((pkg) => pkg.runtime === 'worker')
          .flatMap((pkg) => packageChecks(pkg, 'full'))
          .filter((check) => !check.requirements.includes('browser')),
      ].map((check) => ({ ...check, status: 'passed', milliseconds: 1 })),
    };
    expect(workerEvidenceValid(report, expected)).toBe(true);
    const productionBrowser = workspace
      .flatMap((pkg) => packageChecks(pkg, 'full'))
      .find((check) => check.id.endsWith('/browser-production'));
    expect(productionBrowser).toBeDefined();
    const web = workspace.find((pkg) => pkg.dependencies.includes('@tanstack/react-start'))!;
    const missingProductionScript = { ...web, scripts: { ...web.scripts } };
    delete missingProductionScript.scripts['test:e2e:production'];
    expect(
      packageChecks(missingProductionScript, 'full').map((check) => check.command),
    ).toContainEqual(['--filter', web.name, 'test:e2e:production']);
    expect(
      workerEvidenceValid(
        {
          ...report,
          checks: [...report.checks, { ...productionBrowser!, status: 'passed', milliseconds: 1 }],
        },
        expected,
      ),
    ).toBe(false);
    expect(workerEvidenceValid(report, undefined)).toBe(false);
    expect(workerEvidenceValid({ ...report, contentId: 'd'.repeat(64) }, expected)).toBe(false);
    expect(
      workerEvidenceValid(report, {
        ...expected,
        configuration: projectOptions({ name: 'fixture', scope: '@fixture', preset: 'api' }),
      }),
    ).toBe(false);
    expect(
      workerEvidenceValid(report, {
        ...expected,
        workspace: [
          ...workspace,
          {
            ...workspace[0]!,
            name: '@fixture/other-worker',
            directory: 'packages/other-worker',
            runtime: 'worker',
          },
        ],
      }),
    ).toBe(false);

    expect(workerEvidenceValid({ ...report, os: 'linux/x64' }, expected)).toBe(false);
    expect(workerEvidenceValid({ ...report, sha: 'd'.repeat(40) }, expected)).toBe(false);
    expect(workerEvidenceValid({ ...report, workspace: [] }, expected)).toBe(false);
    expect(workerEvidenceValid({ ...report, checks: report.checks.slice(0, -1) }, expected)).toBe(
      false,
    );
    expect(
      workerEvidenceValid(
        { ...report, checks: report.checks.map((check) => ({ ...check, command: ['--help'] })) },
        expected,
      ),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects passed labels that omit applications or actual mechanism execution', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acceptance-fault-'));
  const sha = 'a'.repeat(40);
  try {
    for (const entry of verificationCases) {
      for (const os of entry.key === 'desktop' ? ['linux', 'darwin', 'win32'] : ['linux']) {
        const folder = path.join(root, `${entry.key}-${os}`);
        mkdirSync(folder);
        const report = {
          schema: 1,
          os: `${os}/x64`,
          sha: 'uncommitted',
          status: 'passed',
          contentId: 'forged',
          origin: { sha, dirty: false },
          configuration: projectOptions({
            name: 'fixture',
            scope: '@fixture',
            preset: entry.preset,
            features: entry.features,
          }),
          workspace: [],
          tools: {},
          checks: globalChecks.map((check) => ({ ...check, status: 'passed', milliseconds: 1 })),
        };
        writeFileSync(path.join(folder, `gate-full-all-${os}.json`), JSON.stringify(report));
        writeFileSync(
          path.join(folder, 'generation.json'),
          JSON.stringify({ ...report, baselineDifferences: [] }),
        );
      }
    }
    for (const file of [
      'faults',
      'hooks',
      'lifecycle',
      'sanitization',
      'agent-web-api',
      'agent-desktop',
      'agent-package-add',
    ])
      writeFileSync(
        path.join(root, `${file}.json`),
        JSON.stringify({
          schema: 1,
          sha,
          status: 'passed',
          contentId: 'forged',
          commands: [
            {
              command: 'echo gate:pre-pr gate:full build deploy:preflight git commit git push',
              status: 'passed',
            },
          ],
        }),
      );
    const result = acceptance(root, sha);
    expect(result.status).toBe('blocked');
    expect(result.rows.every((row) => row.status === 'blocked')).toBe(true);
    expect(result.mechanisms.every((entry) => entry.status === 'blocked')).toBe(true);
    expect(acceptance(root, 'b'.repeat(40)).status).toBe('blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires actual executables and subcommands rather than mention-only or help commands', async () => {
  const { agentCommandValid } = await import('./acceptance.ts');
  expect(agentCommandValid('full', ['echo', 'pnpm', 'gate:full'])).toBe(false);
  expect(agentCommandValid('commit', ['git', 'commit', '--help'])).toBe(false);
  expect(agentCommandValid('push', ['git', 'push', '--no-verify'])).toBe(false);
  expect(agentCommandValid('commit', ['git', 'commit', '-an', '-m', 'Feature'])).toBe(false);
  expect(agentCommandValid('push', ['git', 'push', '-n', 'origin', 'HEAD'])).toBe(false);
  expect(agentCommandValid('full', ['pnpm', 'gate:full', '--', '--checks', 'javascript'])).toBe(
    false,
  );
  expect(agentCommandValid('commit', ['git', '-c', 'core.hooksPath=/tmp', 'commit'])).toBe(false);
  expect(agentCommandValid('preflight', ['pnpm', 'deploy:preflight', '--dry-run'])).toBe(false);
  expect(
    agentCommandValid('full', ['mise', 'exec', 'pnpm@12.11.2', '--', 'pnpm', 'gate:full']),
  ).toBe(true);
  expect(
    agentCommandValid('targeted-test', ['pnpm', '--filter', '@fixture/api', 'test:unit']),
  ).toBe(true);
  expect(agentCommandValid('commit', ['git', '-C', '/project', 'commit', '-m', 'Feature'])).toBe(
    true,
  );
});

it('requires exact current collection, query, MCP and native producer evidence', async () => {
  const { observabilityEvidenceValid } = await import('./acceptance.ts');
  const { observabilityCheck } = await import('./definitions.ts');
  const sha = 'a'.repeat(40);
  const current = 'b'.repeat(64);
  const expected = {
    sha,
    contentId: current,
    configuration: projectOptions({ name: 'fixture', scope: '@fixture', preset: 'desktop' }),
    workspace: [
      {
        name: '@fixture/desktop',
        directory: 'packages/desktop',
        runtime: 'desktop' as const,
        scripts: {},
        dependencies: [],
      },
    ],
  };
  const report = {
    schema: 1,
    result: 'passed',
    sha,
    contentId: 'c'.repeat(64),
    sourceCheckout: false,
    baselineDifferences: [],
    origin: { sha, dirty: false },
    check: observabilityCheck.id,
    requirements: observabilityCheck.requirements,
    health: { collectable: true, queryReady: true },
    counts: { failureLogs: 3, traceSpans: 3, histograms: 4 },
    mcp: {
      official: 'mcp-clickhouse 0.7.0',
      boundedTools: 3,
      arbitraryQueryRejected: true,
      readOnlyWriteRejected: true,
    },
    nativeSource: { sha, contentId: current },
    native: {
      actualOperatingSystems: ['linux', 'darwin', 'win32'],
      collected: ['linux', 'darwin', 'win32'].flatMap((os) =>
        ['save', 'cancel', 'error'].map((scenario) => `${os}/${scenario}`),
      ),
    },
  };
  expect(observabilityEvidenceValid(report, expected)).toBe(true);
  for (const incomplete of [
    { ...report, result: 'not_run' },
    { ...report, baselineDifferences: ['packages/web/src/server.ts'] },
    { ...report, sha: 'd'.repeat(40) },
    { ...report, sourceCheckout: true },
    { ...report, origin: { sha, dirty: true } },
    { ...report, health: { collectable: false, queryReady: true } },
    { ...report, counts: { failureLogs: 0, traceSpans: 3, histograms: 4 } },
    { ...report, mcp: { ...report.mcp, arbitraryQueryRejected: false } },
    { ...report, native: { ...report.native, collected: report.native.collected.slice(1) } },
    { ...report, nativeSource: { sha, contentId: 'd'.repeat(64) } },
  ])
    expect(observabilityEvidenceValid(incomplete, expected)).toBe(false);
  expect(observabilityEvidenceValid(report, undefined)).toBe(false);
  expect(
    observabilityEvidenceValid(
      { ...report, native: { actualOperatingSystems: [], collected: [] } },
      { ...expected, workspace: [] },
    ),
  ).toBe(true);
});
