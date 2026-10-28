import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnOwned, stopTree } from '../process.ts';
import { contentId } from '../quality/gate.ts';
import { headSha } from '../quality/checkout.ts';
import { securityChecks } from '../quality/definitions.ts';
import { workspacePackages } from '../quality/graph.ts';
import {
  semgrepReport,
  trivyReport,
  trivyDatabase,
  type Finding,
  type ScanResult,
} from './policy.ts';

export type SecurityReport = {
  schema: 1;
  sha: string | null;
  contentId: string;
  semgrepInputId?: string;
  createdAt: string;
  status: 'passed' | 'failed';
  checks: {
    id: string;
    status: 'passed' | 'failed';
    milliseconds: number;
    reason?: string;
    result?: ScanResult;
  }[];
  findings: Finding[];
};
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  log: string,
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const descriptor = openSync(log, 'wx', 0o600);
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      MISE_AUTO_INSTALL: 'false',
      SEMGREP_SEND_METRICS: 'off',
    };
    delete childEnv.SECURITY_REMEDIATION_TOKEN;
    // Scanner configuration must not suppress findings through inherited input.
    for (const key of Object.keys(childEnv))
      if (key.startsWith('TRIVY_') || key.startsWith('SEMGREP_')) delete childEnv[key];
    childEnv.SEMGREP_SEND_METRICS = 'off';
    return await new Promise<number>((resolve, reject) => {
      const child = spawnOwned(command, args, {
        cwd,
        stdio: ['ignore', descriptor, descriptor],
        env: childEnv,
      });
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        void stopTree(child).catch(reject);
      }, timeout);
      child.once('error', (error) => {
        clearTimeout(timer);
        void stopTree(child).then(() => reject(error), reject);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        void stopTree(child).then(() => {
          if (expired || code === null) reject(new Error('Scanner terminated or timed out'));
          else resolve(code);
        }, reject);
      });
    });
  } finally {
    closeSync(descriptor);
  }
}
export function expectedSources(root: string): string[] {
  const files: string[] = [];
  const excluded = new Set([
    '.git',
    '.state',
    '.template-cache',
    'artifacts',
    'generated',
    'test-results',
    'playwright-report',
    ...workspacePackages(root).flatMap((pkg) =>
      [
        'dist',
        'artifacts',
        'test-results',
        'playwright-report',
        '.cloudflare',
        '.wrangler',
        'src-tauri/target',
        'src-tauri/gen',
      ].map((suffix) => `${pkg.directory}/${suffix}`),
    ),
  ]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const filename = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name === 'node_modules' || excluded.has(filename)) continue;
      if (entry.isSymbolicLink()) throw new Error('Unexpected source symlink');
      if (entry.isDirectory()) {
        visit(filename);
      } else if (
        /\.(?:[cm]?[jt]sx?|rs|ya?ml|json|html|sh|ps1)$/u.test(filename) &&
        !/^packages\/[\w-]+\/src\/routeTree\.gen\.ts$/u.test(filename)
      )
        files.push(filename);
    }
  };
  visit('');
  return files.sort();
}
export function semgrepInputId(root: string, sources = expectedSources(root)): string {
  const hash = createHash('sha256');
  for (const filename of sources)
    hash.update(
      `${JSON.stringify([
        filename,
        createHash('sha256')
          .update(readFileSync(path.join(root, filename)))
          .digest('hex'),
      ])}\n`,
    );
  return hash.digest('hex');
}
const policyFailures = new Set([
  'Invalid scanner object',
  'Invalid scanner array',
  'Invalid scanner identifier',
  'Scanner path escapes source',
  'Unknown scanner severity',
  'Unsupported Trivy report',
  'Trivy repository identity does not match checkout',
  'Suppressed Trivy findings are not permitted',
  'Unexpected dependency ecosystem',
  'Zero-package dependency scan',
  'Required lockfile was not scanned',
  'Zero required lockfiles',
  'Semgrep parsing/engine errors',
  'Semgrep scanned zero files',
  'Required source file was not scanned',
  'Expected OSS Semgrep engine',
  'Invalid finding line',
  'Invalid scanner database timestamp',
  'Stale or invalid scanner database',
]);
function expectedVersion(root: string, scanner: string): string {
  const profile = readFileSync(path.join(root, 'mise.security.toml'), 'utf8');
  const match =
    scanner === 'trivy'
      ? /"aqua:aquasecurity\/trivy"\s*=\s*"([\d.]+)"/u.exec(profile)
      : /"pypi:semgrep"\s*=\s*\{\s*version\s*=\s*"([\d.]+)"/u.exec(profile);
  if (!match?.[1]) throw new Error('Missing pinned scanner version');
  return match[1];
}
export async function scan(root: string, scanner?: string): Promise<SecurityReport> {
  if (scanner && !securityChecks.some((check) => check.id === scanner))
    throw new Error('Unknown scanner');
  const privateRoot = path.join(root, '.state/security');
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const output = path.join(root, 'artifacts/security/report.json');
  mkdirSync(path.dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const privateRun = mkdtempSync(path.join(privateRoot, 'scan-'));
  const before = contentId(root);
  const report: SecurityReport = {
    schema: 1,
    sha: headSha(root),
    contentId: before,
    createdAt: new Date().toISOString(),
    status: 'failed',
    checks: [],
    findings: [],
  };
  const locks = [
    'pnpm-lock.yaml',
    ...workspacePackages(root)
      .filter((pkg) => pkg.runtime === 'desktop')
      .map((pkg) => `${pkg.directory}/src-tauri/Cargo.lock`),
  ];
  for (const check of securityChecks.filter((entry) => !scanner || entry.id === scanner)) {
    const started = performance.now();
    const raw = path.join(privateRun, `${check.id}.json`);
    let stage = 'lockfile-coverage';
    let exitCode: number | undefined;
    try {
      for (const lock of locks)
        if (!existsSync(path.join(root, lock))) throw new Error('Missing lockfile');
      stage = 'source-coverage';
      const sources = check.id === 'semgrep' ? expectedSources(root) : [];
      if (check.id === 'semgrep') report.semgrepInputId = semgrepInputId(root, sources);
      const args =
        check.id === 'trivy'
          ? [
              'fs',
              '--config',
              '',
              '--secret-config',
              '',
              '--severity',
              'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL',
              '--ignore-unfixed=false',
              '--ignore-status',
              '',
              '--ignore-policy',
              '',
              '--vex',
              '',
              '--scanners',
              'vuln,misconfig,secret',
              '--include-dev-deps',
              '--list-all-pkgs',
              '--format',
              'json',
              '--output',
              raw,
              '--ignorefile',
              '',
              '--disable-telemetry',
              '--timeout',
              '10m',
              ...[
                '.git',
                'node_modules',
                'artifacts',
                '.state',
                'generated',
                ...workspacePackages(root).flatMap((pkg) =>
                  [
                    'dist',
                    'artifacts',
                    'test-results',
                    '.cloudflare',
                    '.wrangler',
                    'src-tauri/target',
                    'src-tauri/gen',
                  ].map((suffix) => `${pkg.directory}/${suffix}`),
                ),
              ].flatMap((directory) => ['--skip-dirs', directory]),
              '.',
            ]
          : [
              'scan',
              '--config',
              'p/default',
              '--config',
              'tools/security/semgrep.yml',
              '--oss-only',
              '--metrics',
              'off',
              '--disable-version-check',
              '--disable-nosem',
              '--no-git-ignore',
              '--strict',
              '--severity',
              'ERROR',
              '--error',
              '--json',
              '--output',
              raw,
              // Exact first-party inputs also own mandatory report coverage.
              // Prefix paths so a user-authored filename cannot become an option.
              ...sources.map((filename) => `./${filename}`),
            ];
      stage = 'execution';
      const code = await execute(
        'mise',
        ['--env', 'security', 'exec', '--', check.id, ...args],
        root,
        path.join(privateRun, `${check.id}.log`),
        check.timeout,
      );
      exitCode = code;
      if (code !== 0 && !(check.id === 'semgrep' && code === 1))
        throw new Error('Scanner execution failed');
      stage = 'report-json';
      const input: unknown = JSON.parse(readFileSync(raw, 'utf8'));
      stage = 'schema-and-coverage';
      const result =
        check.id === 'trivy'
          ? trivyReport(input, locks, report.sha)
          : semgrepReport(input, sources);
      stage = 'version';
      if (result.version !== expectedVersion(root, check.id))
        throw new Error('Unexpected scanner version');
      if (check.id === 'trivy') {
        stage = 'database-execution';
        const metadata = path.join(privateRun, 'trivy-database.json');
        if (
          (await execute(
            'mise',
            ['--env', 'security', 'exec', '--', 'trivy', '--version', '--format', 'json'],
            root,
            metadata,
            30_000,
          )) !== 0
        )
          throw new Error('Database metadata unavailable');
        stage = 'database-freshness';
        result.database = trivyDatabase(JSON.parse(readFileSync(metadata, 'utf8')) as unknown);
      }
      stage = 'exit-consistency';
      if (check.id === 'semgrep' && code === 1 && !result.findings.some((item) => item.blocking))
        throw new Error('Unexplained scanner failure');
      report.findings.push(...result.findings);
      report.checks.push({
        id: check.id,
        status: result.findings.some((item) => item.blocking) ? 'failed' : 'passed',
        milliseconds: Math.round(performance.now() - started),
        result,
      });
    } catch (error) {
      // Raw logs stay private: failure text can contain source or credentials.
      report.checks.push({
        id: check.id,
        status: 'failed',
        milliseconds: Math.round(performance.now() - started),
        reason: `${stage} failed${exitCode === undefined ? '' : `; scanner exit ${exitCode}`}${error instanceof Error && policyFailures.has(error.message) ? `; ${error.message}` : ''}; inspect private .state/security logs`,
      });
    }
  }
  if (contentId(root) !== before)
    report.checks.push({
      id: 'source-integrity',
      status: 'failed',
      milliseconds: 0,
      reason: 'Source changed during read-only scan',
    });
  if (report.semgrepInputId) {
    let unchanged = false;
    try {
      unchanged = semgrepInputId(root) === report.semgrepInputId;
    } catch {
      // Missing/unreadable/raced source remains an integrity failure.
    }
    if (!unchanged)
      report.checks.push({
        id: 'semgrep-source-integrity',
        status: 'failed',
        milliseconds: 0,
        reason: 'SAST input changed or could not be verified after read-only scan',
      });
  }
  report.status =
    report.checks.length > 0 && report.checks.every((check) => check.status === 'passed')
      ? 'passed'
      : 'failed';
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.length && (args.length !== 2 || args[0] !== '--scanner'))
    throw new Error('Expected --scanner trivy|semgrep');
  const report = await scan(process.cwd(), args[1]);
  console.log(
    `Security ${report.status}: ${report.findings.filter((item) => item.blocking).length} blocking findings; artifacts/security/report.json`,
  );
  for (const check of report.checks) if (check.reason) console.log(`${check.id}: ${check.reason}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
