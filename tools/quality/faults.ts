import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnOwned, pnpmCommand, pnpm, run, stopTree } from '../process.ts';
import { copyProjectFixture, initializeVerificationGit } from './fixture.ts';
import { foreignGitEnvironment } from './hooks.ts';
import { walk } from '../generators/files.ts';
import { workspacePackages } from './graph.ts';
import { contentId } from './gate.ts';
import { faultCheckIds } from './definitions.ts';
import { baselineDifferences } from '../generators/baseline.ts';
import { writeEvidenceAfterCleanup } from './evidence.ts';

async function capture(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  const invocation = pnpmCommand(args);
  return await new Promise((resolve, reject) => {
    const child = spawnOwned(invocation.command, invocation.args, {
      cwd: root,
      env: { ...foreignGitEnvironment(root), ...env, STARTER_CHECK_PHASE: 'quality' },
      detached: process.platform !== 'win32',
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000000);
    });
    const timer = setTimeout(() => {
      void stopTree(child).then(
        () => reject(new Error(`Fault command timed out: ${args.join(' ')}`)),
        reject,
      );
    }, 30 * 60000);
    child.once('error', (error) => {
      clearTimeout(timer);
      void stopTree(child).then(() => reject(error), reject);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export async function faultRehearsal(project: string): Promise<void> {
  const environment = foreignGitEnvironment(project);
  const owned = mkdtempSync(path.join(os.tmpdir(), 'starter-faults-'));
  const root = path.join(owned, 'project');
  const failures: unknown[] = [];
  let completed = false;
  let report: Record<string, unknown> & { status: string; error?: string } = {
    schema: 1,
    status: 'failed',
    os: process.platform,
    reports: [],
  };
  try {
    copyProjectFixture(project, root);
    initializeVerificationGit(root, environment);
    await pnpm(['env:setup'], { cwd: root, env: environment, timeout: 10 * 60000 });
    await injectFaults(root);
    completed = true;
  } catch (error) {
    failures.push(error);
  }
  const artifacts = path.join(root, 'artifacts');
  const destination = path.join(project, 'artifacts', `fault-rehearsal-${process.platform}`);
  const filename = path.join(destination, 'faults.json');
  try {
    const original = path.join(artifacts, 'faults.json');
    if (existsSync(original)) {
      const parsed: unknown = JSON.parse(readFileSync(original, 'utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !('status' in parsed) ||
        typeof parsed.status !== 'string'
      )
        throw new Error('Invalid fault rehearsal evidence');
      report = parsed as typeof report;
    } else if (completed) {
      throw new Error('Fault rehearsal did not produce its required final evidence');
    }
    if (existsSync(artifacts)) {
      rmSync(destination, { recursive: true, force: true });
      cpSync(artifacts, destination, { recursive: true });
    }
  } catch (error) {
    failures.push(error);
  }
  if (!completed || failures.length) {
    report.status = 'failed';
    report.error = failures.map(String).join('\n');
  }
  try {
    writeEvidenceAfterCleanup(filename, report, () =>
      rmSync(owned, { recursive: true, force: true }),
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Fault rehearsal failed');
}

async function injectFaults(root: string): Promise<void> {
  const environment = foreignGitEnvironment(root);
  await pnpm(['check'], { cwd: root, env: environment });
  const directory = path.join(root, 'artifacts/faults');
  mkdirSync(directory, { recursive: true });
  const before = contentId(root);
  const inputBaseline = baselineDifferences(root);
  const origin = (
    JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as { origin?: unknown }
  ).origin;
  const reports: {
    id: string;
    command: string[];
    status: 'passed' | 'failed';
    repaired: boolean;
    milliseconds: number;
    log: string;
  }[] = [];
  const fault = async (
    id: string,
    changes: Record<string, string>,
    command: string[],
    reason: RegExp,
    repair: string[],
    env: NodeJS.ProcessEnv = {},
  ) => {
    const started = performance.now();
    const originals = Object.keys(changes).map((relative) => {
      const filename = path.join(root, relative);
      const previous = existsSync(filename) ? readFileSync(filename) : undefined;
      return { filename, previous };
    });
    let detected = false;
    try {
      for (const [relative, contents] of Object.entries(changes))
        writeFileSync(path.join(root, relative), contents);
      const nativeRoots = new Set(
        originals
          .filter((entry) => entry.filename.endsWith('.rs'))
          .map((entry) => path.dirname(path.dirname(entry.filename))),
      );
      for (const cwd of nativeRoots) await run('cargo', ['fmt'], { cwd, env: environment });
      const result = await capture(root, command, env);
      writeFileSync(path.join(directory, `${id}.log`), result.output);
      assert.notEqual(result.code, 0, `${id} must fail`);
      assert.match(result.output, reason, `${id} failed for an unrelated reason`);
      detected = true;
    } finally {
      for (const { filename, previous } of originals) {
        if (previous) writeFileSync(filename, previous);
        else rmSync(filename, { force: true });
      }
      const report = {
        id,
        command,
        status: detected ? ('passed' as const) : ('failed' as const),
        repaired: false,
        milliseconds: Math.round(performance.now() - started),
        log: `artifacts/faults/${id}.log`,
      };
      reports.push(report);
      try {
        if (detected) {
          await pnpm(repair, { cwd: root, env: environment, timeout: 30 * 60000 });
          report.repaired = true;
          console.log(`FAULT ${id}: detected for the required reason and repaired`);
        }
      } finally {
        report.milliseconds = Math.round(performance.now() - started);
        writeFileSync(
          path.join(root, 'artifacts/faults.json'),
          `${JSON.stringify({ schema: 1, status: reports.every((entry) => entry.status === 'passed' && entry.repaired) ? 'running' : 'failed', origin, contentId: before, os: process.platform, reports }, null, 2)}\n`,
        );
      }
    }
  };
  const probe = 'tools/fault-probe.ts';
  // Restore a real owned suite so each repair proves the same checker succeeds.
  // The complete tooling suite still runs once after all unit faults are repaired.
  const testProbe = 'tools/quality/test-results.test.ts';
  const skill = '.agents/skills/application/SKILL.md';
  await fault(
    'skill-metadata',
    {
      [skill]: readFileSync(path.join(root, skill), 'utf8').replace(
        /^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/u,
        '',
      ),
    },
    ['check'],
    /skill requires YAML frontmatter/u,
    ['check'],
  );
  await fault(
    'format',
    { [probe]: 'export const formatFault="needs formatting"\n' },
    ['exec', 'vp', 'fmt', '--check', probe],
    /Format issues found/iu,
    ['check'],
  );
  await fault('lint', { [probe]: 'debugger;\n' }, ['exec', 'vp', 'lint', probe], /no-debugger/u, [
    'check',
  ]);
  await fault(
    'type',
    { [probe]: "export const typeFault: number = 'wrong';\n" },
    ['exec', 'vp', 'check'],
    /TS2322/u,
    ['check'],
  );
  for (const [id, source, rule] of [
    [
      'lint-floating-void',
      'export const task = (): Promise<void> => Promise.resolve();\nvoid task();\n',
      /no-floating-promises/u,
    ],
    [
      'lint-misused-promise',
      'export const callback: () => void = async () => {};\n',
      /no-misused-promises/u,
    ],
    [
      'lint-exhaustiveness',
      "export function choose(mode: 'first' | 'second'): void {\n  switch (mode) {\n    case 'first': break;\n  }\n}\n",
      /switch-exhaustiveness-check/u,
    ],
  ] as const)
    await fault(id, { [probe]: source }, ['exec', 'vp', 'lint', '--type-aware', probe], rule, [
      'check',
    ]);
  for (const file of ['tools/fault-secret.ts', 'packages/contracts/fault-secret.config.ts']) {
    if (!existsSync(path.dirname(path.join(root, file)))) continue;
    await fault(
      `secret-${path.basename(path.dirname(file))}`,
      { [file]: `// ${['ghp', '_', 'a'.repeat(24)].join('')}\n` },
      ['exec', 'node', 'tools/quality/structure.ts'],
      /secret material detected/u,
      ['check'],
    );
  }
  await fault(
    'unit-focused',
    {
      [testProbe]: "import {it} from 'vitest';\nit.only('injected focused case',()=>{});\n",
    },
    ['test:tools', '--', testProbe],
    /only.*(?:not allowed|not permitted)|allowOnly|Unexpected.*only/iu,
    ['test:tools', '--', testProbe],
  );
  await fault(
    'unit',
    {
      [testProbe]:
        "import { it, expect } from 'vitest';\nit('injected fault', () => { expect(1).toBe(2); });\n",
    },
    ['test:tools', '--', testProbe],
    /expected 1 to be 2/u,
    ['test:tools', '--', testProbe],
  );
  await fault(
    'unit-zero',
    { [testProbe]: 'export const cases = 0;\n' },
    ['test:tools', '--', testProbe],
    /No test|No tests|No test suite/u,
    ['test:tools', '--', testProbe],
  );
  await fault(
    'unit-skipped',
    { [testProbe]: "import { it } from 'vitest';\nit.skip('skipped fault', () => {});\n" },
    ['test:tools', '--', testProbe],
    /must execute cases without failed, skipped or todo/u,
    ['test:tools', '--', testProbe],
  );
  await fault(
    'unit-timeout',
    {
      [testProbe]:
        "import { it } from 'vitest';\nit('injected timeout', async () => { await new Promise<void>(() => {}); }, 20);\n",
    },
    ['test:tools', '--', testProbe],
    /timed out|Timeout/u,
    ['test:tools', '--', testProbe],
  );
  await pnpm(['test:tools'], { cwd: root, env: environment, timeout: 30 * 60000 });
  const packages = workspacePackages(root);
  const library = packages.find((pkg) => pkg.runtime === 'library');
  if (!library) throw new Error('Boundary rehearsal requires a shared library');
  await fault(
    'boundary',
    {
      [`${library.directory}/src/boundary-fault.ts`]:
        "import { readFileSync } from 'node:fs';\nexport const boundaryFault = readFileSync;\n",
    },
    ['exec', 'node', 'tools/quality/structure.ts'],
    /runtime boundary violation/u,
    ['check'],
  );
  const contracts = packages.find((pkg) => path.basename(pkg.directory) === 'contracts');
  if (contracts) {
    const contractProbe = `${contracts.directory}/src/failure-probe.ts`;
    await fault(
      'result-discard',
      {
        [contractProbe]:
          "import { captureSync } from './result.ts';\nvoid captureSync(() => 1, 'unexpected_failure');\n",
      },
      ['exec', 'node', 'tools/quality/structure.ts'],
      /Result is discarded/u,
      ['check'],
    );
    await fault(
      'telemetry-owner',
      {
        [contractProbe]:
          "import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';\nexport const sdk = BasicTracerProvider;\n",
      },
      ['exec', 'node', 'tools/quality/structure.ts'],
      /OTel SDK and logger/u,
      ['check'],
    );
    const generated = `${contracts.directory}/src/errors.generated.ts`;
    await fault(
      'error-catalog-drift',
      { [generated]: readFileSync(path.join(root, generated), 'utf8') + '// injected drift\n' },
      ['check'],
      /error catalog drift/u,
      ['check'],
    );
  }
  if (contracts)
    await fault(
      'contract',
      {
        [`${contracts.directory}/src/fault.test.ts`]:
          "import { expect, it } from 'vitest';\nimport { noteInput } from './index.ts';\nit('rejects a broken contract expectation', () => { expect(noteInput.safeParse({text:'valid'}).success).toBe(false); });\n",
      },
      ['--filter', contracts.name, 'test'],
      /expected true to be false/u,
      ['--filter', contracts.name, 'test'],
    );
  const worker = packages.find(
    (pkg) => pkg.runtime === 'worker' && existsSync(path.join(root, pkg.directory, 'src/notes.ts')),
  );
  if (worker) {
    const runtime = ['--filter', worker.name, 'test:runtime'];
    const notes = `${worker.directory}/src/notes.ts`;
    const source = readFileSync(path.join(root, notes), 'utf8');
    assert.ok(
      source.includes('json(note, 201)'),
      'Fresh sample runtime fault injection must match the tested behavior',
    );
    await fault(
      'worker-behavior',
      { [notes]: source.replace('json(note, 201)', 'json(note, 202)') },
      runtime,
      /expected 202 to be 201/u,
      runtime,
    );
    const runtimeTests = walk(path.join(root, worker.directory, 'test')).filter(
      (filename) => filename === 'runtime.test.ts' || filename.endsWith('.runtime.test.ts'),
    );
    await fault(
      'worker-zero',
      Object.fromEntries(
        runtimeTests.map((filename) => [
          `${worker.directory}/test/${filename}`,
          'export const cases = 0;\n',
        ]),
      ),
      runtime,
      /No test|No tests|No test suite/u,
      runtime,
    );
    const remoteEnv = {
      CLOUDFLARE_ACCOUNT_ID: '',
      CLOUDFLARE_API_TOKEN: '',
      D1_DATABASE_ID: '',
      KV_NAMESPACE_ID: '',
      R2_BUCKET_NAME: '',
    };
    await fault(
      'deploy-quality',
      { [probe]: 'debugger;\n' },
      ['deploy:preflight', '--', '--target', worker.name, '--environment', 'local'],
      /no-debugger/u,
      ['check'],
      remoteEnv,
    );
    await fault(
      'deploy-environment',
      {},
      ['deploy:preflight', '--', '--target', worker.name, '--environment', 'unknown'],
      /Explicit --environment/u,
      ['deploy:preflight', '--', '--target', worker.name, '--environment', 'local'],
      remoteEnv,
    );
    await fault(
      'deploy-settings',
      {},
      ['deploy:preflight', '--', '--target', worker.name, '--environment', 'dev'],
      /CLOUDFLARE_ACCOUNT_ID is missing|D1_DATABASE_ID is required|KV_NAMESPACE_ID is required|R2_BUCKET_NAME is required/u,
      ['deploy', '--', '--target', worker.name, '--environment', 'local', '--dry-run'],
      remoteEnv,
    );
    if (worker.scripts['db:migrate']) {
      await fault(
        'dev-preflight-to-local-d1',
        {},
        ['deploy:preflight', '--', '--target', worker.name, '--environment', 'dev'],
        /CLOUDFLARE_ACCOUNT_ID is missing/u,
        runtime,
        {
          ...remoteEnv,
          D1_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
          KV_NAMESPACE_ID: '00000000000000000000000000000001',
          R2_BUCKET_NAME: 'configuration-only-fixture',
        },
      );
      await fault(
        'migration',
        { [`${worker.directory}/migrations/0002_fault.sql`]: 'THIS IS NOT SQL;\n' },
        ['--filter', worker.name, 'db:migrate'],
        /syntax error|SQLITE_ERROR/u,
        ['--filter', worker.name, 'db:migrate'],
      );
    }
  }
  const web = packages.find((pkg) => pkg.scripts['test:e2e']);
  if (web) {
    const route = `${web.directory}/src/routes/__root.tsx`;
    const original = readFileSync(path.join(root, route), 'utf8');
    const missingDescription = original.replace(/\{\s*name:\s*'description',[^}]+\},?/u, '');
    assert.notEqual(
      missingDescription,
      original,
      'The Web fault needs an actual meta-description to remove',
    );
    await fault(
      'lighthouse-score',
      { [route]: missingDescription },
      ['--filter', web.name, 'test:lighthouse'],
      /Lighthouse requires every category to score 100:.*seo/u,
      ['--filter', web.name, 'test:lighthouse'],
    );
    const browser = ['--filter', web.name, 'test:e2e'];
    const file = `${web.directory}/test/browser/fault.spec.ts`;
    await fault(
      'browser-behavior',
      {
        [file]:
          "import { test, expect } from '@playwright/test';\ntest('injected browser fault', () => { expect(true).toBe(false); });\n",
      },
      [...browser, '--', '--grep', 'injected browser fault'],
      /Expected: false/u,
      browser,
    );
    await fault(
      'browser-focused',
      {
        [file]:
          "import {test} from '@playwright/test';\ntest.only('injected focused browser',()=>{});\n",
      },
      browser,
      /forbid-only|forbidOnly|focused test/iu,
      browser,
    );
    await fault(
      'browser-zero',
      {},
      [...browser, '--', '--grep', 'zero-cases-no-match'],
      /No tests found/u,
      browser,
    );
    await fault(
      'browser-skipped',
      {
        [file]:
          "import { test } from '@playwright/test';\ntest.skip('injected browser skip', () => {});\n",
      },
      [...browser, '--', '--grep', 'injected browser skip'],
      /must execute cases without failed, skipped or flaky/u,
      browser,
    );
    await fault(
      'browser-timeout',
      {
        [file]:
          "import { test } from '@playwright/test';\ntest('injected browser timeout', async () => { await new Promise<void>(() => {}); });\n",
      },
      [...browser, '--', '--grep', 'injected browser timeout', '--timeout', '50'],
      /Test timeout of 50ms exceeded/u,
      browser,
    );
    const css = `${web.directory}/src/styles.css`;
    await fault(
      'visual-regression',
      {
        [css]: `${readFileSync(path.join(root, css), 'utf8')}\nsection { border: 20px solid magenta; }\n`,
      },
      [...browser, '--', '--grep', 'reviewed visual baselines'],
      /pixels.*different|Screenshot comparison failed|image sizes do not match/iu,
      browser,
    );
  }
  const desktop = packages.find((pkg) => pkg.runtime === 'desktop');
  if (desktop) {
    const rust = `${desktop.directory}/src-tauri/src/main.rs`;
    const source = readFileSync(path.join(root, rust), 'utf8');
    const telemetry = `${desktop.directory}/src-tauri/src/telemetry.rs`;
    const telemetrySource = readFileSync(path.join(root, telemetry), 'utf8');
    const command = ['--filter', desktop.name, 'test:rust'];
    await fault(
      'rust-behavior',
      {
        [rust]: source.replace(
          'assert_eq!(note.text, "note");',
          'assert_eq!(note.text, "broken");',
        ),
      },
      command,
      /assertion.*failed|left.*right/su,
      command,
    );
    await fault(
      'rust-zero',
      {
        [rust]: source.slice(0, source.indexOf('#[cfg(test)]')),
        [telemetry]: telemetrySource.slice(0, telemetrySource.indexOf('#[cfg(test)]')),
      },
      command,
      /Required Rust tests must execute cases/u,
      command,
    );
    await fault(
      'rust-ignored',
      { [rust]: source.replaceAll('#[test]', '#[test]\n    #[ignore]') },
      command,
      /Required Rust tests must execute cases/u,
      command,
    );
    await fault(
      'rust-timeout',
      {
        [rust]: source.replace(
          'assert_eq!(note.text, "note");',
          'std::thread::park();\n        assert_eq!(note.text, "note");',
        ),
      },
      command,
      /cargo test --locked: timeout/u,
      command,
      { STARTER_TEST_TIMEOUT_MS: '10000' },
    );
    const file = `${desktop.directory}/test/native.e2e.ts`;
    const native = ['--filter', desktop.name, 'test:native'];
    await fault(
      'native-behavior',
      {
        [file]:
          "import { browser, expect } from '@wdio/globals';\ndescribe('native fault', () => { it('observes a broken native expectation', async () => { await expect(browser.$('h1')).toHaveText('Broken heading'); }); });\n",
      },
      native,
      /Broken heading/u,
      native,
    );
    await fault(
      'native-focused',
      {
        [file]: "describe('native focus',()=>{ it.only('required case',()=>{}); });\n",
      },
      native,
      /forbid-only|forbidOnly|exclusive tests|\.only.*forbidden/iu,
      native,
    );
    await fault(
      'native-zero',
      { [file]: 'export const cases = 0;\n' },
      native,
      /Required native tests collected zero cases/u,
      native,
    );
    await fault(
      'native-skipped',
      { [file]: "describe('native skip', () => { it.skip('required case', () => {}); });\n" },
      native,
      /Required native tests.*(?:zero|skipped)/u,
      native,
    );
    await fault(
      'native-timeout',
      {
        [file]:
          "describe('native timeout', () => { it('required case', function () { this.timeout(50); return new Promise<void>(() => {}); }); });\n",
      },
      native,
      /Timeout of 50ms exceeded/iu,
      native,
    );
  }
  assert.deepEqual(
    reports.map((entry) => entry.id).toSorted(),
    faultCheckIds(workspacePackages(root)).toSorted(),
    'Every required isolated fault must execute',
  );
  assert.equal(contentId(root), before, 'Fault rehearsal must restore its source input');
  await pnpm(['check'], { cwd: root, env: environment });
  writeFileSync(
    path.join(root, 'artifacts/faults.json'),
    `${JSON.stringify({ schema: 1, baselineDifferences: inputBaseline, status: 'passed', configuration: (JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as { options: unknown }).options, workspace: workspacePackages(root), origin, contentId: before, os: process.platform, reports }, null, 2)}\n`,
  );
}
if (process.argv[1]?.endsWith(`${path.sep}faults.ts`)) await faultRehearsal(process.cwd());
