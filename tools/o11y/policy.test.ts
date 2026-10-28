import { expect, it } from 'vitest';
import { investigation } from './policy.ts';
const window = { runId: 'test-run', start: '2026-10-11T00:00:00Z', end: '2026-10-11T00:01:00Z' };
it('builds fixed parameterized read-only queries with time/run/row bounds', () => {
  for (const name of ['investigate_failure', 'trace_detail', 'operation_metrics']) {
    const args = {
      ...window,
      ...(name === 'investigate_failure'
        ? { diagnosticId: 'a'.repeat(32) }
        : name === 'trace_detail'
          ? { traceId: 'b'.repeat(32) }
          : {}),
    };
    const selected = investigation(name, args);
    expect(selected.query).toMatch(/^SELECT /u);
    expect(selected.query).toContain('LIMIT 100');
    expect(selected.query).toContain('{run_id:String}');
    expect(selected.params.run_id).toBe('test-run');
  }
});
it.each([
  ['run_query', { query: 'DROP TABLE otel.otel_logs' }],
  ['operation_metrics', { ...window, query: 'SELECT * FROM url()' }],
  ['operation_metrics', { ...window, runId: "x'; DELETE" }],
  ['operation_metrics', { ...window, end: '2026-10-11T03:00:00Z' }],
  ['operation_metrics', { ...window, end: window.start }],
  ['operation_metrics', { ...window, start: '2026-02-30T00:00:00Z', end: '2026-02-30T00:01:00Z' }],
  ['trace_detail', { ...window, traceId: 'invalid' }],
  ['investigate_failure', { ...window, diagnosticId: 'private raw text' }],
])('refuses unsafe/unsupported request %s', (name, args) => {
  expect(() => investigation(name, args)).toThrow(
    /Unsupported|Invalid|Run and UTC|Investigation window/u,
  );
});
