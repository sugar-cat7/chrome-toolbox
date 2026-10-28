import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { status, state, query, root } from './local.ts';
import { nativeEvidence } from './native-evidence.ts';
import { investigation, investigationTools } from './policy.ts';
import { ClickHouseMcp } from './mcp-client.ts';
import { workspacePackages } from '../quality/graph.ts';
import { Servers } from '../dev-environment/servers.ts';
import { walk } from '../generators/files.ts';
import { verificationIdentity } from './identity.ts';
import { contentId } from '../quality/gate.ts';
import { baselineDifferences } from '../generators/baseline.ts';
import { ownHeadSha } from '../quality/checkout.ts';
import { observabilityCheck } from '../quality/definitions.ts';
import { spawnOwned, stopTree } from '../process.ts';

// Keep optional runtime checks usable after applications/shared sample libraries are removed.
// This is the exercised driver surface, not a second error catalog or sample DTO.
type DriverResult = { ok: true; value: unknown } | { ok: false; error: unknown };
type DriverTelemetry = {
  start(name: string): {
    traceparent: string;
    traceId: string;
    spanId: string;
    finish(result: DriverResult): void;
  };
  flush(): Promise<DriverResult>;
  shutdown(): Promise<void>;
};
type DriverContracts = {
  decodePublicError(
    value: unknown,
  ): { ok: true; value: { diagnosticId: string } } | { ok: false; error: unknown };
  failure(code: string): { diagnosticId: string };
  Ok(value: unknown): DriverResult;
  Err(error: unknown): DriverResult;
};
const startedAt = new Date().toISOString();
const runId = `verify-${randomUUID()}`;
const evidence: Record<string, unknown> = {
  schema: 1,
  check: observabilityCheck.id,
  requirements: observabilityCheck.requirements,
  os: process.platform,
  sha: null,
  contentId: null,
  runId,
  startedAt,
  health: null,
  native: 'NOT RUN: no native artifacts supplied',
  result: 'failed',
};
const failuresDuringVerification: unknown[] = [];
let phase = 'input';
let ownedServers: Servers | undefined;
let ownedTelemetry: DriverTelemetry | undefined;
let ownedOfficial: ClickHouseMcp | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  evidence.contentId = contentId(root);
  const version = verificationIdentity(root);
  evidence.sha = version;
  evidence.sourceCheckout = ownHeadSha(root) !== null;
  evidence.baselineDifferences = baselineDifferences(root);
  if (!evidence.sourceCheckout)
    assert.equal(
      (evidence.baselineDifferences as string[]).length,
      0,
      'Generated observability input contains user changes',
    );
  evidence.origin =
    (JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as { origin?: unknown })
      .origin ?? null;
  phase = 'readiness';
  const health = await status();
  evidence.health = health;
  if (!health.collectable || !health.queryReady) {
    evidence.result = 'not_run';
    throw new Error(
      'NOT RUN: collection and read-only query readiness are both required; run o11y:up',
    );
  }
  assert(health.endpoint);
  phase = 'startup';
  const local = state();
  const packages = workspacePackages(root);
  Object.assign(process.env, {
    STARTER_OTEL_ENDPOINT: health.endpoint,
    STARTER_OTEL_RUN_ID: runId,
    STARTER_OTEL_VERSION: version,
    VITE_OTEL_ENDPOINT: health.endpoint,
    VITE_OTEL_RUN_ID: runId,
    VITE_OTEL_VERSION: version,
  });
  const servers = (ownedServers = new Servers(
    root,
    path.join(root, '.state/o11y/rehearsal', runId),
  ));
  const sdk = (await import(
    pathToFileURL(path.join(root, 'packages/observability/src/index.ts')).href
  )) as { createTelemetry(config: Record<string, string>): DriverTelemetry };
  const contracts = (await import(
    pathToFileURL(path.join(root, 'packages/contracts/src/index.ts')).href
  )) as DriverContracts;
  const telemetry = (ownedTelemetry = sdk.createTelemetry({
    service: 'verification-driver',
    instance: runId,
    runId,
    version,
    endpoint: health.endpoint,
  }));
  const official = (ownedOfficial = new ClickHouseMcp());
  phase = 'verification';
  const worker =
    packages.find((pkg) => pkg.runtime === 'worker' && pkg.scripts['test:e2e']) ??
    packages.find((pkg) => pkg.runtime === 'worker');
  const origin = worker ? await servers.workers(worker.name) : undefined;
  const upstream = telemetry.start('notes.add');
  let diagnosticId: string;
  if (worker) {
    assert(origin);
    const invalid = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { traceparent: upstream.traceparent },
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('x-telemetry-state'), 'accepted');
    const body = (await invalid.json()) as { error: unknown };
    const decoded = contracts.decodePublicError(body.error);
    assert(decoded.ok);
    diagnosticId = decoded.value.diagnosticId;
    assert.equal(invalid.headers.get('x-diagnostic-id'), diagnosticId);
    upstream.finish(contracts.Err(decoded.value));
    const repairOperation = telemetry.start('notes.add');
    const repaired = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { traceparent: repairOperation.traceparent },
      body: JSON.stringify({ text: 'PRIVATE-NOTE-DO-NOT-EXPORT' }),
    });
    assert.equal(repaired.status, 201);
    const note: unknown = await repaired.json();
    assert(note && typeof note === 'object' && 'id' in note && typeof note.id === 'string');
    assert.match(note.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    repairOperation.finish(contracts.Ok(note));
    assert.equal((await fetch(`${origin}/api/notes/${note.id}`, { method: 'DELETE' })).status, 204);
    for (const feature of ['kv', 'r2']) {
      const response: Response = await fetch(`${origin}/extensions/${feature}`, {
        method: 'POST',
        body: JSON.stringify({ key: 'o11y-rehearsal', value: 'PRIVATE-BINDING-DO-NOT-EXPORT' }),
      });
      await response.arrayBuffer();
      assert([200, 404].includes(response.status));
      const stored: Response = await fetch(`${origin}/extensions/${feature}?key=o11y-rehearsal`);
      assert.equal(stored.status, response.status);
      await stored.arrayBuffer();
    }
    evidence.http = {
      package: worker.name,
      invalidStatus: 400,
      repairedStatus: 201,
      diagnosticId,
      failedTraceId: upstream.traceId,
      repairedTraceId: repairOperation.traceId,
    };
    if (worker.scripts['test:e2e']) {
      const load = createRequire(path.join(root, worker.directory, 'package.json'));
      const playwright = load('@playwright/test') as {
        chromium: {
          launch(options: { headless: boolean }): Promise<{
            close(): Promise<void>;
            newPage(): Promise<{
              goto(url: string): Promise<unknown>;
              getByRole(
                role: string,
                options?: { name: string; exact: boolean },
              ): {
                waitFor(options?: { state: string }): Promise<void>;
                fill(text: string): Promise<void>;
                click(): Promise<void>;
              };
            }>;
          }>;
        };
      };
      const launched = await playwright.chromium.launch({ headless: true });
      browser = launched;
      const page = await launched.newPage();
      await page.goto(origin);
      await page.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
      await page.getByRole('textbox').fill('PRIVATE-BROWSER-DO-NOT-EXPORT');
      await page.getByRole('button', { name: 'Add note', exact: true }).click();
      await page
        .getByRole('button', { name: 'Delete PRIVATE-BROWSER-DO-NOT-EXPORT', exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: 'Delete PRIVATE-BROWSER-DO-NOT-EXPORT', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Delete PRIVATE-BROWSER-DO-NOT-EXPORT', exact: true })
        .waitFor({ state: 'detached' });
      evidence.browser = { actualChromium: true, crud: true };
    }
  } else {
    const problem = contracts.failure('input_invalid');
    diagnosticId = problem.diagnosticId;
    upstream.finish(contracts.Err(problem));
    const repaired = telemetry.start('notes.add');
    repaired.finish(contracts.Ok(undefined));
    evidence.http = 'not_required: selected configuration has no Worker';
  }
  assert((await telemetry.flush()).ok);
  const window = { runId, start: startedAt, end: new Date(Date.now() + 60_000).toISOString() };
  const failureQuery = investigation('investigate_failure', { ...window, diagnosticId });
  let failures: unknown[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    failures = await query(failureQuery.query, failureQuery.params);
    if (failures.length) break;
    await pause(250);
  }
  assert(failures.length, 'Failure was accepted by OTLP but did not reach ClickHouse');
  const traceQuery = investigation('trace_detail', { ...window, traceId: upstream.traceId });
  let traces = (await query(traceQuery.query, traceQuery.params)) as {
    SpanId: string;
    ParentSpanId: string;
    StatusCode: string;
    ServiceName: string;
  }[];
  for (
    let attempt = 0;
    attempt < 40 &&
    !traces.some((row) => row.SpanId === upstream.spanId && row.StatusCode === 'Error');
    attempt++
  ) {
    await pause(250);
    traces = (await query(traceQuery.query, traceQuery.params)) as typeof traces;
  }
  assert(traces.some((row) => row.SpanId === upstream.spanId && row.StatusCode === 'Error'));
  if (worker)
    assert(
      traces.some((row) => row.ParentSpanId === upstream.spanId),
      'HTTP parent did not propagate',
    );
  if (worker) {
    const repairedTraceId = (evidence.http as { repairedTraceId: string }).repairedTraceId;
    const repairedQuery = investigation('trace_detail', { ...window, traceId: repairedTraceId });
    let repairedRows: unknown[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      repairedRows = await query(repairedQuery.query, repairedQuery.params);
      if (repairedRows.length >= 2) break;
      await pause(250);
    }
    assert(
      repairedRows.length >= 2 && !JSON.stringify(repairedRows).includes('"StatusCode":"Error"'),
      'Repaired fixture has no correlated successful HTTP trace',
    );
    evidence.repairedTraceSpans = repairedRows.length;
  }
  const metricQuery = investigation('operation_metrics', window);
  const metrics = await query(metricQuery.query, metricQuery.params);
  assert(metrics.length, 'Histogram metrics did not reach ClickHouse');
  const privateData = await query(
    "SELECT Body, LogAttributes FROM otel.otel_logs WHERE ResourceAttributes['test.run.id']={run_id:String} LIMIT 100",
    { run_id: runId },
  );
  assert(
    !JSON.stringify(privateData).includes('PRIVATE-'),
    'A private application payload reached telemetry',
  );
  await assert.rejects(
    query('CREATE TABLE otel.forbidden_rehearsal (id UInt8) ENGINE=Memory'),
    /rejected/u,
  );
  await official.initialize();
  const officialResult = (await official.request('tools/call', {
    name: 'run_query',
    arguments: failureQuery,
  })) as { isError?: boolean; content?: { text?: string }[] };
  assert(!officialResult.isError, 'Official MCP rejected the bounded query');
  assert(
    JSON.stringify(officialResult).includes(diagnosticId),
    'Official MCP lost the diagnostic lookup',
  );
  const ownedMcp = spawnOwned(process.execPath, ['tools/o11y/mcp.ts'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  try {
    ownedMcp.stderr?.on('data', () => {});
    const lines = createInterface({ input: ownedMcp.stdout! })[Symbol.asyncIterator]();
    const call = async (id: number, method: string, params: unknown) => {
      ownedMcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const line = await Promise.race([
        lines.next(),
        pause(30_000, undefined, { ref: false }).then(() => {
          throw new Error('Bounded MCP rehearsal timed out');
        }),
      ]);
      assert(!line.done);
      return JSON.parse(line.value) as { result?: unknown; error?: unknown };
    };
    assert(
      (
        await call(1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'verification', version: '1' },
        })
      ).result,
    );
    const listed = await call(2, 'tools/list', {});
    assert.deepEqual(
      (listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      investigationTools.map((tool) => tool.name),
    );
    const bounded = await call(3, 'tools/call', {
      name: 'investigate_failure',
      arguments: { ...window, diagnosticId },
    });
    assert(
      !bounded.error &&
        !(bounded.result as { isError?: boolean })?.isError &&
        JSON.stringify(bounded.result).includes(diagnosticId),
      'Bounded MCP did not return the actual failure',
    );
    for (const [id, name, args, expected] of [
      [6, 'trace_detail', { ...window, traceId: upstream.traceId }, upstream.traceId],
      [7, 'operation_metrics', window, 'application.operation.duration'],
    ] as const) {
      const result = await call(id, 'tools/call', { name, arguments: args });
      assert(
        !result.error &&
          !(result.result as { isError?: boolean })?.isError &&
          JSON.stringify(result.result).includes(expected),
        `Bounded ${name} did not return actual correlated rows`,
      );
    }
    assert(
      (await call(4, 'tools/call', { name: 'run_query', arguments: { query: 'SELECT 1' } })).error,
    );
    assert(
      (
        await call(5, 'tools/call', {
          name: 'operation_metrics',
          arguments: { ...window, query: 'SELECT 1' },
        })
      ).error,
    );
  } finally {
    await stopTree(ownedMcp);
  }
  const nativeIndex = process.argv.indexOf('--native-artifacts');
  if (nativeIndex !== -1) {
    const artifacts = path.resolve(process.argv[nativeIndex + 1] ?? '');
    const copied: string[] = [];
    for (const os of ['linux', 'darwin', 'win32']) {
      const reports = walk(artifacts).filter(
        (file) => file.includes(`native-${os}/`) && file.endsWith('/verified.json'),
      );
      assert.equal(reports.length, 3, `Expected exactly save/cancel/error evidence for ${os}`);
      const sourceIndex = process.argv.indexOf('--native-source-evidence');
      const sourceEvidence =
        sourceIndex === -1
          ? { sha: version, contentId: contentId(root) }
          : (JSON.parse(
              readFileSync(path.resolve(process.argv[sourceIndex + 1] ?? ''), 'utf8'),
            ) as { sha: string; contentId: string });
      assert.equal(sourceEvidence.sha, version, 'Native source evidence has a stale SHA');
      evidence.nativeSource = sourceEvidence;
      for (const scenario of ['save', 'cancel', 'error']) {
        const report = reports.find((file) => path.basename(path.dirname(file)) === scenario);
        assert(report, `Missing ${os}/${scenario}`);
        const native = nativeEvidence(path.join(artifacts, report), {
          ...sourceEvidence,
          os,
          scenario,
        });
        const verified = native.verified;
        const destination = path.join(
          local.directory,
          'native',
          runId,
          os,
          path.basename(path.dirname(report)),
        );
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        for (const signal of ['traces', 'logs', 'metrics']) {
          const source = path.join(
            artifacts,
            path.dirname(report),
            'telemetry',
            `native.${signal}.jsonl`,
          );
          assert(readFileSync(source).length > 0);
          copyFileSync(source, path.join(destination, `native.${signal}.jsonl`));
        }
        const nativeWindow = {
          runId: verified.runId,
          start: startedAt,
          end: new Date(Date.now() + 60_000).toISOString(),
        };
        nativeWindow.start = new Date(native.start - 1000).toISOString();
        nativeWindow.end = new Date(native.start + 60 * 60_000 - 1000).toISOString();
        const q = investigation('operation_metrics', nativeWindow);
        let rows: unknown[] = [];
        for (let attempt = 0; attempt < 40; attempt++) {
          rows = await query(q.query, q.params);
          if (JSON.stringify(rows).includes(native.traceId)) break;
          await pause(250);
        }
        assert(rows.length, `Actual ${os} metrics did not reach ClickHouse`);
        const nativeLogs = investigation('investigate_failure', {
          ...nativeWindow,
          diagnosticId: native.diagnosticId,
        });
        const nativeTraces = investigation('trace_detail', {
          ...nativeWindow,
          traceId: native.traceId,
        });
        let collectedLogs: unknown[] = [],
          collectedTraces: unknown[] = [];
        for (let attempt = 0; attempt < 40; attempt++) {
          collectedLogs = await query(nativeLogs.query, nativeLogs.params);
          collectedTraces = await query(nativeTraces.query, nativeTraces.params);
          if (
            JSON.stringify(collectedLogs).includes(native.spanId) &&
            JSON.stringify(collectedTraces).includes(native.spanId)
          )
            break;
          await pause(250);
        }
        assert(
          JSON.stringify(collectedLogs).includes(native.spanId) &&
            JSON.stringify(collectedTraces).includes(native.spanId),
          `Actual ${os} failure logs/traces did not reach ClickHouse`,
        );
        assert(
          JSON.stringify(rows).includes(native.traceId),
          `Actual ${os} histogram exemplar lost correlation`,
        );
        copied.push(`${os}/${path.basename(path.dirname(report))}`);
      }
    }
    evidence.native = { actualOperatingSystems: ['linux', 'darwin', 'win32'], collected: copied };
  }
  assert.equal(
    contentId(root),
    evidence.contentId,
    'Observability input changed during verification',
  );
  if (!evidence.sourceCheckout)
    assert.deepEqual(baselineDifferences(root), [], 'Generated observability baseline changed');
  evidence.result = 'passed';
  evidence.counts = {
    failureLogs: failures.length,
    traceSpans: traces.length,
    histograms: metrics.length,
  };
  evidence.mcp = {
    official: 'mcp-clickhouse 0.7.0',
    protocol: '2025-11-25',
    boundedTools: 3,
    arbitraryQueryRejected: true,
    readOnlyWriteRejected: true,
  };
} catch (error) {
  if (evidence.result !== 'not_run') evidence.result = 'failed';
  evidence.failure = `Observability ${phase} failed`;
  evidence.phase = phase;
  failuresDuringVerification.push(error);
} finally {
  const cleanup = await Promise.allSettled([
    browser?.close(),
    ownedServers?.stop(),
    ownedTelemetry?.shutdown(),
    ownedOfficial?.stop(),
  ]);
  const failedCleanup = cleanup.filter((result) => result.status === 'rejected');
  if (failedCleanup.length) {
    evidence.result = 'failed';
    evidence.failure = 'Owned observability cleanup failed';
    failuresDuringVerification.push(
      ...failedCleanup.map((result) => (result as PromiseRejectedResult).reason),
    );
  }
  mkdirSync(path.join(root, 'artifacts/o11y'), { recursive: true });
  writeFileSync(
    path.join(root, 'artifacts/o11y/verified.json'),
    JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2) + '\n',
  );
  console.log(JSON.stringify(evidence));
}
if (failuresDuringVerification.length)
  throw new AggregateError(failuresDuringVerification, 'Observability verification failed');
