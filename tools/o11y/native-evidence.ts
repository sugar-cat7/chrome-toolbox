import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function nativeEvidence(
  filename: string,
  expected: { sha: string; contentId: string; os: string; scenario: string },
) {
  const verified = JSON.parse(readFileSync(filename, 'utf8')) as {
    sha: string;
    contentId: string;
    os: string;
    scenario: string;
    runId: string;
    telemetry?: unknown;
  };
  for (const key of ['sha', 'contentId', 'os', 'scenario'] as const)
    assert.equal(verified[key], expected[key], `Native ${key} does not match the verified input`);
  assert(
    verified.telemetry && /^[a-zA-Z0-9._-]{1,128}$/u.test(verified.runId),
    'Missing actual native producer evidence',
  );
  const payloads = Object.fromEntries(
    ['traces', 'logs', 'metrics'].map((signal) => {
      const buffer = readFileSync(
        path.join(path.dirname(filename), 'telemetry', `native.${signal}.jsonl`),
      );
      assert(
        buffer.length > 0 && buffer.length <= 16 * 1024 * 1024,
        'Native payload must be nonempty and bounded',
      );
      return [
        signal,
        buffer
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown),
      ];
    }),
  ) as { traces: unknown[]; logs: unknown[]; metrics: unknown[] };
  type Attribute = { key: string; value: { stringValue: string } };
  type Span = {
    traceId: string;
    spanId: string;
    startTimeUnixNano: string;
    attributes: Attribute[];
  };
  type TracePayload = {
    resourceSpans: { resource: { attributes: Attribute[] }; scopeSpans: { spans: Span[] }[] }[];
  };
  const records = payloads.traces as TracePayload[];
  const spans = records.flatMap((payload) =>
    payload.resourceSpans.flatMap((resource) => {
      assert.equal(
        resource.resource.attributes.find((attr) => attr.key === 'test.run.id')?.value.stringValue,
        verified.runId,
      );
      assert.equal(
        resource.resource.attributes.find((attr) => attr.key === 'service.version')?.value
          .stringValue,
        verified.sha,
      );
      return resource.scopeSpans.flatMap((scope) => scope.spans);
    }),
  );
  const failed = spans.find((span) =>
    span.attributes.some((attr) => attr.key === 'app.diagnostic.id'),
  );
  assert(
    failed && /^[a-f0-9]{32}$/u.test(failed.traceId) && /^[a-f0-9]{16}$/u.test(failed.spanId),
    'Missing native failure trace',
  );
  const diagnosticId = failed.attributes.find((attr) => attr.key === 'app.diagnostic.id')!.value
    .stringValue;
  assert(/^[a-f0-9]{32}$/u.test(diagnosticId));
  for (const signal of ['logs', 'metrics'] as const) {
    const body = JSON.stringify(payloads[signal]);
    assert(
      body.includes(verified.runId) &&
        body.includes(failed.traceId) &&
        body.includes(failed.spanId),
      `Native ${signal} do not correlate with the failed span`,
    );
  }
  assert(
    JSON.stringify(payloads.logs).includes(diagnosticId),
    'Native logs lost the failure diagnostic ID',
  );
  const start = Number(BigInt(failed.startTimeUnixNano) / 1_000_000n);
  assert(Number.isFinite(start));
  return { verified, diagnosticId, traceId: failed.traceId, spanId: failed.spanId, start };
}
