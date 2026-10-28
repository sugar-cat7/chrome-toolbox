import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  verificationCases,
  projectOptions,
  selectedPackages,
  type ProjectOptions,
} from '../generators/options.ts';
import { walk } from '../generators/files.ts';
import {
  globalChecks,
  packageChecks,
  faultCheckIds,
  hookPhases,
  lifecyclePhases,
  observabilityCheck,
} from './definitions.ts';
import { workspacePackages, type WorkspacePackage } from './graph.ts';
import { contentId } from './gate.ts';
import { spawnSync } from 'node:child_process';
import { appFiles } from '../generators/render.ts';
import { fileURLToPath } from 'node:url';
export function agentCommandValid(phase: string, argv: string[]): boolean {
  if (
    !argv.length ||
    argv.some(
      (arg) =>
        /^(?:--help|-h|--version|-v|--dry-run|--no-verify)$/u.test(arg) ||
        /^(?:core\.hooksPath(?:=|$)|--config-env=core\.hooksPath)/u.test(arg),
    )
  )
    return false;
  const executable = (value: string) => path.basename(value).replace(/\.exe$/u, '');
  let args = argv.slice(1);
  let command = executable(argv[0]!);
  if (command === 'mise') {
    if (args[0] === 'run') return phase === 'setup' && args[1] === 'setup';
    if (args[0] !== 'exec') return false;
    const separator = args.indexOf('--');
    if (separator < 1) return false;
    command = executable(args[separator + 1] ?? '');
    args = args.slice(separator + 2);
  }
  if (phase === 'commit' || phase === 'push') {
    if (command !== 'git' || args.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/u.test(arg))) return false;
    while (['-C', '-c', '--git-dir', '--work-tree'].includes(args[0] ?? '')) {
      if (!args[1]) return false;
      args = args.slice(2);
    }
    return args[0] === phase;
  }
  if (command !== 'pnpm') return false;
  while (args[0]?.startsWith('-')) {
    if (['--filter', '-F', '-C', '--dir'].includes(args[0])) {
      if (!args[1]) return false;
      args = args.slice(2);
    } else if (['-r', '--recursive', '-w', '--workspace-root'].includes(args[0]))
      args = args.slice(1);
    else return false;
  }
  if (args[0] === 'run') args = args.slice(1);
  if (
    phase === 'full' &&
    args.some(
      (arg, index) =>
        (arg === '--checks' && args[index + 1] !== 'all') ||
        (arg.startsWith('--checks=') && arg !== '--checks=all'),
    )
  )
    return false;
  const token = (
    {
      setup: 'env:setup',
      doctor: 'env:doctor',
      dev: 'dev',
      'targeted-test': 'test',
      'pre-pr': 'gate:pre-pr',
      full: 'gate:full',
      build: 'build',
      preflight: 'deploy:preflight',
    } as Record<string, string>
  )[phase];
  return (
    !!token &&
    (args[0] === token ||
      (['dev', 'targeted-test'].includes(phase) && args[0]?.startsWith(`${token}:`) === true))
  );
}
function agentLogValid(directory: string, relative: string): boolean {
  if (!relative.startsWith('logs/') || !relative.endsWith('.log')) return false;
  const filename = path.resolve(directory, relative);
  if (!existsSync(filename)) return false;
  const logs = path.resolve(directory, 'logs');
  return (
    realpathSync(filename).startsWith(`${realpathSync(logs)}${path.sep}`) &&
    statSync(filename).isFile() &&
    statSync(filename).size > 0
  );
}
const source = fileURLToPath(new URL('../..', import.meta.url));
function canonicalPackages(options: ProjectOptions): WorkspacePackage[] {
  return selectedPackages(options).map((kind) => {
    const directory = `packages/${kind}`;
    const manifest = JSON.parse(
      appFiles(source, options, kind, kind, false).get(`${directory}/package.json`)!.toString(),
    ) as {
      name: string;
      starter?: { runtime?: WorkspacePackage['runtime'] };
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      name: manifest.name,
      directory,
      runtime: manifest.starter?.runtime ?? 'library',
      scripts: manifest.scripts,
      dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
    };
  });
}
function phasesComplete(
  actual: readonly { id: string; status: string; repaired?: boolean }[] | undefined,
  expected: string[],
  repaired = false,
): boolean {
  return (
    !!actual &&
    expected.length > 0 &&
    actual.length === expected.length &&
    expected.every((id) =>
      actual.some(
        (entry) =>
          entry.id === id && entry.status === 'passed' && (!repaired || entry.repaired === true),
      ),
    )
  );
}

type GateReport = {
  schema: number;
  sha: string;
  contentId: string;
  os: string;
  variant?: string;
  status?: string;
  origin?: { sha: string | null; dirty: boolean; contentId: string };
  configuration?: ProjectOptions;
  workspace?: WorkspacePackage[];
  tools: Record<string, unknown>;
  checks: {
    id: string;
    requirements: string[];
    command: string[];
    status: string;
    milliseconds: number;
  }[];
};

type SourceIdentity = {
  sha: string;
  contentId: string;
  configuration: ProjectOptions;
  workspace: WorkspacePackage[];
};
function sourceIdentity(sha: string): SourceIdentity | undefined {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' });
  if (
    head.status !== 0 ||
    status.status !== 0 ||
    head.stdout.trim() !== sha ||
    status.stdout.trim()
  )
    return undefined;
  const configuration = (
    JSON.parse(readFileSync(path.join(source, '.template.json'), 'utf8')) as {
      options: ProjectOptions;
    }
  ).options;
  return { sha, contentId: contentId(source), configuration, workspace: workspacePackages(source) };
}
export function workerEvidenceValid(
  report: GateReport,
  expected: SourceIdentity | undefined,
): boolean {
  if (
    !expected ||
    report.schema !== 1 ||
    report.sha !== expected.sha ||
    report.origin ||
    report.status !== 'passed' ||
    report.variant !== 'worker' ||
    !report.os.startsWith('win32/') ||
    !report.configuration ||
    report.contentId !== expected.contentId
  )
    return false;
  const configuration = report.configuration;
  if (
    ['name', 'scope', 'identifier', 'preset'].some(
      (key) =>
        configuration[key as keyof ProjectOptions] !==
        expected.configuration[key as keyof ProjectOptions],
    ) ||
    JSON.stringify(configuration.features.toSorted()) !==
      JSON.stringify(expected.configuration.features.toSorted())
  )
    return false;
  const workers = expected.workspace.filter((pkg) => pkg.runtime === 'worker');
  const checks = [
    ...globalChecks,
    ...workers.flatMap((pkg) =>
      packageChecks(pkg, 'full').filter((check) => !check.requirements.includes('browser')),
    ),
  ];
  return (
    workers.length > 0 &&
    report.workspace?.length === expected.workspace.length &&
    expected.workspace.every((pkg) =>
      report.workspace!.some(
        (actual) =>
          actual.name === pkg.name &&
          actual.directory === pkg.directory &&
          actual.runtime === pkg.runtime &&
          Object.keys(actual.scripts).length === Object.keys(pkg.scripts).length &&
          Object.keys(pkg.scripts).every((key) => actual.scripts[key] === pkg.scripts[key]) &&
          JSON.stringify(actual.dependencies.toSorted()) ===
            JSON.stringify(pkg.dependencies.toSorted()),
      ),
    ) &&
    report.checks.length === checks.length &&
    checks.every((check) =>
      report.checks.some(
        (actual) =>
          actual.id === check.id &&
          actual.status === 'passed' &&
          JSON.stringify(actual.command) === JSON.stringify(check.command) &&
          JSON.stringify(actual.requirements) === JSON.stringify(check.requirements),
      ),
    )
  );
}

type ObservabilityReport = {
  schema?: number;
  result?: string;
  check?: string;
  requirements?: string[];
  sha?: string;
  contentId?: string;
  sourceCheckout?: boolean;
  origin?: { sha?: string; dirty?: boolean };
  baselineDifferences?: string[];
  health?: { collectable?: boolean; queryReady?: boolean };
  counts?: { failureLogs?: number; traceSpans?: number; histograms?: number };
  mcp?: {
    official?: string;
    boundedTools?: number;
    arbitraryQueryRejected?: boolean;
    readOnlyWriteRejected?: boolean;
  };
  native?: { actualOperatingSystems?: string[]; collected?: string[] };
  nativeSource?: { sha?: string; contentId?: string };
};
export function observabilityEvidenceValid(
  report: ObservabilityReport,
  expected: SourceIdentity | undefined,
): boolean {
  if (
    !expected ||
    report.schema !== 1 ||
    report.result !== 'passed' ||
    report.sha !== expected.sha ||
    !/^[a-f0-9]{64}$/u.test(report.contentId ?? '') ||
    report.check !== observabilityCheck.id ||
    JSON.stringify(report.requirements) !== JSON.stringify(observabilityCheck.requirements) ||
    report.health?.collectable !== true ||
    report.health.queryReady !== true ||
    ![report.counts?.failureLogs, report.counts?.traceSpans, report.counts?.histograms].every(
      (value) => Number.isInteger(value) && value! > 0,
    ) ||
    report.mcp?.official !== 'mcp-clickhouse 0.7.0' ||
    report.mcp.boundedTools !== 3 ||
    report.mcp.arbitraryQueryRejected !== true ||
    report.mcp.readOnlyWriteRejected !== true
  )
    return false;
  if (report.sourceCheckout === true) {
    if (report.contentId !== expected.contentId) return false;
  } else if (
    report.sourceCheckout !== false ||
    report.origin?.sha !== expected.sha ||
    report.origin.dirty !== false ||
    !Array.isArray(report.baselineDifferences) ||
    report.baselineDifferences.length !== 0
  )
    return false;
  if (!expected.workspace.some((pkg) => pkg.runtime === 'desktop')) return true;
  const cases = ['linux', 'darwin', 'win32'].flatMap((os) =>
    ['save', 'cancel', 'error'].map((scenario) => `${os}/${scenario}`),
  );
  return (
    report.nativeSource?.sha === expected.sha &&
    report.nativeSource.contentId === expected.contentId &&
    JSON.stringify(report.native?.actualOperatingSystems?.toSorted()) ===
      JSON.stringify(['darwin', 'linux', 'win32']) &&
    report.native?.collected?.length === cases.length &&
    cases.every((item) => report.native?.collected?.includes(item))
  );
}

export function acceptance(directory: string, sha: string) {
  const expectedSource = sourceIdentity(sha);
  const inputs = existsSync(directory)
    ? walk(directory)
        .filter((file) => /^gate-full-all-(?:linux|darwin|win32)\.json$/u.test(path.basename(file)))
        .map((file) => ({
          file,
          report: JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as GateReport,
        }))
    : [];
  const rows = verificationCases.flatMap((entry) => {
    const expected = projectOptions({
      name: 'acceptance',
      scope: '@acceptance',
      preset: entry.preset,
      features: entry.features,
    });
    const platforms = entry.key === 'desktop' ? ['linux', 'darwin', 'win32'] : ['linux'];
    return platforms.map((os) => {
      const compatible = inputs.filter(
        ({ report }) =>
          report.schema === 1 &&
          report.os.startsWith(`${os}/`) &&
          report.configuration?.preset === expected.preset &&
          JSON.stringify(report.configuration.features.toSorted()) ===
            JSON.stringify(expected.features.toSorted()) &&
          report.origin?.sha === sha &&
          !report.origin.dirty,
      );
      const candidates = compatible.map((input) => {
        const canonical = input?.report.configuration
          ? canonicalPackages(input.report.configuration)
          : [];
        const expectedChecks = [
          ...globalChecks,
          ...canonical.flatMap((pkg) => packageChecks(pkg, 'full')),
        ];
        const workspaceComplete =
          !!input?.report.workspace &&
          canonical.length === input.report.workspace.length &&
          canonical.every((pkg) =>
            input.report.workspace!.some(
              (entry) =>
                entry.name === pkg.name &&
                entry.runtime === pkg.runtime &&
                entry.directory === pkg.directory &&
                Object.keys(pkg.scripts).every((key) => entry.scripts[key] === pkg.scripts[key]),
            ),
          );
        const receiptFile = input
          ? path.join(directory, path.dirname(input.file), 'generation.json')
          : '';
        const receipt =
          receiptFile && existsSync(receiptFile)
            ? (JSON.parse(readFileSync(receiptFile, 'utf8')) as {
                schema: number;
                status: string;
                contentId: string;
                os: string;
                origin?: { sha?: string; dirty?: boolean };
                baselineDifferences?: string[];
              })
            : undefined;
        const receiptMatches =
          !!receipt &&
          receipt.schema === 1 &&
          receipt.status === 'passed' &&
          receipt.contentId === input?.report.contentId &&
          receipt.os === input?.report.os &&
          receipt.origin?.sha === sha &&
          receipt.origin.dirty === false &&
          Array.isArray(receipt.baselineDifferences) &&
          receipt.baselineDifferences.length === 0;
        const checks = expectedChecks.map((check) => {
          const result = input?.report.checks.find(
            (result) =>
              result.id === check.id &&
              JSON.stringify(result.command) === JSON.stringify(check.command),
          );
          return {
            ...check,
            status: result?.status ?? 'missing',
            milliseconds: result?.milliseconds ?? 0,
          };
        });
        const passed =
          input.report.status === 'passed' &&
          workspaceComplete &&
          receiptMatches &&
          checks.length > 0 &&
          input.report.checks.length === expectedChecks.length &&
          checks.every((check) => check.status === 'passed');
        return { input, checks, passed };
      });
      const candidate = candidates.find((entry) => entry.passed) ?? candidates[0];
      const input = candidate?.input;
      const checks =
        candidate?.checks ??
        [
          ...globalChecks,
          ...canonicalPackages(expected).flatMap((pkg) => packageChecks(pkg, 'full')),
        ].map((check) => ({ ...check, status: 'missing', milliseconds: 0 }));
      const passed = candidate?.passed ?? false;
      return {
        preset: entry.key,
        os,
        status: passed ? 'passed' : 'blocked',
        reason: passed
          ? 'All canonical checks ran successfully for this exact generation source'
          : 'Missing, failed or stale mandatory execution evidence',
        sha,
        contentId: input?.report.contentId ?? null,
        tools: input?.report.tools ?? null,
        evidence: input?.file ?? null,
        checks,
      };
    });
  });
  const mechanismCases = [
    ...['web', 'api-bindings', 'desktop'].flatMap((preset) =>
      (preset === 'desktop' ? ['linux', 'darwin', 'win32'] : ['linux']).map((os) => ({
        id: `faults-${preset}-${os}`,
        file: 'faults',
        preset,
        os,
      })),
    ),
    { id: 'worker-win32', file: 'gate-ci-worker-win32' },
    { id: 'hooks-linux', file: 'hooks', os: 'linux' },
    { id: 'hooks-win32', file: 'hooks', os: 'win32' },
    { id: 'lifecycle', file: 'lifecycle', os: 'linux' },
    { id: 'sanitization', file: 'sanitization' },
    { id: observabilityCheck.id, file: 'verified' },
    ...['agent-web-api', 'agent-desktop', 'agent-package-add'].map((id) => ({ id, file: id })),
  ];
  const mechanisms = mechanismCases.map((mechanism) => {
    const files = existsSync(directory)
      ? walk(directory).filter((file) => path.basename(file) === `${mechanism.file}.json`)
      : [];
    const evidence = files.find((file) => {
      const report = JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as {
        schema?: number;
        baselineDifferences?: string[];
        sha?: string;
        origin?: { sha?: string; dirty?: boolean };
        status?: string;
        os?: string;
        contentId?: string;
        configuration?: ProjectOptions;
        phases?: string[];
        reports?: { id: string; status: string; repaired?: boolean }[];
        rules?: unknown[];
        failures?: unknown[];
        task?: string;
        agent?: { version?: string };
        execution?: string;
        independentContext?: boolean;
        commands?: { phase: string; argv: string[]; exit: number; log: string }[];
        featureSha?: string;
      };
      if (mechanism.file === 'verified')
        return observabilityEvidenceValid(report as ObservabilityReport, expectedSource);
      if (
        report.schema !== 1 ||
        report.status !== 'passed' ||
        !report.contentId ||
        !(report.sha === sha || (report.origin?.sha === sha && report.origin.dirty === false))
      )
        return false;
      if (
        ['faults', 'hooks', 'lifecycle'].includes(mechanism.file) &&
        (!Array.isArray(report.baselineDifferences) || report.baselineDifferences.length)
      )
        return false;
      if ('os' in mechanism && report.os !== mechanism.os) return false;
      if (mechanism.file === 'gate-ci-worker-win32')
        return workerEvidenceValid(report as GateReport, expectedSource);
      if (mechanism.file === 'faults') {
        const entry = verificationCases.find(
          (entry) => entry.key === ('preset' in mechanism ? mechanism.preset : ''),
        )!;
        const options = projectOptions({
          name: 'matrix',
          scope: '@matrix',
          preset: entry.preset,
          features: entry.features,
        });
        if (
          report.configuration?.preset !== options.preset ||
          JSON.stringify(report.configuration.features.toSorted()) !==
            JSON.stringify(options.features.toSorted())
        )
          return false;
        return phasesComplete(
          report.reports,
          faultCheckIds(canonicalPackages(report.configuration)),
          true,
        );
      }
      if (mechanism.file === 'hooks')
        return (
          !!report.phases &&
          report.phases.length === hookPhases.length &&
          hookPhases.every((phase) => report.phases!.includes(phase))
        );
      if (mechanism.file === 'lifecycle') return phasesComplete(report.reports, lifecyclePhases);
      if (mechanism.file === 'sanitization')
        return !!report.rules?.length && report.failures?.length === 0;
      const required = [
        'setup',
        'doctor',
        'dev',
        'targeted-test',
        'pre-pr',
        'full',
        'build',
        'preflight',
        'commit',
        'push',
      ];
      return (
        report.execution === 'agent' &&
        report.independentContext === true &&
        !!report.task &&
        !!report.agent?.version &&
        /^[a-f0-9]{40}$/u.test(report.featureSha ?? '') &&
        !!report.commands?.length &&
        required.every((phase) =>
          report.commands!.some(
            (entry) =>
              entry.phase === phase &&
              entry.exit === 0 &&
              !!entry.log &&
              agentLogValid(path.resolve(directory, path.dirname(file)), entry.log) &&
              !entry.argv.some(
                (argument) =>
                  argument === '--no-verify' ||
                  /^(?:core\.hooksPath(?:=|$)|--config-env=core\.hooksPath)/u.test(argument),
              ) &&
              agentCommandValid(phase, entry.argv),
          ),
        )
      );
    });
    return {
      id: mechanism.id,
      status: evidence ? 'passed' : 'blocked',
      evidence: evidence ?? null,
      reason: evidence
        ? 'Exact-source complete execution report'
        : 'Required actual execution report missing, incomplete, failed or stale',
    };
  });
  return {
    schema: 1,
    sha,
    status:
      rows.every((row) => row.status === 'passed') &&
      mechanisms.every((entry) => entry.status === 'passed')
        ? 'passed'
        : 'blocked',
    rows,
    mechanisms,
  };
}

if (process.argv[1]?.endsWith(`${path.sep}acceptance.ts`)) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (
    args.length !== 4 ||
    args[0] !== '--evidence' ||
    args[2] !== '--sha' ||
    !/^[a-f0-9]{40}$/u.test(args[3]!)
  )
    throw new Error(
      'Usage: node tools/quality/acceptance.ts --evidence <directory> --sha <generation-source-sha>',
    );
  const report = acceptance(path.resolve(args[1]!), args[3]!);
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/acceptance.json', `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Execution acceptance',
    '',
    `Source SHA: ${report.sha}`,
    `Result: **${report.status}**`,
    '',
    '| Preset | OS | Result | Evidence |',
    '| --- | --- | --- | --- |',
    ...report.rows.map(
      (row) => `| ${row.preset} | ${row.os} | ${row.status} | ${row.evidence ?? 'missing'} |`,
    ),
    '',
    ...report.mechanisms.map(
      (entry) => `- ${entry.id}: ${entry.status}; ${entry.evidence ?? entry.reason}`,
    ),
  ];
  writeFileSync('artifacts/acceptance.md', `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  if (report.status !== 'passed') process.exitCode = 1;
}
