import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pnpm } from '../process.ts';
import { applyFiles, digest, recover, walk, type Files } from './files.ts';
import { flags, projectOptions, selectedPackages, validateName } from './options.ts';
import { appFiles, projectFiles, infrastructureFiles, type TemplateState } from './render.ts';
import { safeFile } from './safety.ts';
import { formatterKey } from './format.ts';

export const templateRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export function readState(root: string): TemplateState | undefined {
  if (!existsSync(root)) return undefined;
  const filename = safeFile(root, '.template.json');
  return existsSync(filename)
    ? (JSON.parse(readFileSync(filename, 'utf8')) as TemplateState)
    : undefined;
}

export function reconcile(
  root: string,
  files: Files,
  previous?: TemplateState,
): { writes: Files; remove: string[] } {
  const writes: Files = new Map();
  const remove: string[] = [];
  for (const [relative, contents] of files) {
    const target = safeFile(root, relative);
    if (existsSync(target)) {
      const current = digest(readFileSync(target));
      if (current === digest(contents)) continue;
      if (relative !== '.template.json' && current !== previous?.managed[relative])
        throw new Error(`User change or collision: ${relative}; review the diff before migration`);
    }
    writes.set(relative, contents);
  }
  for (const relative of Object.keys(previous?.managed ?? {})) {
    if (files.has(relative)) continue;
    const target = safeFile(root, relative);
    if (!existsSync(target)) continue;
    if (digest(readFileSync(target)) !== previous?.managed[relative])
      throw new Error(`Refusing to delete user change: ${relative}`);
    remove.push(relative);
  }
  return { writes, remove };
}

export async function main(args: string[]): Promise<void> {
  const command = args[0];
  if (!['init', 'sync', 'add'].includes(command ?? ''))
    throw new Error('Usage: node tools/generators/cli.ts init|sync|add [flags]; see README');
  const input = flags(args.slice(1));
  const allowed = [
    'name',
    'scope',
    'identifier',
    'preset',
    'features',
    'target',
    'dry-run',
    'reference',
    'check',
    'no-install',
    'recover',
    'kind',
  ];
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new Error(`Unknown flag: --${key}`);
  const root = path.resolve(typeof input.target === 'string' ? input.target : process.cwd());
  if (input.recover && input['dry-run'])
    throw new Error('--recover changes files and cannot be combined with --dry-run');
  if (input.recover) recover(root);
  const previous = readState(root);
  let files: Files;
  let remove: string[] = [];
  if (command === 'sync') {
    if (previous?.kind !== 'reference')
      throw new Error(
        'sync is only for the reference workspace; generated projects use reviewed version migrations',
      );
    files = new Map(
      selectedPackages(previous.options).flatMap((kind) => [
        ...appFiles(templateRoot, previous.options, kind),
      ]),
    );
    const packages = new Set(selectedPackages(previous.options));
    for (const [name, options] of Object.entries(previous.referenceApps ?? {})) {
      validateName(name);
      if (selectedPackages(previous.options).includes(name))
        throw new Error(`Reference app name conflicts with preset: ${name}`);
      const validated = projectOptions({ ...options, features: options.features.join(',') });
      if (!['api', 'web', 'desktop'].includes(validated.preset))
        throw new Error(`Reference app must use an application preset: ${name}`);
      for (const [filename, contents] of appFiles(templateRoot, validated, validated.preset, name))
        files.set(filename, contents);
      packages.add(name);
      for (const shared of selectedPackages(validated).filter(
        (kind) => !['api', 'web', 'desktop'].includes(kind),
      )) {
        if (packages.has(shared)) continue;
        for (const [filename, contents] of appFiles(templateRoot, validated, shared))
          files.set(filename, contents);
        packages.add(shared);
      }
    }
    const roots = [...packages].map((name) => `packages/${name}/`);
    const owned = Object.fromEntries(
      Object.entries(previous.managed).filter(([filename]) =>
        roots.some((prefix) => filename.startsWith(prefix)),
      ),
    );
    // Infrastructure in a reference workspace is authored here. Record its current
    // baseline for future template clones without modifying any of those files.
    const retained = Object.fromEntries(
      [...infrastructureFiles(root)].map(([filename, contents]) => [filename, digest(contents)]),
    );
    const state = {
      ...previous,
      packages: [...packages],
      managed: {
        ...retained,
        ...Object.fromEntries(
          [...files].map(([filename, contents]) => [filename, digest(contents)]),
        ),
      },
    };
    const lock = path.join(root, 'pnpm-lock.yaml');
    if (existsSync(lock)) state.lockId = digest(readFileSync(lock));
    // A normal sync prepares dependencies after rendering; setup records its final lock.
    if (!input['no-install'] && !input.check && !input['dry-run']) state.lockPending = true;
    const key = formatterKey(root);
    if (key) state.formatKey = key;
    files.set('.template.json', Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
    const planned = reconcile(root, files, { ...previous, managed: owned });
    if (input.check) {
      if (planned.writes.size || planned.remove.length)
        throw new Error(
          `Reference drift: ${[...planned.writes.keys(), ...planned.remove].join(', ')}; edit blueprints and run template:sync`,
        );
      console.log('Reference matches canonical blueprints');
      return;
    }
    files = planned.writes;
    remove = planned.remove;
  } else if (command === 'add') {
    if (!previous) throw new Error('Initialize the project before adding an app');
    if (
      typeof input.kind !== 'string' ||
      !['web', 'api', 'desktop'].includes(input.kind) ||
      typeof input.name !== 'string'
    )
      throw new Error('add requires --kind web|api|desktop --name <directory>');
    validateName(input.name);
    const appDirectory = safeFile(root, `packages/${input.name}`);
    if (existsSync(safeFile(root, `packages/${input.name}/package.json`)))
      throw new Error(`App already exists: ${input.name}`);
    const appOutputs = new Set([
      'node_modules',
      'dist',
      '.cloudflare',
      '.wrangler',
      'artifacts',
      'test-results',
      'playwright-report',
      'src/routeTree.gen.ts',
      ...(input.kind === 'desktop'
        ? [
            'src-tauri/target',
            'src-tauri/icons',
            'src-tauri/gen',
            'src-tauri/permissions/autogenerated',
          ]
        : []),
    ]);
    if (existsSync(appDirectory) && walk(appDirectory, '', new Set(), appOutputs).length)
      throw new Error(`App directory contains user files: ${input.name}`);
    const options = projectOptions({
      name: previous.options.name,
      scope: previous.options.scope,
      identifier:
        input.identifier ?? `${previous.options.identifier}.${input.name.replaceAll('-', '')}`,
      preset: input.kind,
      features: input.features ?? '',
    });
    if (`${options.name}-${input.name}`.length > 63)
      throw new Error('Combined Worker name must be at most 63 characters');
    if (input.kind === 'desktop') {
      const { workspacePackages } = await import('../quality/graph.ts');
      for (const existing of workspacePackages(root).filter((pkg) => pkg.runtime === 'desktop')) {
        const config = JSON.parse(
          readFileSync(safeFile(root, `${existing.directory}/src-tauri/tauri.conf.json`), 'utf8'),
        ) as { identifier: string };
        if (config.identifier === options.identifier)
          throw new Error(
            `Desktop identifier collision: ${options.identifier}; choose --identifier`,
          );
      }
    }
    files = appFiles(root, options, input.kind, input.name);
    for (const shared of selectedPackages(options).filter(
      (value) => !['web', 'api', 'desktop'].includes(value),
    )) {
      const sharedManifest = safeFile(root, `packages/${shared}/package.json`);
      if (existsSync(sharedManifest)) {
        const manifest = JSON.parse(readFileSync(sharedManifest, 'utf8')) as { name?: string };
        if (manifest.name !== `${options.scope}/${shared}`)
          throw new Error(`Shared package identity collision: ${shared}`);
      } else {
        const directory = safeFile(root, `packages/${shared}`);
        if (
          existsSync(directory) &&
          walk(directory, '', new Set(['node_modules', 'dist', 'artifacts'])).length
        )
          throw new Error(`Shared package directory contains user files: ${shared}`);
        for (const [filename, contents] of appFiles(root, options, shared))
          files.set(filename, contents);
      }
    }
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    if (manifest.scripts[`dev:${input.name}`])
      throw new Error(`Existing user script dev:${input.name} is protected`);
    manifest.scripts[`dev:${input.name}`] = `node tools/dev-environment/dev.ts ${input.name}`;
    files.set('package.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const state = {
      ...previous,
      ...(previous.kind === 'reference'
        ? { referenceApps: { ...previous.referenceApps, [input.name]: options } }
        : {}),
      lockPending: true,
      packages: [
        ...new Set([
          ...previous.packages,
          input.name,
          ...selectedPackages(options).filter(
            (value) => !['web', 'api', 'desktop'].includes(value),
          ),
        ]),
      ],
      managed: {
        ...previous.managed,
        ...Object.fromEntries(
          [...files].map(([filename, contents]) => [filename, digest(contents)]),
        ),
      },
    };
    // A cold add cannot format its new files. The inherited key only covers the
    // previous managed inputs; setup must finalize unchanged new scaffold files.
    if (!formatterKey(root)) delete state.formatKey;
    files.set('.template.json', Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
    for (const filename of files.keys())
      if (
        filename !== 'package.json' &&
        filename !== '.template.json' &&
        existsSync(safeFile(root, filename))
      )
        throw new Error(`Collision: ${filename}`);
  } else {
    const options = projectOptions(input);
    if (
      previous?.kind === 'project' &&
      JSON.stringify(previous.options) === JSON.stringify(options)
    ) {
      console.log(
        'Already initialized; user changes preserved. Run env:setup for pending installation.',
      );
      return;
    }
    if (!previous && existsSync(root) && readdirSync(root).some((entry) => entry !== '.git'))
      throw new Error(
        'Initialization requires an empty directory or a template reference clone; existing files are protected',
      );
    files = projectFiles(templateRoot, options, input.reference ? 'reference' : 'project');
    if (previous) ({ writes: files, remove } = reconcile(root, files, previous));
  }
  console.log(
    JSON.stringify(
      { root, writes: files.size, remove, dryRun: Boolean(input['dry-run']) },
      null,
      2,
    ),
  );
  if (input['dry-run']) return;
  applyFiles(root, files, remove);
  if (!input['no-install']) {
    await pnpm(['install', '--no-frozen-lockfile'], { cwd: root });
    await pnpm(['env:setup'], { cwd: root });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
