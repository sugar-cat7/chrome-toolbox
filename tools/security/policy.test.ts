import { describe, expect, it, vi, afterEach } from 'vitest';
import { semgrepReport, sourcePath, trivyReport, trivyDatabase } from './policy.ts';
import { GitHub, issueBody, permittedFixes } from './remediate.ts';

function trivy(level = 'HIGH', fixed?: string) {
  return {
    SchemaVersion: 2,
    ArtifactType: 'filesystem',
    Trivy: { Version: '0.75.0' },
    Results: [
      {
        Target: 'pnpm-lock.yaml',
        Class: 'lang-pkgs',
        Type: 'pnpm',
        Packages: [{ Name: 'fixture' }],
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-fixture',
            PkgName: 'fixture',
            InstalledVersion: '1.0.0',
            Severity: level,
            ...(fixed ? { FixedVersion: fixed } : {}),
            Description: 'sensitive raw detail',
          },
        ],
      },
    ],
  };
}
function semgrep(level = 'ERROR') {
  return {
    version: '1.180.0',
    engine_requested: 'OSS',
    paths: { scanned: ['packages/web/src/a.ts'] },
    errors: [],
    results: [
      {
        check_id: 'verified-tls',
        path: 'packages/web/src/a.ts',
        start: { line: 1 },
        extra: { severity: level, lines: 'sensitive raw detail', message: 'sensitive raw detail' },
      },
    ],
  };
}
describe('fail-closed security policy', () => {
  it('requires current database timestamps and records the checks bundle digest', () => {
    const now = Date.parse('2026-10-11T03:00:00Z');
    const input = {
      VulnerabilityDB: {
        Version: 2,
        UpdatedAt: '2026-10-11T01:00:00Z',
        DownloadedAt: '2026-10-11T02:00:00Z',
        NextUpdate: '2026-10-12T01:00:00Z',
      },
      CheckBundle: { Digest: `sha256:${'a'.repeat(64)}`, DownloadedAt: '2026-10-11T02:00:00Z' },
    };
    expect(trivyDatabase(input, now).checksDigest).toBe(input.CheckBundle.Digest);
    expect(() =>
      trivyDatabase(
        {
          ...input,
          VulnerabilityDB: { ...input.VulnerabilityDB, NextUpdate: '2026-10-10T01:00:00Z' },
        },
        now,
      ),
    ).toThrow('Stale or invalid scanner database');
    expect(() =>
      trivyDatabase(
        {
          ...input,
          VulnerabilityDB: { ...input.VulnerabilityDB, UpdatedAt: '2026-10-12T01:00:00Z' },
        },
        now,
      ),
    ).toThrow('Invalid scanner database timestamp');
  });
  it.each(['HIGH', 'CRITICAL'])('blocks %s dependencies even without a fix', (level) => {
    const result = trivyReport(trivy(level), ['pnpm-lock.yaml']);
    expect(result.findings[0]?.blocking).toBe(true);
    expect(result.findings[0]?.fixed).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('sensitive raw detail');
  });
  it('keeps medium findings visible and records available fixes', () => {
    const result = trivyReport(trivy('MEDIUM', '1.0.1'), ['pnpm-lock.yaml']);
    expect(result.findings[0]).toMatchObject({ blocking: false, fixed: '1.0.1' });
  });
  it('accepts the SDK repository classification only with an exact checkout identity', () => {
    const sha = 'a'.repeat(40);
    const input = { ...trivy(), ArtifactType: 'repository', Metadata: { Commit: sha } };
    expect(trivyReport(input, ['pnpm-lock.yaml'], sha).findings[0]?.blocking).toBe(true);
    expect(() => trivyReport(input, ['pnpm-lock.yaml'], 'b'.repeat(40))).toThrow(
      'Trivy repository identity does not match checkout',
    );
    expect(() => trivyReport(input, ['pnpm-lock.yaml'])).toThrow(
      'Trivy repository identity does not match checkout',
    );
    expect(() =>
      trivyReport({ ...input, ArtifactType: ['repository'] }, ['pnpm-lock.yaml'], sha),
    ).toThrow('Unsupported Trivy report');
    expect(() => trivyReport({ ...input, Metadata: undefined }, ['pnpm-lock.yaml'], sha)).toThrow(
      'Invalid scanner object',
    );
    expect(() => trivyReport({ ...input, Metadata: {} }, ['pnpm-lock.yaml'], sha)).toThrow(
      'Trivy repository identity does not match checkout',
    );
  });
  it('rejects reports containing suppressed experimental findings', () => {
    const input = trivy();
    const result = {
      ...input.Results[0],
      ExperimentalModifiedFindings: [{ Status: 'not_affected' }],
    };
    expect(() => trivyReport({ ...input, Results: [result] }, ['pnpm-lock.yaml'])).toThrow(
      'Suppressed Trivy findings are not permitted',
    );
  });
  it('rejects missing native coverage, empty package scans and schema changes', () => {
    expect(() =>
      trivyReport(trivy(), ['pnpm-lock.yaml', 'packages/desktop/src-tauri/Cargo.lock']),
    ).toThrow('Required lockfile was not scanned');
    const empty = trivy();
    empty.Results[0]!.Packages = [];
    expect(() => trivyReport(empty, ['pnpm-lock.yaml'])).toThrow('Zero-package dependency scan');
    expect(() => trivyReport({ ...trivy(), SchemaVersion: 3 }, ['pnpm-lock.yaml'])).toThrow(
      'Unsupported Trivy report',
    );
    expect(() => trivyReport(trivy('NEW-SEVERITY'), ['pnpm-lock.yaml'])).toThrow(
      'Unknown scanner severity',
    );
  });
  it('blocks ERROR SAST and strips source snippets', () => {
    const result = semgrepReport(semgrep());
    expect(result.findings[0]?.blocking).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sensitive raw detail');
    expect(semgrepReport(semgrep('WARNING')).findings[0]?.blocking).toBe(false);
  });
  it('rejects partial parsing, zero files and unexpected engines', () => {
    expect(() => semgrepReport({ ...semgrep(), errors: [{ type: 'PartialParsing' }] })).toThrow(
      'Semgrep parsing/engine errors',
    );
    expect(() => semgrepReport({ ...semgrep(), paths: { scanned: [] } })).toThrow(
      'Semgrep scanned zero files',
    );
    expect(() => semgrepReport({ ...semgrep(), engine_requested: 'PRO' })).toThrow(
      'Expected OSS Semgrep engine',
    );
    expect(() => semgrepReport({ ...semgrep(), errors: null })).toThrow('Invalid scanner array');
  });
  it('rejects skipped required source even when another file was scanned', () => {
    const input = {
      ...semgrep(),
      paths: {
        scanned: ['packages/web/src/a.ts'],
        skipped: [{ path: 'packages/web/src/oversized.ts', reason: 'exceeded_size_limit' }],
      },
    };
    expect(() =>
      semgrepReport(input, ['packages/web/src/a.ts', 'packages/web/src/oversized.ts']),
    ).toThrow('Required source file was not scanned');
  });
  it.each(['../outside.ts', '/tmp/a.ts', 'C:\\a.ts', 'a/../b', 'a\nsecret', './a//b'])(
    'rejects unsafe scanner path %j',
    (filename) => {
      expect(() => sourcePath(filename)).toThrow(
        /Invalid scanner identifier|Scanner path escapes source/u,
      );
    },
  );
  it('reports configuration and secret findings without secret matches', () => {
    const input = {
      ...trivy(),
      Results: [
        {
          Target: 'config.ts',
          Secrets: [
            { RuleID: 'fixture-secret', Severity: 'CRITICAL', Match: 'sensitive raw detail' },
          ],
          Misconfigurations: [
            { ID: 'fixture-config', Severity: 'HIGH', Message: 'sensitive raw detail' },
          ],
        },
        ...trivy().Results,
      ],
    };
    const result = trivyReport(input, ['pnpm-lock.yaml']);
    expect(result.findings.filter((item) => item.blocking)).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('sensitive raw detail');
    expect(new Set(result.findings.map((item) => item.fingerprint)).size).toBe(3);
  });
});
describe('bounded, reviewed remediation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('permits application source only, preserving workflow/manifest/user boundaries', () => {
    expect(() => permittedFixes(['packages/web/src/server.ts'])).not.toThrow();
    for (const files of [
      [],
      ['.github/workflows/quality.yml'],
      ['package.json'],
      ['packages/web/src/../package.json'],
    ])
      expect(() => permittedFixes(files)).toThrow(
        'Autofix changed paths outside application source/tests',
      );
  });
  it('deduplicates existing issues with bounded paginated GitHub requests', async () => {
    const request = vi
      .fn<
        (input: string, init: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
      >()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          Array.from({ length: 100 }, () => ({
            number: 1,
            body: 'unrelated',
            html_url: 'https://github.com/example/project/issues/1',
          })),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 2,
            body: '<!-- security-remediation:unresolved -->',
            html_url: 'https://github.com/example/project/issues/2',
          },
        ],
      });
    vi.stubGlobal('fetch', request);
    const github = new GitHub('example/project', 'approved-fixture-credential');
    expect(
      (await github.existing('issues', '<!-- security-remediation:unresolved -->'))?.number,
    ).toBe(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toContain('page=2');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
  it('fails API errors and validates repository configuration', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      new GitHub('example/project', 'approved-fixture-credential').request('issues'),
    ).rejects.toThrow('HTTP 403');
    expect(() => new GitHub('../other/project', 'credential')).toThrow(
      'Missing approved GitHub configuration',
    );
    expect(() => new GitHub('example/project', '')).toThrow(
      'Missing approved GitHub configuration',
    );
  });
  it('ignores PRs in the Issue API and unrelated fork repair markers', async () => {
    const sha = 'a'.repeat(40);
    const identity = {
      branch: 'security/verified-tls-fixture',
      tree: 'b'.repeat(40),
      parent: 'c'.repeat(40),
    };
    const github = new GitHub('example/project', 'approved-fixture-credential');
    const request = vi.spyOn(github, 'request');
    request.mockResolvedValueOnce([
      { number: 1, body: 'marker', pull_request: {}, html_url: 'pr' },
      { number: 2, body: 'marker', html_url: 'issue' },
    ]);
    expect((await github.existing('issues', 'marker'))?.number).toBe(2);
    const pull = {
      number: 3,
      body: 'marker',
      html_url: 'trusted',
      head: { ref: identity.branch, sha, repo: { full_name: 'example/project' } },
      base: { ref: 'main', repo: { full_name: 'example/project' } },
    };
    request
      .mockResolvedValueOnce([
        { ...pull, number: 4, head: { ...pull.head, repo: { full_name: 'fork/project' } } },
        pull,
      ])
      .mockResolvedValueOnce({ tree: { sha: identity.tree }, parents: [{ sha: identity.parent }] });
    expect((await github.existing('pulls', 'marker', identity))?.number).toBe(3);
    expect(request).toHaveBeenLastCalledWith(`git/commits/${sha}`);
    request.mockResolvedValueOnce([pull]).mockResolvedValueOnce({
      tree: { sha: 'd'.repeat(40) },
      parents: [{ sha: identity.parent }],
    });
    expect(await github.existing('pulls', 'marker', identity)).toBeUndefined();
    request.mockResolvedValueOnce([pull]).mockResolvedValueOnce({
      tree: { sha: identity.tree },
      parents: [{ sha: 'd'.repeat(40) }],
    });
    expect(await github.existing('pulls', 'marker', identity)).toBeUndefined();
  });
  it('resumes exact matching pushed branches and rejects conflicting ones without force', async () => {
    const identity = {
      branch: 'security/verified-tls-fixture',
      tree: 'b'.repeat(40),
      parent: 'c'.repeat(40),
    };
    const github = new GitHub('example/project', 'approved-fixture-credential');
    const sha = 'a'.repeat(40);
    const request = vi.spyOn(github, 'request');
    request.mockResolvedValueOnce({ object: { sha } }).mockResolvedValueOnce({
      tree: { sha: identity.tree },
      parents: [{ sha: identity.parent }],
    });
    await expect(github.repairBranch(identity)).resolves.toBe(sha);
    request.mockResolvedValueOnce({ object: { sha } }).mockResolvedValueOnce({
      tree: { sha: 'd'.repeat(40) },
      parents: [{ sha: identity.parent }],
    });
    await expect(github.repairBranch(identity)).rejects.toThrow('Existing repair branch differs');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    request.mockRestore();
    await expect(github.repairBranch(identity)).resolves.toBeUndefined();
  });
  it('records unresolved findings with source identity and owner action', () => {
    const findings = trivyReport(trivy(), ['pnpm-lock.yaml']).findings;
    const body = issueBody({
      schema: 1,
      sha: 'fixture-sha',
      contentId: 'fixture-content',
      createdAt: new Date().toISOString(),
      status: 'failed',
      checks: [],
      findings,
    });
    expect(body).toContain('fixture-sha');
    expect(body).toContain('not published');
    expect(body).toContain('revocation/rotation');
    expect(body).not.toContain('sensitive raw detail');
  });
  it.each([403, 500])('preserves branch lookup failure HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
    await expect(
      new GitHub('example/project', 'approved-fixture-credential').repairBranch({
        branch: 'security/verified-tls-fixture',
        tree: 'b'.repeat(40),
        parent: 'c'.repeat(40),
      }),
    ).rejects.toThrow(`HTTP ${status}`);
  });
});
