import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCatalog,
  generatedErrors,
  checkGeneratedErrors,
  writeGeneratedErrors,
} from './generate.ts';
import { appFiles } from '../generators/render.ts';
import { projectOptions } from '../generators/options.ts';

const source = process.cwd();
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'error-catalog-'));
  mkdirSync(path.join(root, 'tools/errors'), { recursive: true });
  mkdirSync(path.join(root, 'packages/contracts/src'), { recursive: true });
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(
    path.join(root, 'tools/errors/catalog.json'),
    readFileSync(path.join(source, 'tools/errors/catalog.json')),
  );
  writeFileSync(
    path.join(root, 'packages/contracts/package.json'),
    JSON.stringify({ name: '@alternate/contracts' }),
  );
  return root;
}
describe('single error catalog generation', () => {
  it('fails on malformed, unknown or unmapped catalog data and on generated drift', () => {
    const root = fixture();
    try {
      const catalog = readCatalog(root);
      writeGeneratedErrors(root);
      expect(checkGeneratedErrors(root)).toEqual([]);
      writeFileSync(path.join(root, 'packages/contracts/src/errors.generated.ts'), 'stale');
      expect(checkGeneratedErrors(root)).toEqual([expect.stringContaining('catalog drift')]);
      for (const invalid of [
        { ...catalog, extra: true },
        { ...catalog, public: [] },
        { ...catalog, internal: { bad: 'missing' } },
        { ...catalog, internal: { bad_: 'internal_error' } },
        { ...catalog, internal: { bad__code: 'internal_error' } },
        {
          ...catalog,
          public: {
            ...catalog.public,
            internal_error: { ...catalog.public.internal_error!, exception: 'private' },
          },
        },
      ]) {
        writeFileSync(path.join(root, 'tools/errors/catalog.json'), JSON.stringify(invalid));
        expect(() => readCatalog(root)).toThrow(/Invalid|Unmapped/u);
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });
  it('uses the changed catalog when rendering a differently named Desktop, without stale projections', () => {
    const root = fixture();
    try {
      cpSync(
        path.join(source, 'tools/generators/templates/desktop'),
        path.join(root, 'tools/generators/templates/desktop'),
        { recursive: true },
      );
      // An API-only generated project has Desktop blueprints but no Desktop owner.
      expect(readFileSync(path.join(root, 'packages/contracts/package.json'), 'utf8')).toContain(
        '@alternate',
      );
      const catalog = readCatalog(root);
      catalog.public.internal_error!.message = 'A newly defined fixed failure.';
      catalog.internal.new_failure = 'internal_error';
      writeFileSync(path.join(root, 'tools/errors/catalog.json'), JSON.stringify(catalog));
      const options = projectOptions({
        name: 'independent-errors',
        scope: '@alternate',
        preset: 'desktop',
        features: '',
      });
      const rendered = appFiles(root, options, 'desktop', 'desk', false);
      const rust = rendered.get('packages/desk/src-tauri/src/errors_generated.rs')!.toString();
      expect(rust).toContain('A newly defined fixed failure.');
      expect(rust).toContain('NewFailure');
      expect(rust).not.toContain('@starter');
      const ts = generatedErrors(root)
        .get('packages/contracts/src/errors.generated.ts')!
        .toString();
      expect(ts).toContain('new_failure');
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
