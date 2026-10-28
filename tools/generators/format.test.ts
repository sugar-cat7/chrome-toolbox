import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { finalizeManaged, formatFiles } from './format.ts';
import { main, readState } from './cli.ts';
import { applyFiles } from './files.ts';
import { projectOptions } from './options.ts';
import { projectFiles } from './render.ts';
import { spawnOwned, stopTree } from '../process.ts';

const source = path.resolve(import.meta.dirname, '../..');
function fixture(config: string, run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-format-'));
  try {
    symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(root, 'vite.config.ts'), config);
    run(root);
  } finally {
    // Use Node's bounded filesystem retries for Windows removal refusals.
    // Persistent failures still throw; this does not infer a child-process leak.
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    expect(existsSync(root)).toBe(false);
  }
}
const simple =
  'export default { fmt: { singleQuote: true, ignorePatterns: ["packages/cache/dist/**"] } };';
function cli(root: string, filename: string, contents: Buffer): Buffer {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/vite-plus/bin/vp'), 'fmt', '--stdin-filepath', filename],
    { cwd: root, input: contents, timeout: 30_000 },
  );
  expect({ status: result.status, stderr: result.stderr.toString() }).toEqual({
    status: 0,
    stderr: '',
  });
  return result.stdout;
}

describe('cold app addition', () => {
  let coldBaseline: ReturnType<typeof projectFiles>;
  beforeAll(() => {
    // Render one complete baseline; each SDK state still receives independent
    // files, runs the real add command and finalizes its own managed inputs.
    coldBaseline = projectFiles(
      source,
      projectOptions({
        name: 'formatter-cold-add',
        scope: '@formatter-add',
        preset: 'api',
      }),
    );
  }, 10_000);

  it.each(['absent', 'partial'])(
    'finalizes a cold add with %s SDK and preserves user edits',
    async (sdk) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'starter-cold-add-'));
      try {
        applyFiles(
          root,
          new Map(
            [...coldBaseline].map(([filename, contents]) => [filename, Buffer.from(contents)]),
          ),
        );
        expect(readState(root)?.formatKey).toBeDefined();
        expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
        if (sdk === 'partial') {
          const directory = path.join(root, 'node_modules/vite-plus');
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            path.join(directory, 'package.json'),
            readFileSync(path.join(source, 'node_modules/vite-plus/package.json')),
          );
        }
        await main(['add', '--kind', 'api', '--name', 'status', '--target', root, '--no-install']);
        expect(readState(root)?.formatKey).toBeUndefined();

        const filename = 'packages/status/cloudflare.config.ts';
        const unformatted = readFileSync(path.join(root, filename));
        const userFile = path.join(root, 'packages/status/src/notes.ts');
        const userBytes = Buffer.concat([
          readFileSync(userFile),
          Buffer.from('\n// user change\n'),
        ]);
        writeFileSync(userFile, userBytes);
        rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
        symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction');
        const expected = cli(root, filename, unformatted);
        expect(unformatted).not.toEqual(expected);
        finalizeManaged(root);
        expect(readFileSync(path.join(root, filename))).toEqual(expected);
        expect(readFileSync(userFile)).toEqual(userBytes);
        const finalized = readFileSync(path.join(root, '.template.json'));
        finalizeManaged(root);
        expect(readFileSync(path.join(root, '.template.json'))).toEqual(finalized);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        expect(existsSync(root)).toBe(false);
      }
    },
  );
});

it('matches the owning SDK CLI for mixed scripts, ignored build output and JSON', () => {
  fixture(simple, (root) => {
    const files = new Map([
      ['packages/cache/src/example.ts', Buffer.from('export const value="quoted";')],
      ['packages/cache/src/view.tsx', Buffer.from('export const view=<button>go</button>;')],
      ['packages/cache/dist/ignored.ts', Buffer.from('export const untouched= [1,2];')],
      ['package.json', Buffer.from('{"name":"parity","type":"module"}')],
    ]);
    const expected = new Map(
      [...files].map(([name, contents]) => [name, cli(root, name, contents)]),
    );
    expect(formatFiles(root, files)).toEqual(expected);
    expect(files.get('packages/cache/src/example.ts')?.toString()).toContain("'quoted'");
    expect(files.get('packages/cache/dist/ignored.ts')?.toString()).toBe(
      'export const untouched= [1,2];',
    );
  });
});

it.each([
  [
    'custom formatter option',
    'export default { fmt: { singleQuote: false, semi: false, ignorePatterns: [] } };',
    false,
  ],
  ['editorconfig', simple, true],
])('retains CLI semantics with %s', (_, config, editorconfig) => {
  fixture(config, (root) => {
    if (editorconfig)
      writeFileSync(
        path.join(root, '.editorconfig'),
        'root = true\n[*]\nindent_style = space\nindent_size = 4\n',
      );
    const filename = `fallback-${editorconfig ? 'editor' : 'options'}.ts`;
    const contents = Buffer.from('export function fallback(){return "value";}');
    const expected = cli(root, filename, contents);
    expect(formatFiles(root, new Map([[filename, contents]])).get(filename)).toEqual(expected);
    expect(expected.toString().includes(';')).toBe(editorconfig);
    expect(readFileSync(path.join(root, 'vite.config.ts'), 'utf8')).toBe(config);
  });
});

it('rejects a malformed script before installing any batch output', () => {
  fixture(simple, (root) => {
    const files = new Map([
      ['atomic-valid.ts', Buffer.from('export const atomicValid="value";')],
      ['atomic-invalid.ts', Buffer.from('export const = ;')],
    ]);
    const original = new Map(files);
    expect(() => formatFiles(root, files)).toThrow('Generated batch format failed');
    expect(files).toEqual(original);
  });
});

it('invalidates cached formatting across roots and after a side configuration change', () => {
  fixture(simple, (first) => {
    const filename = 'cache-protection.ts';
    const contents = Buffer.from('export function cacheProtection(){return "value";}');
    const format = (root: string) =>
      formatFiles(root, new Map([[filename, contents]])).get(filename)!;
    const before = format(first);
    expect(before.toString()).toContain("\n  return 'value';");
    const editorconfig = 'root = true\n[*]\nindent_style = space\nindent_size = 4\n';
    fixture(simple, (second) => {
      writeFileSync(path.join(second, '.editorconfig'), editorconfig);
      expect(format(second)).toEqual(cli(second, filename, contents));
      expect(format(second).toString()).toContain("\n    return 'value';");
    });
    writeFileSync(path.join(first, '.editorconfig'), editorconfig);
    expect(format(first)).toEqual(cli(first, filename, contents));
    expect(format(first)).not.toEqual(before);
  });
});

it('matches CLI stdin behavior for a gitignored source file and CLI runtime metadata', () => {
  fixture(
    'export default {fmt:{singleQuote:process.env.JS_RUNTIME_VERSION === process.versions.node && process.env.JS_RUNTIME_NAME === process.release.name && process.env.NODE_PACKAGE_MANAGER === "vite-plus",ignorePatterns:[]}};',
    (root) => {
      writeFileSync(path.join(root, '.gitignore'), 'gitignored.ts\n');
      const contents = Buffer.from('export const metadata="value";');
      const output = formatFiles(root, new Map([['gitignored.ts', contents]])).get('gitignored.ts');
      expect(output).toEqual(cli(root, 'gitignored.ts', contents));
      expect(output?.toString()).toContain("'value'");
    },
  );
});

it('reports malformed formatting before naturally draining a tracked SDK child', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-format-drain-'));
  const snapshot = path.join(root, 'exit-snapshot.json');
  const server = path.join(root, 'sdk-child.mjs');
  symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    server,
    "import {createServer} from 'node:http';const server=createServer((request,response)=>{if(request.url!=='/release'){response.statusCode=404;response.end();return;}response.end('released');server.close();});server.listen(0,'127.0.0.1',()=>console.log('FORMAT_CHILD '+JSON.stringify({origin:'http://127.0.0.1:'+server.address().port,pid:process.pid})));",
  );
  writeFileSync(
    path.join(root, 'vite.config.ts'),
    `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,[process.env.FORMAT_DRAIN_CHILD],{stdio:['ignore','inherit','inherit']});process.on('exit',()=>writeFileSync(process.env.FORMAT_DRAIN_SNAPSHOT,JSON.stringify({code:child.exitCode,signal:child.signalCode})));${simple}`,
  );
  const child = spawnOwned(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      readFileSync(new URL('./format-batch.mjs', import.meta.url), 'utf8'),
    ],
    {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORMAT_DRAIN_CHILD: server, FORMAT_DRAIN_SNAPSHOT: snapshot },
    },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let output = '';
  let error = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = new Promise<string>((resolve, reject) => {
      const check = () => {
        if (!error.includes('Generated format failed for atomic-invalid.ts')) return;
        // A fatal unhandled exception emits host exit before its error diagnostic.
        // Managed teardown cannot change the snapshot of the child at that moment.
        if (existsSync(snapshot)) {
          reject(
            new Error(
              `Formatter exited before draining its SDK child: ${readFileSync(snapshot, 'utf8')}`,
            ),
          );
          return;
        }
        const origin = /FORMAT_CHILD (\{[^\n]+\})/u.exec(output)?.[1];
        if (origin) resolve((JSON.parse(origin) as { origin: string }).origin);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        check();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        error += chunk.toString();
        check();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Formatter exited before SDK release: ${error}`)));
      timer = setTimeout(() => reject(new Error('Formatter SDK child readiness timeout')), 15_000);
    });
    child.stdin?.end(
      JSON.stringify({ entries: [['atomic-invalid.ts', 'export const = ;']], sideConfigs: [] }),
    );
    const origin = await ready;
    if (timer) clearTimeout(timer);
    expect(existsSync(snapshot)).toBe(false);
    expect(
      await (await fetch(`${origin}/release`, { signal: AbortSignal.timeout(1000) })).text(),
    ).toBe('released');
    await closed;
    await stopTree(child, 0);
    expect(child.exitCode).toBe(1);
    expect(error).toContain('Generated format failed for atomic-invalid.ts');
    expect(output).not.toContain('STARTER_FORMAT_BATCH');
    expect(JSON.parse(readFileSync(snapshot, 'utf8'))).toEqual({ code: 0, signal: null });
  } finally {
    if (timer) clearTimeout(timer);
    await stopTree(child, 0);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    expect(existsSync(root)).toBe(false);
  }
});
