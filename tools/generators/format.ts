import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Files } from './files.ts';
import { digest, applyFiles } from './files.ts';
import type { TemplateState } from './render.ts';
import { safeFile } from './safety.ts';

const formatted = new Map<string, Buffer>();
const sideConfigs = [
  '.editorconfig',
  '.oxfmtrc.json',
  '.oxfmtrc.jsonc',
  '.prettierignore',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  'prettier.config.js',
  'prettier.config.cjs',
];
export function formatterKey(root: string): string | undefined {
  const manifest = path.join(root, 'node_modules/vite-plus/package.json');
  const binary = path.join(root, 'node_modules/vite-plus/bin/vp');
  if (!existsSync(manifest) || !existsSync(binary)) return undefined;
  const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
  return digest(`${version}\0${readFileSync(path.join(root, 'vite.config.ts'), 'utf8')}`);
}

// Rendering delegates layout to the pinned, project-local formatter, never a second formatter.
// Cold bootstrap renders without dependencies; setup finalizes only unchanged managed files.
export function formatFiles(root: string, files: Files): Files {
  const binary = path.join(root, 'node_modules/vite-plus/bin/vp');
  if (!existsSync(binary)) return files;
  const formatter = formatterKey(root);
  const directories = new Map<string, string>();
  const sideKey = (directory: string): string => {
    const cached = directories.get(directory);
    if (cached) return cached;
    const parent = path.dirname(directory);
    const key = digest(
      [
        directory === parent ? '' : sideKey(parent),
        ...sideConfigs.map((filename) => {
          const target = path.join(directory, filename);
          return existsSync(target) ? `${target}\0${digest(readFileSync(target))}` : '';
        }),
      ].join('\0'),
    );
    directories.set(directory, key);
    return key;
  };
  const pending: [string, Buffer, string][] = [];
  for (const [filename, contents] of files) {
    if (!/\.(?:[cm]?[jt]sx?|json|css|html|md)$/u.test(filename)) continue;
    const key = digest(
      Buffer.concat([
        Buffer.from(
          `${path.resolve(root)}\0${formatter}\0${sideKey(path.dirname(path.resolve(root, filename)))}\0${filename}\0`,
        ),
        contents,
      ]),
    );
    const cached = formatted.get(key);
    if (cached) {
      files.set(filename, cached);
      continue;
    }
    pending.push([filename, contents, key]);
  }
  const scripts = pending.filter(([filename]) => /\.[cm]?[jt]sx?$/u.test(filename));
  if (scripts.length) {
    const batch = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        readFileSync(new URL('./format-batch.mjs', import.meta.url), 'utf8'),
      ],
      {
        cwd: root,
        input: JSON.stringify({
          entries: scripts.map(([filename, contents]) => [filename, contents.toString()]),
          sideConfigs,
        }),
        timeout: 30_000,
        maxBuffer: 5_000_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          JS_RUNTIME_VERSION: process.versions.node,
          JS_RUNTIME_NAME: process.release.name,
          NODE_PACKAGE_MANAGER: 'vite-plus',
          VP_RESOLVING_CONFIG_METADATA: '1',
        },
      },
    );
    if (batch.status !== 0) throw new Error(`Generated batch format failed: ${batch.stderr}`);
    const response = batch.stdout
      .split('\n')
      .findLast((line) => line.startsWith('STARTER_FORMAT_BATCH '));
    if (!response) throw new Error('Generated batch format returned no response');
    const output: unknown = JSON.parse(response.slice('STARTER_FORMAT_BATCH '.length));
    if (output !== null) {
      if (
        !Array.isArray(output) ||
        output.length !== scripts.length ||
        output.some((item) => typeof item !== 'string')
      )
        throw new Error('Generated batch format returned invalid output');
      for (const [index, [filename, , key]] of scripts.entries()) {
        const contents = Buffer.from(output[index]);
        files.set(filename, contents);
        formatted.set(key, contents);
      }
    }
  }
  for (const [filename, contents, key] of pending) {
    if (formatted.has(key)) continue;
    const result = spawnSync(process.execPath, [binary, 'fmt', '--stdin-filepath', filename], {
      cwd: root,
      input: contents,
      timeout: 30_000,
      maxBuffer: 5_000_000,
    });
    if (result.status !== 0)
      throw new Error(`Generated format failed for ${filename}: ${result.stderr.toString()}`);
    files.set(filename, result.stdout);
    formatted.set(key, result.stdout);
  }
  return files;
}

export function finalizeManaged(root: string): void {
  const statePath = path.join(root, '.template.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as TemplateState;
  const key = formatterKey(root);
  if (key && state.formatKey === key) return;
  const original = readFileSync(statePath);
  const observed = new Map<string, string>();
  const files: Files = new Map();
  for (const [filename, hash] of Object.entries(state.managed)) {
    const target = safeFile(root, filename);
    if (existsSync(target) && digest(readFileSync(target)) === hash) {
      files.set(filename, readFileSync(target));
      observed.set(filename, hash);
    }
  }
  formatFiles(root, files);
  for (const [filename, contents] of files) {
    state.managed[filename] = digest(contents);
  }
  if (key) state.formatKey = key;
  files.set('.template.json', Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  observed.set('.template.json', digest(original));
  const entries = [...files.keys()];
  const unchanged = (filename: string): void => {
    if (
      !existsSync(safeFile(root, filename)) ||
      digest(readFileSync(safeFile(root, filename))) !== observed.get(filename)
    )
      throw new Error(
        `User edited during formatting: ${filename}; nothing will be silently overwritten`,
      );
  };
  entries.forEach(unchanged);
  applyFiles(root, files, [], (index) => unchanged(entries[index]!));
}
