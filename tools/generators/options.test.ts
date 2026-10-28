import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flags, projectOptions, selectedPackages, validateName } from './options.ts';
import { safeFile } from './safety.ts';

describe('generation inputs and containment', () => {
  it('defaults to a light web preset and never waits for interactive input', () => {
    expect(projectOptions({ name: 'new-project', scope: '@another' }).preset).toBe('web');
    expect(() => projectOptions({})).toThrow('--name and --scope');
  });
  it('has only selected apps and required shared packages', () => {
    expect(
      selectedPackages(projectOptions({ name: 'new-project', scope: '@another', preset: 'api' })),
    ).toEqual(['contracts', 'observability', 'api']);
    expect(
      selectedPackages(
        projectOptions({ name: 'new-project', scope: '@another', preset: 'desktop' }),
      ),
    ).toEqual(['contracts', 'observability', 'ui', 'desktop']);
  });
  it('makes the fullstack transport explicit and rejects impossible bindings', () => {
    expect(
      projectOptions({ name: 'project', scope: '@scope', preset: 'fullstack' }).features,
    ).toEqual(['services']);
    expect(() =>
      projectOptions({ name: 'project', scope: '@scope', preset: 'desktop', features: 'd1' }),
    ).toThrow('desktop-only');
  });
  it('rejects traversal, Windows paths and reserved names before writing', () => {
    for (const name of [
      '../escape',
      'C:/escape',
      '\\\\server\\share',
      'con',
      'foo/bar',
      'MixedCase',
      'bad.',
      'lpt9',
    ])
      expect(() => validateName(name)).toThrow('Name must');
    for (const relative of ['../escape', '/absolute', 'C:/escape', 'a/../../x', 'a\\..\\x', './x'])
      expect(() => safeFile(os.tmpdir(), relative)).toThrow('Unsafe');
  });
  it('does not write through a symlink or junction', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'generator-containment-'));
    try {
      mkdirSync(path.join(root, 'outside'));
      symlinkSync(path.join(root, 'outside'), path.join(root, 'link'), 'junction');
      expect(() => safeFile(root, 'link/file.ts')).toThrow('symlink');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects missing and duplicate arguments instead of hanging', () => {
    expect(() => flags(['--name'])).toThrow('requires a value');
    expect(() => flags(['--name', 'first', '--name', 'second'])).toThrow('Duplicate');
    expect(flags(['--name', 'first', '--dry-run'])).toEqual({ name: 'first', 'dry-run': true });
  });
});
