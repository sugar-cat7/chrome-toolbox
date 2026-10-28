import type { WorkspacePackage } from './graph.ts';

export type Check = {
  id: string;
  requirements: string[];
  package?: string;
  command: string[];
  timeout: number;
  reason: string;
};
export const globalChecks: Check[] = [
  {
    id: 'static',
    requirements: ['layout', 'quality', 'boundaries', 'docs', 'secrets'],
    command: ['check'],
    timeout: 180_000,
    reason: 'Repository-wide static checks are lightweight and run once',
  },
  {
    id: 'tools-unit',
    requirements: ['generator-safety', 'affected', 'failure-propagation'],
    command: ['test:tools'],
    timeout: 180_000,
    reason: 'Shared tooling contracts',
  },
];

// Security has its own optional tool profile and mandatory CI job, so native
// setup never installs Python/scanners. Keep check metadata in this registry.
export const securityChecks: Check[] = [
  {
    id: 'trivy',
    requirements: ['vulnerabilities', 'misconfiguration', 'secrets', 'dev-dependencies'],
    command: ['security:check', '--', '--scanner', 'trivy'],
    timeout: 12 * 60_000,
    reason: 'All selected lockfiles and first-party configuration/source; include unfixed findings',
  },
  {
    id: 'semgrep',
    requirements: ['sast', 'error-findings', 'complete-parsing'],
    command: ['security:check', '--', '--scanner', 'semgrep'],
    timeout: 12 * 60_000,
    reason: 'OSS security rules plus local deterministic TLS remediation',
  },
];

// Real collection needs an explicitly selected local Docker/MCP profile; CI runs
// it once in the source-free generated workspace, outside ordinary app setup.
export const observabilityCheck: Check = {
  id: 'real-signals-mcp',
  requirements: [
    'result-policy',
    'telemetry-privacy',
    'signal-correlation',
    'bounded-ai-investigation',
    'native-signal-provenance',
  ],
  command: ['o11y:verify'],
  timeout: 15 * 60_000,
  reason:
    'Actual ClickHouse rows and official read-only MCP; native producers must match each required OS and source',
};

export function faultCheckIds(packages: WorkspacePackage[]): string[] {
  return [
    'format',
    'lint',
    'type',
    'lint-floating-void',
    'lint-misused-promise',
    'lint-exhaustiveness',
    'secret-tools',
    'unit-focused',
    'unit',
    'unit-zero',
    'unit-skipped',
    'unit-timeout',
    'boundary',
    'skill-metadata',
    ...(packages.some((pkg) => pkg.directory === 'packages/contracts')
      ? ['secret-contracts', 'contract', 'result-discard', 'telemetry-owner', 'error-catalog-drift']
      : []),
    ...(packages.some((pkg) => pkg.runtime === 'worker')
      ? [
          'worker-behavior',
          'worker-zero',
          'deploy-quality',
          'deploy-environment',
          'deploy-settings',
        ]
      : []),
    ...(packages.some((pkg) => pkg.scripts['db:migrate'])
      ? ['dev-preflight-to-local-d1', 'migration']
      : []),
    ...(packages.some((pkg) => pkg.scripts['test:e2e'])
      ? [
          'browser-behavior',
          'browser-focused',
          'browser-zero',
          'browser-skipped',
          'browser-timeout',
          'visual-regression',
        ]
      : []),
    ...(packages.some((pkg) => pkg.scripts['test:lighthouse']) ? ['lighthouse-score'] : []),
    ...(packages.some((pkg) => pkg.runtime === 'desktop')
      ? [
          'rust-behavior',
          'rust-zero',
          'rust-ignored',
          'rust-timeout',
          'native-behavior',
          'native-focused',
          'native-zero',
          'native-skipped',
          'native-timeout',
        ]
      : []),
  ];
}

export const lifecyclePhases = [
  'cold-setup',
  'cold-gate',
  'hmr',
  'warm-setup',
  'warm-gate',
  'cache-cleared-gate',
  'rename-and-exclude',
  'add-and-start',
  'sample-removal',
  'interrupted-recovery',
  're-add-excluded-web',
];
export const hookPhases = [
  'install-repeat',
  'valid-commit',
  'ignored-temporary-index',
  'partial-stage-valid',
  'partial-stage-invalid',
  'empty-diff-repair',
  'valid-push',
  'invalid-push',
  'multi-ref-repair',
  'linked-worktree',
  'existing-hook-protection',
];

export function packageChecks(pkg: WorkspacePackage, phase: 'test' | 'build' | 'full'): Check[] {
  const entries: [string, string, string[]][] =
    phase === 'build'
      ? [['build', 'build', ['build']]]
      : [['unit', 'test', ['contracts', 'ui-states']]];
  if (phase === 'full') {
    entries.push(['build', 'build', ['build']]);
    if (pkg.runtime === 'worker')
      entries.push(['runtime', 'test:runtime', ['worker', 'bindings', 'environments']]);
    if (pkg.scripts['test:restart'])
      entries.push(['restart', 'test:restart', ['migration', 'seed', 'persistence']]);
    if (pkg.scripts['test:e2e'])
      entries.push(['browser', 'test:e2e', ['web', 'browser', 'accessibility', 'vrt']]);
    if (pkg.dependencies.includes('@tanstack/react-start') || pkg.scripts['test:e2e:production'])
      entries.push([
        'browser-production',
        'test:e2e:production',
        ['web', 'browser', 'production-ui'],
      ]);
    if (pkg.dependencies.includes('@tanstack/react-start') || pkg.scripts['test:lighthouse'])
      entries.push(['lighthouse', 'test:lighthouse', ['web', 'browser', 'lighthouse-all-100']]);
    if (pkg.runtime === 'desktop')
      entries.push(
        ['rust', 'test:rust', ['rust', 'ipc', 'export']],
        ['native', 'test:native', ['native-three-os', 'ipc']],
        ['release', 'test:release', ['release-isolation']],
      );
  }
  return entries.map(([id, script, requirements]) => ({
    id: `${pkg.name}/${id}`,
    requirements,
    package: pkg.name,
    command: ['--filter', pkg.name, script],
    timeout:
      id === 'lighthouse'
        ? 15 * 60_000
        : pkg.runtime === 'desktop' && id !== 'unit'
          ? 30 * 60_000
          : 180_000,
    reason: `Selected ${pkg.runtime} ${pkg.name}; ${phase} phase`,
  }));
}
