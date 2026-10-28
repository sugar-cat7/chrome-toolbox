import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  affectedPackages,
  documentationChange,
  executionChanges,
  toolingOnlyChange,
  workspacePackages,
} from './graph.ts';
import { packageChecks } from './definitions.ts';
import { contentId } from './gate.ts';
import { pnpm } from '../process.ts';
import { projectOptions, selectedPackages, verificationCases } from '../generators/options.ts';

export function ciPlan(root: string, base?: string, full = false) {
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error('CI planning requires the exact checkout commit');
  const diff =
    base && !/^0+$/u.test(base)
      ? git(['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`])
      : undefined;
  const rawChanged = diff?.status === 0 ? diff.stdout.split('\0').filter(Boolean) : undefined;
  const changed = rawChanged ? executionChanges(root, rawChanged, base) : undefined;
  const complete = full || changed === undefined;
  const packages = workspacePackages(root);
  const selected = affectedPackages(packages, complete ? undefined : changed);
  const execution = (changed ?? []).filter(
    (file) => !documentationChange(file) && !toolingOnlyChange(file),
  );
  const rootInputs =
    /^(?:(?:package\.json|pnpm[^/]*\.yaml|mise\.toml|vite\.config\.ts|tsconfig\.json|\.template\.json|\.gitignore|\.gitattributes)|tools\/(?:dev-environment|cloudflare|errors)\/|tools\/process[^/]*\.ts$)/u;
  const generator = execution.some((file) => /^tools\/generators\//u.test(file));
  const sharedGeneration =
    complete ||
    execution.some(
      (file) =>
        rootInputs.test(file) ||
        (/^tools\/generators\//u.test(file) && !file.startsWith('tools/generators/templates/')) ||
        (!file.startsWith('packages/') &&
          !file.startsWith('tools/') &&
          file !== '.github/workflows/quality.yml') ||
        (file.startsWith('tools/') &&
          !/^tools\/(?:generators|quality|dev-environment|cloudflare|errors)\//u.test(file) &&
          !/^tools\/process[^/]*\.ts$/u.test(file)),
    );
  const quality = execution.some(
    (file) => file.startsWith('tools/quality/') || /^(?:vite\.config|tsconfig)\./u.test(file),
  );
  const workflow = execution.includes('.github/workflows/quality.yml');
  const faults = complete || quality || execution.some((file) => rootInputs.test(file));
  const hooks =
    complete ||
    execution.some(
      (file) =>
        /^tools\/quality\/(?:hooks[^/]*\.ts|(?:fixture|checkout)\.ts$|git-hooks\/)/u.test(file) ||
        /^(?:tools\/dev-environment\/setup\.ts|tools\/process[^/]*\.ts|\.gitignore|\.gitattributes)$/u.test(
          file,
        ),
    );
  const lifecycle =
    complete ||
    execution.some(
      (file) =>
        /^tools\/generators\/(?!templates\/)/u.test(file) ||
        /^tools\/dev-environment\//u.test(file) ||
        /^(?:tools\/quality\/(?:fixture|checkout)\.ts)$/u.test(file) ||
        /^(?:tools\/process[^/]*\.ts|package\.json|pnpm[^/]*\.yaml|mise\.toml)$/u.test(file),
    );
  const fixtureCases = verificationCases.filter((entry) => {
    if (sharedGeneration) return true;
    if (
      (quality || workflow) &&
      ['web', 'api', 'desktop', 'fullstack', 'fullstack-desktop', 'api-bindings'].includes(
        entry.key,
      )
    )
      return true;
    const included = selectedPackages(
      projectOptions({
        name: 'ci-plan',
        scope: '@ci-plan',
        preset: entry.preset,
        features: entry.features,
      }),
    );
    return (
      generator &&
      execution.some((file) => {
        const template = /^tools\/generators\/templates\/([^/]+)\//u.exec(file)?.[1];
        return template === 'worker'
          ? included.some((name) => name === 'api' || name === 'web')
          : template !== undefined && included.includes(template);
      })
    );
  });
  // A standalone rehearsal still needs its source-free representative project.
  for (const key of [
    ...(faults ? ['web', 'api-bindings', 'desktop'] : []),
    ...(hooks || lifecycle ? ['web'] : []),
    ...(hooks ? ['desktop'] : []),
  ]) {
    const entry = verificationCases.find((value) => value.key === key)!;
    if (!fixtureCases.includes(entry)) fixtureCases.push(entry);
  }
  const native = selected.some((pkg) => pkg.runtime === 'desktop');
  const workers = selected.some((pkg) => pkg.runtime === 'worker');
  const observability =
    complete ||
    sharedGeneration ||
    (changed ?? []).some(
      (file) =>
        !documentationChange(file) &&
        !/\.test\.ts(?:\.template)?$/u.test(file) &&
        (packages.some(
          (pkg) =>
            pkg.runtime !== 'library' &&
            [
              'cloudflare.config.ts',
              'vite.config.ts',
              'package.json',
              ...(pkg.runtime === 'desktop'
                ? ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
                : []),
            ].some((input) => file === `${pkg.directory}/${input}`),
        ) ||
          /^(?:packages\/observability\/|packages\/contracts\/src\/result\.ts$|packages\/[^/]+\/src\/(?:notes|server|native|client\/notes)\.ts$|packages\/[^/]+\/src-tauri\/src\/(?:telemetry|main)\.rs$|tools\/(?:o11y|errors)\/|tools\/generators\/templates\/(?:(?:api|web|desktop)\/(?:cloudflare\.config\.ts|vite\.config\.ts|package\.json|src-tauri\/Cargo\.(?:toml|lock))\.template$|observability\/|contracts\/src\/result\.ts\.template$|worker\/notes\.ts\.template$|web\/src\/(?:server|client\/notes)\.ts\.template$|desktop\/(?:src\/native\.ts|src-tauri\/src\/(?:telemetry|main)\.rs)\.template$)|tools\/quality\/definitions\.ts$|mise\.o11y\.toml$|\.github\/workflows\/quality\.yml$)/u.test(
            file,
          )),
    );
  const nativeSignals = observability && packages.some((pkg) => pkg.runtime === 'desktop');
  const nativeRequired = native || nativeSignals;
  const fixtureNative =
    complete ||
    nativeRequired ||
    sharedGeneration ||
    faults ||
    workflow ||
    execution.some((file) => file.startsWith('tools/generators/templates/desktop/'));
  const fixturesMatrix = {
    include: [
      ...fixtureCases.map((entry) => ({ preset: entry.key, os: 'ubuntu-24.04' })),
      ...(fixtureCases.some((entry) => entry.key === 'desktop') && fixtureNative
        ? [
            { preset: 'desktop', os: 'macos-15' },
            { preset: 'desktop', os: 'windows-2025' },
          ]
        : hooks && fixtureCases.some((entry) => entry.key === 'desktop')
          ? [{ preset: 'desktop', os: 'windows-2025' }]
          : []),
    ].map((entry) => ({
      ...entry,
      native: fixtureNative && entry.preset.includes('desktop'),
      faults: faults && ['web', 'api-bindings', 'desktop'].includes(entry.preset),
      hooks:
        hooks &&
        ((entry.preset === 'web' && entry.os === 'ubuntu-24.04') ||
          (entry.preset === 'desktop' && entry.os === 'windows-2025')),
      lifecycle: lifecycle && entry.preset === 'web' && entry.os === 'ubuntu-24.04',
    })),
  };
  return {
    schema: 1,
    sha: head.stdout.trim(),
    base: base ?? null,
    contentId: contentId(root),
    changed: changed ?? null,
    rawChanged: rawChanged ?? null,
    selected: selected.map((pkg) => pkg.name),
    checks: selected.flatMap((pkg) => packageChecks(pkg, 'full').map((check) => check.id)),
    full: complete,
    fixtures: fixturesMatrix.include.length > 0,
    native: nativeRequired,
    nativeBase: nativeSignals ? 'unknown' : (base ?? 'unknown'),
    workers,
    observability,
    reason: complete
      ? 'Explicit full validation or unknown base requires the complete configuration'
      : 'Committed diff, reverse dependencies and owning infrastructure; unplanned work is not required',
    nativeMatrix: {
      include: nativeRequired
        ? [{ os: 'ubuntu-24.04' }, { os: 'macos-15' }, { os: 'windows-2025' }]
        : [],
    },
    fixturesMatrix,
  };
}

if (process.argv[1]?.endsWith(`${path.sep}ci-plan.ts`)) {
  const root = process.cwd();
  if (process.env.CI_FULL && !['true', 'false'].includes(process.env.CI_FULL))
    throw new Error('CI_FULL must be true or false');
  const plan = ciPlan(root, process.env.CI_BASE_SHA, process.env.CI_FULL === 'true');
  if (process.argv[2] === 'generate') {
    const cases = new Set(plan.fixturesMatrix.include.map((entry) => entry.preset));
    if (plan.observability) cases.add('fullstack');
    if (cases.size)
      await pnpm(
        [
          'template:verify',
          '--',
          '--generate-only',
          '--cases',
          [...cases].join(','),
          '--output',
          'generated',
        ],
        { cwd: root },
      );
  } else if (process.argv[2] === 'browsers') {
    for (const pkg of workspacePackages(root).filter(
      (pkg) => plan.selected.includes(pkg.name) && pkg.scripts['test:e2e'],
    ))
      await pnpm(
        ['--filter', pkg.name, 'exec', 'playwright', 'install', '--with-deps', 'chromium'],
        { cwd: root },
      );
  } else if (process.argv[2]) throw new Error('Expected plan (no argument), browsers or generate');
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(path.join(root, 'artifacts/ci-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries({
      fixtures: String(plan.fixtures),
      native: String(plan.native),
      workers: String(plan.workers),
      observability: String(plan.observability),
      native_base: plan.nativeBase,
      native_matrix: JSON.stringify(plan.nativeMatrix),
      fixtures_matrix: JSON.stringify(plan.fixturesMatrix),
    }))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
