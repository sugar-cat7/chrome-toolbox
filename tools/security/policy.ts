import { createHash } from 'node:crypto';

export type Finding = {
  scanner: 'trivy' | 'semgrep';
  kind: 'dependency' | 'configuration' | 'secret' | 'code';
  id: string;
  path: string;
  severity: string;
  blocking: boolean;
  package?: string;
  installed?: string;
  fixed?: string;
  line?: number;
  fingerprint: string;
};
export type ScanResult = {
  version: string;
  scanned: string[];
  findings: Finding[];
  database?: { updatedAt: string; nextUpdate: string; downloadedAt: string; checksDigest: string };
};

export function trivyDatabase(
  input: unknown,
  now = Date.now(),
): NonNullable<ScanResult['database']> {
  const version = object(input);
  const db = object(version.VulnerabilityDB);
  const checks = object(version.CheckBundle);
  const timestamp = (value: unknown): number => {
    const date = Date.parse(text(value));
    if (!Number.isFinite(date) || date > now + 300_000)
      throw new Error('Invalid scanner database timestamp');
    return date;
  };
  const updated = timestamp(db.UpdatedAt);
  const downloaded = timestamp(db.DownloadedAt);
  const next = Date.parse(text(db.NextUpdate));
  const digest = text(checks.Digest);
  timestamp(checks.DownloadedAt);
  if (
    db.Version !== 2 ||
    !Number.isFinite(next) ||
    next <= now ||
    next <= updated ||
    !/^sha256:[a-f0-9]{64}$/u.test(digest)
  )
    throw new Error('Stale or invalid scanner database');
  return {
    updatedAt: new Date(updated).toISOString(),
    downloadedAt: new Date(downloaded).toISOString(),
    nextUpdate: new Date(next).toISOString(),
    checksDigest: digest,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid scanner object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid scanner array');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\p{Cc}]/u.test(value))
    throw new Error('Invalid scanner identifier');
  return value;
}
export function sourcePath(value: unknown): string {
  const filename = text(value).replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    filename.startsWith('/') ||
    filename.includes(':') ||
    filename.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('Scanner path escapes source');
  return filename;
}
function finding(value: Omit<Finding, 'fingerprint'>): Finding {
  return {
    ...value,
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          value.scanner,
          value.kind,
          value.id,
          value.path,
          value.package ?? '',
          value.installed ?? '',
          value.line ?? 0,
        ]),
      )
      .digest('hex'),
  };
}
function severity(value: unknown, allowed: string[]): string {
  const level = text(value);
  if (!allowed.includes(level)) throw new Error('Unknown scanner severity');
  return level;
}

// Publish identifiers/locations only. Never copy secret matches, source snippets,
// arbitrary rule messages, scanner errors or environment values into artifacts.
export function trivyReport(
  input: unknown,
  expectedLocks: string[],
  expectedSha?: string | null,
): ScanResult {
  const report = object(input);
  if (
    report.SchemaVersion !== 2 ||
    (report.ArtifactType !== 'filesystem' && report.ArtifactType !== 'repository')
  )
    throw new Error('Unsupported Trivy report');
  if (
    report.ArtifactType === 'repository' &&
    (!expectedSha || object(report.Metadata).Commit !== expectedSha)
  )
    throw new Error('Trivy repository identity does not match checkout');
  const version = text(object(report.Trivy).Version);
  const scanned: string[] = [];
  const findings: Finding[] = [];
  for (const entry of array(report.Results)) {
    const result = object(entry);
    const filename = sourcePath(result.Target);
    if (array(result.ExperimentalModifiedFindings ?? []).length)
      throw new Error('Suppressed Trivy findings are not permitted');
    if (result.Class === 'lang-pkgs') {
      if (!['pnpm', 'cargo'].includes(text(result.Type)))
        throw new Error('Unexpected dependency ecosystem');
      if (!array(result.Packages).length) throw new Error('Zero-package dependency scan');
      scanned.push(filename);
    }
    for (const [field, kind] of [
      ['Vulnerabilities', 'dependency'],
      ['Misconfigurations', 'configuration'],
      ['Secrets', 'secret'],
    ] as const) {
      for (const raw of array(result[field] ?? [])) {
        const item = object(raw);
        const level = severity(item.Severity, ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
        findings.push(
          finding({
            scanner: 'trivy',
            kind,
            id: text(item.VulnerabilityID ?? item.ID ?? item.RuleID),
            path: filename,
            severity: level,
            blocking: ['HIGH', 'CRITICAL'].includes(level),
            ...(kind === 'dependency'
              ? { package: text(item.PkgName), installed: text(item.InstalledVersion) }
              : {}),
            ...(item.FixedVersion ? { fixed: text(item.FixedVersion) } : {}),
          }),
        );
      }
    }
  }
  for (const filename of expectedLocks)
    if (!scanned.includes(filename)) throw new Error('Required lockfile was not scanned');
  if (!expectedLocks.length) throw new Error('Zero required lockfiles');
  return { version, scanned: scanned.sort(), findings };
}

export function semgrepReport(input: unknown, expected: string[] = []): ScanResult {
  const report = object(input);
  if (array(report.errors).length) throw new Error('Semgrep parsing/engine errors');
  const scanned = array(object(report.paths).scanned).map(sourcePath).sort();
  if (!scanned.length) throw new Error('Semgrep scanned zero files');
  for (const filename of expected)
    if (!scanned.includes(filename)) throw new Error('Required source file was not scanned');
  if (report.engine_requested !== 'OSS') throw new Error('Expected OSS Semgrep engine');
  const findings = array(report.results).map((raw) => {
    const item = object(raw);
    const extra = object(item.extra);
    const level = severity(extra.severity, ['INFO', 'WARNING', 'ERROR']);
    const line = object(item.start).line;
    if (!Number.isSafeInteger(line) || Number(line) < 1) throw new Error('Invalid finding line');
    return finding({
      scanner: 'semgrep',
      kind: 'code',
      id: text(item.check_id),
      path: sourcePath(item.path),
      line: Number(line),
      severity: level,
      blocking: level === 'ERROR',
    });
  });
  return { version: text(report.version), scanned, findings };
}
