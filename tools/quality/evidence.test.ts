import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { writeEvidenceAfterCleanup } from './evidence.ts';
import { acceptance } from './acceptance.ts';
import { hookPhases } from './definitions.ts';
import { faultRehearsal } from './faults.ts';

it('publishes success only after owned cleanup while preserving sibling data', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'starter-evidence-'));
  try {
    const owned = path.join(directory, 'owned');
    const sibling = path.join(directory, 'sibling.txt');
    const filename = path.join(directory, 'artifacts/result.json');
    mkdirSync(owned);
    writeFileSync(path.join(owned, 'data.txt'), 'temporary');
    writeFileSync(sibling, 'preserve');
    const report = { status: 'passed', phases: ['actual-work'] };
    writeEvidenceAfterCleanup(filename, report, () => {
      expect(existsSync(filename)).toBe(false);
      rmSync(owned, { recursive: true });
    });
    expect(existsSync(owned)).toBe(false);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual(report);
    expect(readFileSync(sibling, 'utf8')).toBe('preserve');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('replaces stale success with failed evidence and rethrows an actual cleanup refusal', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'starter-evidence-'));
  try {
    const owned = path.join(directory, 'owned');
    const filename = path.join(directory, 'hooks.json');
    mkdirSync(owned);
    writeFileSync(path.join(owned, 'data.txt'), 'temporary');
    const sha = 'a'.repeat(40);
    const report = {
      schema: 1,
      status: 'passed',
      sha,
      contentId: 'b'.repeat(64),
      os: 'linux',
      phases: hookPhases,
      baselineDifferences: [],
    };
    writeFileSync(filename, JSON.stringify(report));
    expect(
      acceptance(directory, sha).mechanisms.find((entry) => entry.id === 'hooks-linux')?.status,
    ).toBe('passed');
    let refusal: unknown;
    let propagated: unknown;
    try {
      writeEvidenceAfterCleanup(filename, report, () => {
        try {
          rmSync(owned, { recursive: false });
        } catch (error) {
          refusal = error;
          throw error;
        }
      });
    } catch (error) {
      propagated = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(propagated).toBe(refusal);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Evidence cleanup failed'),
    });
    expect(readFileSync(path.join(owned, 'data.txt'), 'utf8')).toBe('temporary');
    expect(
      acceptance(directory, sha).mechanisms.find((entry) => entry.id === 'hooks-linux')?.status,
    ).toBe('blocked');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('cleans up and replaces stale success when actual metadata reading fails', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'starter-evidence-metadata-'));
  try {
    const owned = path.join(directory, 'owned');
    const filename = path.join(directory, 'result.json');
    const metadata = path.join(directory, 'metadata.json');
    mkdirSync(owned);
    writeFileSync(path.join(owned, 'temporary.txt'), 'temporary');
    writeFileSync(filename, JSON.stringify({ status: 'passed' }));
    writeFileSync(metadata, '{invalid');
    let preparationFailure: unknown;
    let propagated: unknown;
    try {
      writeEvidenceAfterCleanup(
        filename,
        () => {
          try {
            return JSON.parse(readFileSync(metadata, 'utf8')) as { status: string };
          } catch (error) {
            preparationFailure = error;
            throw error;
          }
        },
        () => rmSync(owned, { recursive: true }),
      );
    } catch (error) {
      propagated = error;
    }
    expect(preparationFailure).toBeInstanceOf(SyntaxError);
    expect(propagated).toBe(preparationFailure);
    expect(existsSync(owned)).toBe(false);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Evidence preparation failed'),
    });
    expect(readFileSync(metadata, 'utf8')).toBe('{invalid');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('invalidates an earlier fault receipt when fixture preparation actually fails', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'starter-fault-early-failure-'));
  try {
    const filename = path.join(
      directory,
      'artifacts',
      `fault-rehearsal-${process.platform}`,
      'faults.json',
    );
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify({ status: 'passed', reports: ['previous-run'] }));
    const userFile = path.join(directory, 'user.txt');
    writeFileSync(userFile, 'preserve');
    const manifest = path.join(directory, 'packages/broken/package.json');
    mkdirSync(path.dirname(manifest), { recursive: true });
    writeFileSync(manifest, '{invalid');
    await expect(faultRehearsal(directory)).rejects.toThrow(SyntaxError);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toMatchObject({
      status: 'failed',
      reports: [],
      error: expect.any(String),
    });
    expect(readFileSync(userFile, 'utf8')).toBe('preserve');
    expect(readFileSync(manifest, 'utf8')).toBe('{invalid');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
