import { describe, expect, it } from 'vitest';
import {
  createTelemetry,
  observeHttp,
  parseTraceparent,
  collectorEndpoint,
  rejectsOtlp,
} from './index.ts';
import { Ok, Err, failure, publicFailure } from '@starter/contracts';

it('checks W3C ingress, sampling and secure collector selection', () => {
  expect(parseTraceparent('00-1234567890abcdef1234567890abcdef-1234567890abcdef-00')).toMatchObject(
    { traceFlags: 0, isRemote: true },
  );
  expect(
    parseTraceparent('00-00000000000000000000000000000000-1234567890abcdef-01'),
  ).toBeUndefined();
  expect(
    parseTraceparent('01-1234567890abcdef1234567890abcdef-1234567890abcdef-01'),
  ).toBeUndefined();
  for (const address of [
    'http://remote.example',
    'https://user:secret@example.com',
    'https://example.com?secret=1',
  ])
    expect(collectorEndpoint(address).ok).toBe(false);
  expect(collectorEndpoint('http://127.0.0.1:4318').ok).toBe(true);
  expect(collectorEndpoint('https://telemetry.example').ok).toBe(true);
});
describe('portable OTel SDK and standard OTLP JSON', () => {
  it('correlates failures, filters private payloads, keeps IDs out of metric labels and exports all signals', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const telemetry = createTelemetry({
      service: 'sample',
      instance: 'test',
      endpoint: 'http://127.0.0.1:4318',
      send: async (url, init) => {
        sent.push({
          url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
          body: JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<
            string,
            unknown
          >,
        });
        return Response.json({});
      },
    });
    const parent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
    const operation = telemetry.start('notes.add', { traceparent: parent });
    const error = failure('input_invalid');
    operation.finish(Err(error));
    expect(await telemetry.flush()).toEqual(Ok(undefined));
    expect(sent.map((record) => record.url)).toEqual([
      'http://127.0.0.1:4318/v1/traces',
      'http://127.0.0.1:4318/v1/logs',
      'http://127.0.0.1:4318/v1/metrics',
    ]);
    const traces = JSON.stringify(sent[0]!.body);
    expect(traces).toContain('"parentSpanId":"1234567890abcdef"');
    expect(traces).toContain(error.diagnosticId);
    expect(traces).toContain('"status":{"code":2}');
    expect(JSON.stringify(sent)).not.toMatch(/authorization|cookie|notes text|stack|cause/u);
    const metrics = JSON.stringify(sent[2]!.body);
    expect(metrics).toContain('exemplars');
    expect(metrics).not.toContain('app.diagnostic.id');
    expect(metrics).not.toContain('app.request.id');
    await telemetry.shutdown();
  });
  it('does not claim export success for HTTP failure, malformed or partial OTLP acceptance', async () => {
    for (const reply of [
      new Response('bad', { status: 500 }),
      Response.json({ partialSuccess: { rejectedSpans: '1' } }),
      Response.json([]),
    ]) {
      const telemetry = createTelemetry({
        service: 'sample',
        instance: 'test',
        endpoint: 'http://127.0.0.1:4318',
        send: async () => reply,
      });
      telemetry.start('notes.list').finish(Ok([]));
      expect((await telemetry.flush()).ok).toBe(false);
      expect(telemetry.status()).toMatchObject({
        enabled: true,
        dropped: 1,
        lastExport: { ok: false },
      });
      await telemetry.shutdown();
    }
    expect(rejectsOtlp({ partialSuccess: { rejectedSpans: '0', errorMessage: '' } })).toBe(false);
    expect(rejectsOtlp({ partialSuccess: { rejectedSpans: '1' } })).toBe(true);
  });
  it('drains concurrent completion and reports a disabled sink separately', async () => {
    let sent = 0;
    const telemetry = createTelemetry({
      service: 'sample',
      instance: 'test',
      endpoint: 'http://127.0.0.1:4318',
      send: async () => {
        sent++;
        await Promise.resolve();
        return Response.json({});
      },
    });
    telemetry.start('notes.list').finish(Ok([]));
    const first = telemetry.flush();
    telemetry.start('notes.add').finish(Ok(undefined));
    const second = telemetry.flush();
    expect(await first).toEqual(Ok(undefined));
    expect(await second).toEqual(Ok(undefined));
    expect(sent).toBe(6);
    expect(telemetry.status().pending).toBe(0);
    await telemetry.shutdown();
    const disabled = createTelemetry({ service: 'sample', instance: 'test' });
    disabled.start('notes.list').finish(Ok([]));
    expect(disabled.status()).toMatchObject({ enabled: false, pending: 0 });
    await disabled.shutdown();
  });
});

it('normalizes forged public metadata and respects unsampled parents at the privacy owner', async () => {
  const sent: string[] = [];
  const telemetry = createTelemetry({
    service: 'sample',
    instance: 'test',
    endpoint: 'http://127.0.0.1:4318',
    send: async (_url, init) => {
      sent.push(typeof init?.body === 'string' ? init.body : '');
      return Response.json({});
    },
  });
  const invalid = telemetry.start('notes.add');
  invalid.finish(
    Err({
      ...publicFailure(failure('input_invalid')),
      failureClass: 'PRIVATE-NOTE-TEXT',
      diagnosticId: '/private/token=secret',
    }),
  );
  expect((await telemetry.flush()).ok).toBe(true);
  expect(sent.join('')).not.toContain('PRIVATE-NOTE-TEXT');
  expect(sent.join('')).not.toContain('/private/token=secret');
  expect(sent.join('')).toContain('response_invalid');
  const unsampled = telemetry.start('notes.list', {
    traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-00',
  });
  unsampled.finish(Ok(undefined));
  expect((await telemetry.flush()).ok).toBe(true);
  expect(sent).toHaveLength(3);
  await telemetry.shutdown();
});

it('preserves a validated public code instead of guessing between shared HTTP statuses', async () => {
  const sent: string[] = [];
  const problem = publicFailure(failure('request_json_invalid'));
  const response = await observeHttp(
    new Request('http://local.invalid/api'),
    {
      service: 'sample',
      instance: 'test',
      endpoint: 'http://127.0.0.1:4318',
      send: async (_url, init) => {
        sent.push(typeof init?.body === 'string' ? init.body : '');
        return Response.json({});
      },
    },
    async () =>
      Response.json(
        { error: problem },
        {
          status: 400,
          headers: { 'x-diagnostic-id': problem.diagnosticId, 'x-error-code': problem.code },
        },
      ),
  );
  expect(response.status).toBe(400);
  expect(sent.join('')).toContain('invalid_json');
  expect(sent.join('')).not.toContain('invalid_input');
  expect(sent.join('')).toContain(problem.diagnosticId);
});

it('preserves owned streaming and immutable platform responses without reconstructing them', async () => {
  const text = 'export const sample = "valid public JavaScript";'.repeat(100);
  const original = new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
    {
      headers: { 'content-type': 'application/javascript', 'content-encoding': 'gzip' },
    },
  );
  const annotated = await observeHttp(
    new Request('http://local.invalid/assets/app.js'),
    { service: 'sample', instance: 'test' },
    async () => original,
  );
  expect(annotated).toBe(original);
  expect(annotated.headers.get('x-telemetry-state')).toBe('disabled');
  expect(
    await new Response(annotated.body!.pipeThrough(new DecompressionStream('gzip'))).text(),
  ).toBe(text);
  const redirect = Response.redirect('http://local.invalid/next');
  const preserved = await observeHttp(
    new Request('http://local.invalid/redirect'),
    { service: 'sample', instance: 'test' },
    async () => redirect,
  );
  expect(preserved).toBe(redirect);
  expect(preserved.status).toBe(302);
  expect(preserved.headers.get('location')).toBe('http://local.invalid/next');
  expect(preserved.headers.get('traceparent')).toBeNull();
  expect(preserved.headers.get('x-telemetry-state')).toBeNull();
});
