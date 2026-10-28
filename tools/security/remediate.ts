import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../process.ts';
import { execute, scan, type SecurityReport } from './scan.ts';

type Item = {
  number: number;
  body?: string | null;
  html_url: string;
  pull_request?: unknown;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  base?: { ref?: string; repo?: { full_name?: string } };
};
class GitHubFailure extends Error {
  status: number;
  constructor(status: number) {
    super(`GitHub operation failed: HTTP ${status}`);
    this.status = status;
  }
}
type RepairIdentity = { branch: string; tree: string; parent: string };
export class GitHub {
  repository: string;
  token: string;
  constructor(repository: string, token: string) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !token)
      throw new Error('Missing approved GitHub configuration');
    this.repository = repository;
    this.token = token;
  }
  async request(route: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.github.com/repos/${this.repository}/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new GitHubFailure(response.status);
    return await response.json();
  }
  async matchesCommit(sha: string, identity: RepairIdentity): Promise<boolean> {
    if (!/^[a-f0-9]{40}$/u.test(sha)) return false;
    const commit = (await this.request(`git/commits/${sha}`)) as {
      tree?: { sha?: string };
      parents?: { sha?: string }[];
    };
    return (
      commit.tree?.sha === identity.tree &&
      commit.parents?.length === 1 &&
      commit.parents[0]?.sha === identity.parent
    );
  }
  async repairBranch(identity: RepairIdentity): Promise<string | undefined> {
    let ref: { object?: { sha?: string } };
    try {
      ref = (await this.request(`git/ref/heads/${identity.branch}`)) as typeof ref;
    } catch (error) {
      if (error instanceof GitHubFailure && error.status === 404) return undefined;
      throw error;
    }
    const sha = ref.object?.sha;
    if (!sha || !(await this.matchesCommit(sha, identity)))
      throw new Error('Existing repair branch differs; preserve it and require review');
    return sha;
  }
  async existing(
    kind: 'issues' | 'pulls',
    marker: string,
    identity?: RepairIdentity,
  ): Promise<Item | undefined> {
    if (kind === 'pulls' && !identity) throw new Error('Repair PR identity is required');
    for (let page = 1; page <= 10; page++) {
      const raw = await this.request(`${kind}?state=open&per_page=100&page=${page}`);
      if (!Array.isArray(raw)) throw new Error('Invalid GitHub list');
      const items = raw as Item[];
      for (const item of items) {
        if (!item.body?.includes(marker)) continue;
        if (kind === 'issues') {
          if (!item.pull_request) return item;
        } else if (
          identity &&
          item.head?.repo?.full_name === this.repository &&
          item.base?.repo?.full_name === this.repository &&
          item.base.ref === 'main' &&
          item.head.ref === identity.branch &&
          item.head.sha &&
          (await this.matchesCommit(item.head.sha, identity))
        )
          return item;
      }
      if (items.length < 100) return undefined;
    }
    throw new Error('Unable to establish deduplication');
  }
}
export function issueBody(report: SecurityReport): string {
  const findings = report.findings.filter((item) => item.blocking);
  return [
    '<!-- security-remediation:unresolved -->',
    'Security scanning failed on the trusted main checkout.',
    `Source SHA: ${report.sha ?? 'unknown'}; content ID: ${report.contentId}.`,
    '',
    ...findings.map(
      (item) =>
        `- ${item.scanner} ${item.severity}: ${item.id} — ${item.path}${item.package ? ` (${item.package} ${item.installed}; fixed: ${item.fixed ?? 'not published'})` : ''}`,
    ),
    ...report.checks
      .filter((check) => check.status === 'failed' && !check.result)
      .map(
        (check) =>
          `- ${check.id}: execution/parsing/coverage failure; inspect the private runner log.`,
      ),
    '',
    'Renovate handles dependency security PRs when GitHub alerts/App access are configured. Review SDK compatibility before upgrading. Secrets require revocation/rotation by an authorized owner; removing a string alone does not resolve exposure.',
    'Keep this issue open until a fresh complete scan passes. Do not ignore unfixed findings, weaken thresholds, disable CI or auto-merge.',
  ].join('\n');
}
export function permittedFixes(files: string[]): void {
  if (
    !files.length ||
    files.some(
      (filename) =>
        !/^packages\/[\w-]+\/(?:src|test)\/[\w./-]+\.[cm]?[jt]sx?$/u.test(filename) ||
        filename.split('/').includes('..'),
    )
  )
    throw new Error('Autofix changed paths outside application source/tests');
}
export async function remediate(root: string): Promise<void> {
  // No pull_request_target, workflow_run artifacts, fork code or PR checkout.
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? '')
  )
    throw new Error('Remediation requires a trusted main workflow');
  const expected = process.env.GITHUB_SHA;
  if (
    !expected ||
    runSync('git', ['rev-parse', 'HEAD'], root) !== expected ||
    runSync('git', ['status', '--porcelain'], root)
  )
    throw new Error('Remediation requires a clean, exact checkout');
  const report = await scan(root);
  const outcome: { status: string; issue?: string; pullRequest?: string; source: string } = {
    status: 'running',
    source: expected,
  };
  const output = path.join(root, 'artifacts/security/remediation.json');
  try {
    if (report.status === 'passed') {
      outcome.status = 'no-findings';
      return;
    }
    const token = process.env.SECURITY_REMEDIATION_TOKEN;
    if (!token) {
      outcome.status = 'blocked-missing-approved-credential';
      throw new Error('Approved SECURITY_REMEDIATION_TOKEN is absent; scanners still fail closed');
    }
    const github = new GitHub(process.env.GITHUB_REPOSITORY ?? '', token);
    const current = (await github.request('git/ref/heads/main')) as { object?: { sha?: string } };
    if (current.object?.sha !== expected) throw new Error('Main moved; rerun on the current SHA');
    if (
      runSync('git', ['remote', 'get-url', 'origin'], root) !==
      `https://github.com/${github.repository}.git`
    )
      throw new Error('Unexpected push remote');
    const body = issueBody(report);
    const existing = await github.existing('issues', '<!-- security-remediation:unresolved -->');
    const issue =
      existing ??
      ((await github.request('issues', {
        title: '[security] Resolve blocking scanner findings',
        body,
      })) as Item);
    outcome.issue = issue.html_url;
    if (existing) await github.request(`issues/${existing.number}/comments`, { body });
    // Incomplete parsing is not a safe basis for rewriting source.
    if (report.checks.some((check) => !check.result)) {
      outcome.status = 'issue-created-scanner-blocked';
      return;
    }
    const candidates = report.findings.filter(
      (item) => item.scanner === 'semgrep' && /(?:^|\.)verified-tls$/u.test(item.id),
    );
    if (!candidates.length) {
      outcome.status = 'issue-created-no-deterministic-fix';
      return;
    }
    const privateRoot = path.join(root, '.state/security');
    mkdirSync(privateRoot, { recursive: true });
    const privateRun = mkdtempSync(path.join(privateRoot, 'fix-'));
    const code = await execute(
      'mise',
      [
        '--env',
        'security',
        'exec',
        '--',
        'semgrep',
        'scan',
        '--config',
        'tools/security/semgrep.yml',
        '--oss-only',
        '--metrics',
        'off',
        '--disable-version-check',
        '--disable-nosem',
        '--strict',
        '--autofix',
        '--json',
        '--output',
        path.join(privateRun, 'fix.json'),
        'packages',
      ],
      root,
      path.join(privateRun, 'fix.log'),
      120_000,
    );
    if (code !== 0) throw new Error('Autofix execution failed');
    const files = runSync('git', ['diff', '--name-only', '-z'], root).split('\0').filter(Boolean);
    permittedFixes(files);
    const after = await scan(root);
    if (
      after.checks.some((check) => !check.result) ||
      after.findings.some(
        (item) => item.scanner === 'semgrep' && /(?:^|\.)verified-tls$/u.test(item.id),
      )
    )
      throw new Error('Autofix failed revalidation');
    const hash = createHash('sha256')
      .update(runSync('git', ['diff', '--binary'], root))
      .digest('hex')
      .slice(0, 16);
    const marker = `<!-- security-remediation:${hash} -->`;
    const branch = `security/verified-tls-${hash}`;
    runSync('git', ['add', '--', ...files], root);
    const identity = { branch, tree: runSync('git', ['write-tree'], root), parent: expected };
    const previous = await github.existing('pulls', marker, identity);
    if (previous) {
      outcome.status = 'existing-pr-requires-current-ci';
      outcome.pullRequest = previous.html_url;
      return;
    }
    const latest = (await github.request('git/ref/heads/main')) as { object?: { sha?: string } };
    if (latest.object?.sha !== expected) throw new Error('Main moved before commit');
    const reusable = await github.repairBranch(identity);
    runSync('git', ['switch', '-c', branch], root);
    runSync('git', ['config', 'core.hooksPath', 'tools/quality/git-hooks'], root);
    runSync('git', ['config', 'user.name', 'Security remediation'], root);
    runSync('git', ['config', 'user.email', 'security-remediation@users.noreply.github.com'], root);
    if (
      (await execute(
        'git',
        ['commit', '-m', 'fix: restore TLS certificate verification'],
        root,
        path.join(privateRun, 'commit.log'),
        10 * 60_000,
      )) !== 0
    )
      throw new Error('Normal commit/hooks failed');
    const pushEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    };
    if (
      !reusable &&
      (await execute(
        'git',
        ['push', 'origin', `HEAD:refs/heads/${branch}`],
        root,
        path.join(privateRun, 'push.log'),
        15 * 60_000,
        pushEnv,
      )) !== 0
    )
      throw new Error('Normal push/hooks failed');
    const pr = (await github.request('pulls', {
      title: 'fix: restore TLS certificate verification',
      head: branch,
      base: 'main',
      body: [
        marker,
        'Enable certificate verification using the local reviewed Semgrep autofix rule.',
        `Source: ${expected}. Follow-up: ${outcome.issue}.`,
        reusable
          ? `Resumed matching remote branch ${reusable} after interrupted PR creation. Its exact tree and main parent were verified, and normal local commit hooks ran again. Fresh Security/Quality CI and review remain mandatory; this workflow never merges.`
          : 'Normal commit and pre-push hooks ran. Fresh Security and Quality CI, review and SDK/runtime validation remain mandatory; this workflow never merges.',
        `Post-fix security result: ${after.status}; unresolved findings remain blocking.`,
      ].join('\n\n'),
    })) as Item;
    outcome.status = 'pr-created-review-required';
    outcome.pullRequest = pr.html_url;
  } catch (error) {
    if (outcome.status === 'running') outcome.status = 'blocked';
    throw error;
  } finally {
    writeFileSync(output, `${JSON.stringify(outcome, null, 2)}\n`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await remediate(process.cwd());
