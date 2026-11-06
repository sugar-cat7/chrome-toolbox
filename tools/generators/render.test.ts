import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { documentation } from '../quality/documentation.ts';
import { applyFiles } from './files.ts';
import { formatFiles } from './format.ts';
import { presets, projectOptions } from './options.ts';
import { projectFiles, rootReadme } from './render.ts';

const source = path.resolve(import.meta.dirname, '../..');

it('keeps the README blueprint formatted, since rendering only names its heading', () => {
  // The placeholder itself reads as emphasis to the formatter, so check a named README.
  const readme = Buffer.from(
    readFileSync(path.join(source, rootReadme), 'utf8').replace(
      /^# __PROJECT__\n/u,
      '# generated-web\n',
    ),
  );
  expect(formatFiles(source, new Map([['README.md', readme]])).get('README.md')).toEqual(readme);
});

it.each(presets)(
  'renders a %s project whose README, root manifest and documents refer only to what it contains',
  (preset) => {
    const name = `generated-${preset}`;
    const files = projectFiles(source, projectOptions({ name, scope: '@generated', preset }));

    // The README blueprint, named for the project: the source's own README describes the source.
    expect(files.get('README.md')?.toString()).toBe(
      readFileSync(path.join(source, rootReadme), 'utf8').replace(
        /^# __PROJECT__\n/u,
        `# ${name}\n`,
      ),
    );

    // A workspace dependency of the root manifest must be installable in the generated project.
    const generated = new Set(
      [...files]
        .filter(([filename]) => /^packages\/[^/]+\/package\.json$/u.test(filename))
        .map(([, contents]) => (JSON.parse(contents.toString()) as { name: string }).name),
    );
    const manifest = JSON.parse(files.get('package.json')!.toString()) as Record<
      'dependencies' | 'devDependencies',
      Record<string, string> | undefined
    >;
    expect(
      Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter(
          ([dependency, specifier]) =>
            specifier.startsWith('workspace:') && !generated.has(dependency),
        )
        .map(([dependency]) => dependency),
    ).toEqual([]);

    // The generated project's own documentation check: local links and root commands resolve.
    const root = mkdtempSync(path.join(os.tmpdir(), 'starter-generated-docs-'));
    try {
      applyFiles(root, files);
      expect(documentation(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
