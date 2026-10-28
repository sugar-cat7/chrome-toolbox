import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureHandling } from './failure-handling.ts';

function inspect(
  source: string,
  boundaries: Record<string, string> = {},
  files: Record<string, string> = {},
  role?: string,
): string[] {
  const root = mkdtempSync(path.join(os.tmpdir(), 'result-contract-'));
  try {
    mkdirSync(path.join(root, 'packages/example/src'), { recursive: true });
    mkdirSync(path.join(root, 'tools/errors'), { recursive: true });
    writeFileSync(path.join(root, 'tools/errors/catalog.json'), '{}');
    writeFileSync(
      path.join(root, 'packages/example/package.json'),
      JSON.stringify({
        name: '@test/example',
        starter: { runtime: 'worker', resultBoundaries: boundaries, role },
      }),
    );
    writeFileSync(path.join(root, 'packages/example/src/index.ts'), source);
    for (const [file, body] of Object.entries(files))
      writeFileSync(path.join(root, 'packages/example/src', file), body);
    return failureHandling(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

describe('enforced Result and telemetry boundaries', () => {
  it.each([
    [
      'export async function save(): Promise<string> { return "unchecked"; }',
      'Async application ports',
    ],
    [
      'export async function save(): Promise<Result<string>> {throw new Error("raw");}',
      'Expected failures',
    ],
    ['try { save(); } catch {}', 'Normalize SDK rejection'],
    ['save().catch(()=>[]);', 'Promise rejection handling'],
    [
      'async function list():Promise<Result<Response>> {return await fetch("/api/notes").then(response=>Ok(response),()=>Ok(new Response("[]")));}',
      'Promise rejection handling',
    ],
    ['import {Err} from "@test/contracts"; Err({code:"private"});', 'Result is discarded'],
    ['const result=unknownValue as Result<string>;', 'type assertion'],
    ['import {BasicTracerProvider} from "@opentelemetry/sdk-trace-base";', 'OTel SDK'],
    ['console.log("private payload");', 'privacy-filtered'],
  ])('rejects an actual unsafe source: %s', (source, reason) => {
    expect(inspect(source).some((error) => error.includes(reason))).toBe(true);
    expect(
      inspect('export async function save(): Promise<Result<string>> { return Ok("handled"); }'),
    ).toEqual([]);
  });
  it('requires an exact live boundary and continues applying failure rules inside it', () => {
    const boundaries = {
      'src/index.ts:fetch': 'HTTP runtime ingress must return a platform Response.',
    };
    expect(
      inspect(
        'export async function fetch(): Promise<Response> {return new Response();}',
        boundaries,
      ),
    ).toEqual([]);
    expect(
      inspect(
        'export async function fetch(): Promise<Response> {throw new Error("raw");}',
        boundaries,
      ),
    ).toEqual([expect.stringContaining('Expected failures')]);
    expect(inspect('export const unrelated=1;', boundaries)).toEqual([
      expect.stringContaining('stale or unobserved'),
    ]);
  });
  it('handles alias imports and refuses ignored async Result calls', () => {
    expect(
      inspect(
        'import {capture as normalize} from "@test/contracts"; normalize(()=>Promise.resolve(1),"network_failed");',
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
    expect(
      inspect(
        'export async function persist():Promise<Result<void>> {return Ok(undefined);} async function run():Promise<Result<void>> {await persist();return Ok(undefined);}',
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
  });
  it('finds later declarations, imported Result ports and void-wrapped synchronous Results', () => {
    expect(
      inspect(
        'async function consume():Promise<Result<void>> {await persist();return Ok(undefined);} async function persist():Promise<Result<void>> {return Ok(undefined);}',
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
    expect(
      inspect(
        'import {persist as save} from "./port.ts"; async function consume():Promise<Result<void>> {await save();return Ok(undefined);}',
        {},
        {
          'port.ts':
            'export async function persist():Promise<Result<void>> {return Ok(undefined);}',
        },
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
    expect(
      inspect(
        'import {captureSync} from "@test/contracts"; void captureSync(()=>localStorage.clear(),"storage_failed");',
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
  });
  it('does not trust generated basenames or forged SDK owner roles', () => {
    expect(
      inspect('', {}, { 'errors.generated.ts': 'console.log("private");throw new Error("raw");' }),
    ).toHaveLength(2);
    expect(inspect('console.log("private");', {}, {}, 'observability')).toEqual([
      expect.stringContaining('only the shared observability'),
      expect.stringContaining('privacy-filtered'),
    ]);
  });
  it('handles later object methods and namespace-imported Result ports', () => {
    expect(
      inspect(
        'async function consume():Promise<Result<void>> {await port.persist();return Ok(undefined);} const port={async persist():Promise<Result<void>> {return Ok(undefined);}};',
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
    expect(
      inspect(
        'import * as store from "./port.ts"; async function consume():Promise<Result<void>> {await store.persist();return Ok(undefined);}',
        {},
        {
          'port.ts':
            'export async function persist():Promise<Result<void>> {return Ok(undefined);}',
        },
      ),
    ).toEqual([expect.stringContaining('Result is discarded')]);
  });
});
