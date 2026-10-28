import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { baselineDifferences } from './baseline.ts';
import path from 'node:path';
import { digest, walk, type Files } from './files.ts';
import { selectedPackages, type ProjectOptions } from './options.ts';
import { formatFiles, formatterKey } from './format.ts';
import { generatedErrors } from '../errors/generate.ts';
import { ownHeadSha, foreignGitEnvironment } from '../quality/checkout.ts';

const infrastructure = [
  '.agents',
  '.github',
  'docs',
  'tools',
  '.gitignore',
  '.gitattributes',
  '.semgrepignore',
  'knip.ts',
  'LICENSE',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'renovate.json',
  'mise.toml',
  'mise.security.toml',
  'mise.o11y.toml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
];
export type TemplateState = {
  version: string;
  kind: 'reference' | 'project';
  options: ProjectOptions;
  packages: string[];
  referenceApps?: Record<string, ProjectOptions>;
  managed: Record<string, string>;
  lockPending?: boolean;
  lockId?: string;
  formatKey?: string;
  origin?: { sha: string | null; dirty: boolean; contentId: string };
};

function expand(contents: string, options: ProjectOptions, app = ''): string {
  const resource = digest(`${options.name}/${app}`).slice(0, 32);
  const localId = `${resource.slice(0, 8)}-${resource.slice(8, 12)}-4${resource.slice(13, 16)}-8${resource.slice(17, 20)}-${resource.slice(20)}`;
  const service = app === 'web' && options.features.includes('services');
  const has = (feature: 'd1' | 'kv' | 'r2') => options.features.includes(feature);
  const bindings = service
    ? [`API: bindings.worker({ worker: '__PROJECT__-api' }),`]
    : [
        ...(has('d1')
          ? [
              `NOTES: bindings.d1({ id: environment === 'local' ? '${localId}' : required('D1_DATABASE_ID') }),`,
            ]
          : []),
        ...(has('kv')
          ? [
              "NOTE_CACHE: bindings.kv({ id: environment === 'local' ? '__PROJECT__-__APP__-local' : required('KV_NAMESPACE_ID') }),",
            ]
          : []),
        ...(has('r2')
          ? [
              "NOTE_EXPORTS: bindings.r2({ name: environment === 'local' ? '__PROJECT__-__APP__-local' : required('R2_BUCKET_NAME') }),",
            ]
          : []),
      ];
  return contents
    .replaceAll('\r\n', '\n')
    .replaceAll('__VISUAL_STORAGE__', has('d1') ? 'persistent' : 'volatile')
    .replaceAll('__BINDINGS__', bindings.join('\n'))
    .replaceAll('__SERVER_IMPORT__', service ? '' : "import { handleNotes } from './notes.ts';")
    .replaceAll(
      '__SERVER_FETCH__',
      service ? 'env.API.fetch(request)' : 'handleNotes(request, env)',
    )
    .replaceAll(
      '__HEALTH_STORAGE__',
      service ? 'service-binding' : has('d1') ? 'persistent-d1' : 'volatile-sample',
    )
    .replaceAll(
      '__STORAGE_LABEL__',
      has('d1') ? 'Local D1 persistence' : 'Volatile sample — resets when the Worker restarts',
    )
    .replaceAll('__HAS_D1__', String(has('d1')))
    .replaceAll('__HAS_KV__', String(has('kv')))
    .replaceAll('__HAS_R2__', String(has('r2')))
    .replaceAll('__PROJECT__', options.name)
    .replaceAll('__SCOPE__', options.scope)
    .replaceAll('__IDENTIFIER__', options.identifier)
    .replaceAll('__APP__', app);
}

export function appFiles(
  source: string,
  options: ProjectOptions,
  kind: string,
  name = kind,
  format = true,
): Files {
  const files: Files = new Map();
  if (kind === 'contracts' || kind === 'desktop') {
    for (const [file, contents] of generatedErrors(
      source,
      [{ runtime: kind === 'desktop' ? 'desktop' : 'library', directory: `packages/${name}` }],
      true,
      format,
    ))
      if (file.startsWith(`packages/${name}/`)) files.set(file, contents);
  }
  const templates = path.join(source, 'tools/generators/templates', kind);
  if (!existsSync(templates)) throw new Error(`Template not found: ${kind}`);
  for (const filename of walk(templates)) {
    if (!filename.endsWith('.template')) throw new Error(`Unexpected blueprint: ${filename}`);
    if (
      filename.endsWith('.png.template') &&
      /\/(?:persistent|volatile)-/u.test(filename) &&
      !filename.includes(`/${options.features.includes('d1') ? 'persistent' : 'volatile'}-`)
    )
      continue;
    const contents = readFileSync(path.join(templates, filename));
    let expanded = expand(contents.toString(), options, name);
    if (filename === 'src-tauri/Cargo.lock.template') {
      // Cargo's lock package order is by name. A renamed root package must move
      // with its unchanged dependency/checksum block, including in frozen builds.
      const [header, ...blocks] = expanded.split('[[package]]\n');
      blocks.sort((left, right) => {
        const a = /^name = "([^"]+)"/mu.exec(left)![1]!;
        const b = /^name = "([^"]+)"/mu.exec(right)![1]!;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      expanded = `${header!.trimEnd()}\n\n[[package]]\n${blocks.map((block) => block.trimEnd()).join('\n\n[[package]]\n')}\n`;
    }

    files.set(
      `packages/${name}/${filename.slice(0, -'.template'.length)}`,
      filename.endsWith('.png.template') ? contents : Buffer.from(expanded),
    );
  }
  if (kind === 'api' || (kind === 'web' && !options.features.includes('services'))) {
    const worker = path.join(source, 'tools/generators/templates/worker');
    for (const filename of walk(worker)) {
      if (
        !options.features.includes('d1') &&
        (filename.startsWith('migrations/') ||
          filename === 'seed.sql.template' ||
          filename === 'restart.ts.template')
      )
        continue;
      const target =
        filename === 'notes.ts.template'
          ? 'src/notes.ts'
          : filename === 'restart.ts.template'
            ? 'test/restart.ts'
            : filename.slice(0, -'.template'.length);
      files.set(
        `packages/${name}/${target}`,
        Buffer.from(expand(readFileSync(path.join(worker, filename), 'utf8'), options, name)),
      );
    }
  }
  const manifestPath = `packages/${name}/package.json`;
  const manifest = JSON.parse(files.get(manifestPath)!.toString()) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    dependencies: Record<string, string>;
  };
  if (kind === 'web' && options.features.includes('services')) {
    manifest.devDependencies[`${options.scope}/api`] = 'workspace:*';
    delete manifest.dependencies.zod;
    const starter = (
      manifest as typeof manifest & { starter: { resultBoundaries?: Record<string, string> } }
    ).starter;
    if (starter.resultBoundaries) delete starter.resultBoundaries['src/notes.ts:handleNotes'];
  }
  if (
    options.features.includes('d1') &&
    (kind === 'api' || (kind === 'web' && !options.features.includes('services')))
  )
    manifest.scripts['test:restart'] = 'node test/restart.ts';
  if (
    !options.features.includes('d1') ||
    (kind === 'web' && options.features.includes('services'))
  ) {
    delete manifest.scripts['db:migrate'];
    delete manifest.scripts['db:seed'];
  }
  files.set(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  if (
    !options.features.some((feature) => ['d1', 'kv', 'r2'].includes(feature)) ||
    (kind === 'web' && options.features.includes('services'))
  ) {
    const config = `packages/${name}/cloudflare.config.ts`;
    if (files.has(config))
      files.set(
        config,
        Buffer.from(
          files
            .get(config)!
            .toString()
            .replace(/  const required = \(key: string\) => \{[\s\S]*?\n  \};\n/u, ''),
        ),
      );
  }
  return format ? formatFiles(source, files) : files;
}

export function infrastructureFiles(source: string): Files {
  const files: Files = new Map();
  for (const entry of infrastructure) {
    const absolute = path.join(source, entry);
    if (!existsSync(absolute)) continue;
    const entries =
      entry.startsWith('.') && !entry.includes('/') && !['.agents', '.github'].includes(entry)
        ? [entry]
        : ['.agents', '.github', 'docs', 'tools'].includes(entry)
          ? walk(absolute).map((relative) => `${entry}/${relative}`)
          : [entry];
    for (const relative of entries) files.set(relative, readFileSync(path.join(source, relative)));
  }
  files.set('package.json', readFileSync(path.join(source, 'package.json')));
  return files;
}

export function generationOrigin(source: string): { sha: string | null; dirty: boolean } {
  const filename = path.join(source, '.template.json');
  const previous = existsSync(filename)
    ? (JSON.parse(readFileSync(filename, 'utf8')) as TemplateState)
    : undefined;
  const changed = previous?.kind === 'project' && baselineDifferences(source).length > 0;
  const head = ownHeadSha(source);
  if (
    !head &&
    previous?.kind === 'project' &&
    !changed &&
    previous.origin?.dirty === false &&
    /^[a-f0-9]{40}$/u.test(previous.origin.sha ?? '')
  )
    return { sha: previous.origin.sha, dirty: false };
  const status = head
    ? spawnSync('git', ['status', '--porcelain'], {
        cwd: source,
        env: foreignGitEnvironment(source),
        encoding: 'utf8',
        timeout: 10000,
      })
    : undefined;
  return {
    sha: head,
    dirty:
      changed ||
      (status?.status === 0 && status.stdout.length > 0) ||
      (!head && previous?.origin?.dirty === true),
  };
}

export function projectFiles(
  source: string,
  options: ProjectOptions,
  kind: TemplateState['kind'] = 'project',
): Files {
  const files = infrastructureFiles(source);
  if (files.has('README.md'))
    files.set(
      'README.md',
      Buffer.from(
        files
          .get('README.md')!
          .toString()
          .replace(/^# .+\n/u, `# ${options.name}\n`),
      ),
    );
  const root = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as {
    name: string;
    scripts: Record<string, string>;
    [key: string]: unknown;
  };
  root.name = options.name;
  root.scripts = { ...root.scripts };
  for (const command of Object.keys(root.scripts))
    if (command.startsWith('dev:')) delete root.scripts[command];
  const packages = selectedPackages(options);
  for (const app of packages) {
    for (const [relative, contents] of appFiles(source, options, app))
      files.set(relative, contents);
    if (['web', 'api', 'desktop'].includes(app))
      root.scripts[`dev:${app}`] = `node tools/dev-environment/dev.ts ${app}`;
  }
  files.set('package.json', Buffer.from(`${JSON.stringify(root, null, 2)}\n`));
  formatFiles(source, new Map([['package.json', files.get('package.json')!]])).forEach(
    (contents, filename) => files.set(filename, contents),
  );
  const state: TemplateState = {
    version: root.version as string,
    kind,
    lockPending: true,
    options,
    packages,
    managed: Object.fromEntries(
      [...files].map(([relative, contents]) => [relative, digest(contents)]),
    ),
  };
  if (kind === 'project') {
    state.origin = {
      ...generationOrigin(source),
      contentId: digest(
        Buffer.concat(
          [...files].flatMap(([filename, contents]) => [Buffer.from(`${filename}\0`), contents]),
        ),
      ),
    };
  }
  const key = formatterKey(source);
  if (key) state.formatKey = key;
  files.set('.template.json', Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  return files;
}
