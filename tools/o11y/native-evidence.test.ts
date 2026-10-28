import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeEvidence } from './native-evidence.ts';

it('rejects stale OS/source/scenario evidence and absent signal correlation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-evidence-'));
  try {
    const expected = {
      sha: 'a'.repeat(40),
      contentId: 'b'.repeat(64),
      os: 'linux',
      scenario: 'save',
    };
    const traceId = '1'.repeat(32),
      spanId = '2'.repeat(16),
      diagnosticId = '3'.repeat(32),
      runId = 'native-fixture';
    const filename = path.join(root, 'verified.json');
    mkdirSync(path.join(root, 'telemetry'));
    const metadata = { ...expected, runId, telemetry: { traces: { records: 1 } } };
    const valid = JSON.stringify(metadata);
    writeFileSync(filename, valid);
    writeFileSync(
      path.join(root, 'telemetry/native.traces.jsonl'),
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: 'test.run.id', value: { stringValue: runId } },
                { key: 'service.version', value: { stringValue: expected.sha } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId,
                    startTimeUnixNano: '1791698400000000000',
                    attributes: [
                      { key: 'app.diagnostic.id', value: { stringValue: diagnosticId } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }) + '\n',
    );
    for (const signal of ['logs', 'metrics'])
      writeFileSync(
        path.join(root, `telemetry/native.${signal}.jsonl`),
        JSON.stringify({ runId, traceId, spanId, diagnosticId }) + '\n',
      );
    expect(nativeEvidence(filename, expected).diagnosticId).toBe(diagnosticId);
    for (const changed of [
      { sha: 'c'.repeat(40) },
      { contentId: 'd'.repeat(64) },
      { os: 'darwin' },
      { scenario: 'error' },
    ]) {
      writeFileSync(filename, JSON.stringify({ ...metadata, ...changed }));
      expect(() => nativeEvidence(filename, expected)).toThrow(/does not match/u);
    }
    writeFileSync(filename, valid);
    const logs = path.join(root, 'telemetry/native.logs.jsonl');
    const original = readFileSync(logs);
    writeFileSync(logs, JSON.stringify({ runId, traceId }) + '\n');
    expect(() => nativeEvidence(filename, expected)).toThrow(/do not correlate/u);
    writeFileSync(logs, original);
    writeFileSync(path.join(root, 'telemetry/native.metrics.jsonl'), '');
    expect(() => nativeEvidence(filename, expected)).toThrow(/nonempty/u);
  } finally {
    rmSync(root, { recursive: true });
  }
});
