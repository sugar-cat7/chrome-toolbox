import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { moduleRules } from './preview.ts';

it('keeps SDK CSS data modules and ESM names in local production previews', () => {
  const bundle = mkdtempSync(path.join(tmpdir(), 'starter-preview-'));
  try {
    mkdirSync(path.join(bundle, 'assets'));
    writeFileSync(path.join(bundle, 'index.js'), 'export default {}');
    writeFileSync(path.join(bundle, 'helper.mjs'), 'export default {}');
    writeFileSync(path.join(bundle, 'index.js.map'), '{}');
    writeFileSync(path.join(bundle, 'assets/styles.css'), 'body { color: black }');
    mkdirSync(path.join(bundle, 'directory.js'));
    expect(
      moduleRules(bundle, {
        mainModule: 'index.js',
        modules: {
          'index.js': { type: 'esm' },
          'helper.mjs': { type: 'esm' },
          'index.js.map': { type: 'sourcemap' },
          'assets/styles.css': { type: 'data' },
        },
      }),
    ).toEqual([
      { type: 'ESModule', globs: ['index.js', 'helper.mjs'], fallthrough: true },
      { type: 'Data', globs: ['assets/styles.css'], fallthrough: true },
    ]);
    for (const modules of [
      {},
      { 'missing.js': { type: 'esm' } },
      { 'directory.js': { type: 'esm' } },
      { '../escape.js': { type: 'esm' } },
      { '..\\escape.js': { type: 'esm' } },
      { [path.join(bundle, 'index.js')]: { type: 'esm' } },
      { 'index.js': { type: 'cjs' } },
      { 'index.js': { type: 'data' } },
      { 'index.js': { type: 'esm' }, 'assets/styles.css': { type: 'sourcemap' } },
      { 'index.js': { type: 'esm' }, 'assets/styles.css': { type: 'esm' } },
    ])
      expect(() => moduleRules(bundle, { mainModule: 'index.js', modules })).toThrow(
        /SDK build manifest|SDK-built module|ESM main module/u,
      );
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});
