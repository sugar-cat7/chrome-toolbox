import { createRequire } from 'node:module';
import { headSha } from './checkout.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { parseSync } from 'oxc-parser';
import { pnpm, runSync, spawnOwned, stopTree } from '../process.ts';
import { Servers, availablePort } from '../dev-environment/servers.ts';
import { workspacePackages, type WorkspacePackage } from './graph.ts';
import { contentId } from './gate.ts';
import { lighthouseScores } from './test-results.ts';

// The SDK-generated route manifest is derived from the application's actual route tree.
// Only parameterized routes need local fixture URLs in starter.lighthouse.routes.
export function lighthouseRoutes(tree: string, examples: Record<string, string> = {}): string[] {
  const parsed = parseSync('routeTree.gen.ts', tree);
  if (parsed.errors.length) throw new Error('Lighthouse route manifest failed to parse');
  const declarations = parsed.program.body.flatMap((entry) =>
    entry.type === 'ExportNamedDeclaration' &&
    entry.declaration?.type === 'TSInterfaceDeclaration' &&
    entry.declaration.id.name === 'FileRoutesByFullPath'
      ? [entry.declaration]
      : [],
  );
  if (declarations.length !== 1)
    throw new Error('Lighthouse requires one generated FileRoutesByFullPath interface');
  const paths = declarations[0]!.body.body.map((entry) => {
    if (
      entry.type !== 'TSPropertySignature' ||
      entry.computed ||
      entry.key.type !== 'Literal' ||
      typeof entry.key.value !== 'string'
    )
      throw new Error('Lighthouse encountered an unsupported route manifest entry');
    return entry.key.value;
  });
  if (!paths.length)
    throw new Error(
      'Lighthouse found no page routes; inspect the generated TanStack route manifest',
    );
  for (const key of Object.keys(examples))
    if (!paths.includes(key)) throw new Error(`Lighthouse example names an unknown route: ${key}`);
  return paths.map((route) => {
    // Fail closed for richer SDK route syntax rather than silently dropping pages
    // or maintaining another implementation of TanStack's route grammar.
    if (['{', '}', '[', ']'].some((character) => route.includes(character)))
      throw new Error(`Lighthouse route syntax needs an SDK fixture-matcher review: ${route}`);
    const target = examples[route] ?? route;
    if (
      target.includes('$') ||
      !target.startsWith('/') ||
      target.startsWith('//') ||
      target.includes('\\')
    )
      throw new Error(`Lighthouse route needs a local fixture URL: ${route}`);
    const url = new URL(target, 'http://localhost');
    const escaped = route
      .replace(/[.*+?^{}()|[\]\\]/gu, '\\$&')
      .replace(/\$([A-Za-z0-9_]+)?/gu, (_, name: string | undefined) => (name ? '[^/]+' : '.+'));
    if (
      url.origin !== 'http://localhost' ||
      url.hash ||
      !new RegExp(`^${escaped}$`, 'u').test(url.pathname)
    )
      throw new Error(`Lighthouse fixture does not cover route ${route}: ${target}`);
    return target;
  });
}

export function lighthousePackages(
  packages: WorkspacePackage[],
  root: string,
  cwd: string,
): WorkspacePackage[] {
  const selected = packages.filter(
    (pkg) =>
      (pkg.dependencies.includes('@tanstack/react-start') || pkg.scripts['test:lighthouse']) &&
      (cwd === root || path.join(root, pkg.directory) === cwd),
  );
  for (const pkg of selected)
    if (!pkg.scripts['test:lighthouse'])
      throw new Error(`${pkg.name} is a Web application and requires test:lighthouse`);
  return selected;
}

// Use the official Lighthouse API with a browser we own. The CLI's Chrome
// launcher creates another detached group that cannot be reaped on SIGTERM.
async function measure(
  api: {
    default: (
      url: string,
      flags: object,
      config?: unknown,
    ) => Promise<{ report: string | string[]; artifacts?: { Trace?: unknown } } | undefined>;
    desktopConfig: unknown;
  },
  browser: string,
  browserFlags: string[],
  url: string,
  profile: 'mobile' | 'desktop',
  prefix: string,
  state: string,
  cancellation: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(180_000)]);
  signal.throwIfAborted();
  const port = await availablePort();
  signal.throwIfAborted();
  const child = spawnOwned(
    browser,
    [
      ...browserFlags,
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${path.join(state, path.basename(prefix))}`,
    ],
    { stdio: 'ignore' },
  );
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  let cleanup: Promise<void> | undefined;
  const stop = () => (cleanup ??= stopTree(child, 1_000));
  const abort = () => {
    void stop().catch((error: Error) => {
      failure = error;
    });
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const started = performance.now();
    while (true) {
      signal.throwIfAborted();
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Owned Lighthouse browser exited before ready');
      if (performance.now() - started > 30_000)
        throw new Error('Owned Lighthouse browser readiness timeout');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        });
        if (
          response.ok &&
          ((await response.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl
        )
          break;
      } catch {
        /* Wait only for this owned browser. */
      }
      await pause(100, undefined, { signal });
    }
    console.log(`LIGHTHOUSE_BROWSER ${child.pid} http://127.0.0.1:${port}`);
    const result = await api.default(
      url,
      { port, output: ['json', 'html'], logLevel: 'error' },
      profile === 'desktop' ? api.desktopConfig : undefined,
    );
    signal.throwIfAborted();
    if (!result || !Array.isArray(result.report) || result.report.length !== 2)
      throw new Error('Lighthouse did not produce complete JSON and HTML reports');
    writeFileSync(`${prefix}.report.json`, result.report[0]!);
    writeFileSync(`${prefix}.report.html`, result.report[1]!);
    if (result.artifacts?.Trace)
      writeFileSync(`${prefix}.trace.json`, JSON.stringify(result.artifacts.Trace));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    await stop();
    signal.removeEventListener('abort', abort);
  }
}

async function audit(root: string, pkg: WorkspacePackage): Promise<void> {
  const cwd = path.join(root, pkg.directory);
  const packages = workspacePackages(root);
  const visited = new Set<string>();
  const cancellation = new AbortController();
  const build = async (value: WorkspacePackage): Promise<void> => {
    if (visited.has(value.name)) return;
    visited.add(value.name);
    for (const name of value.dependencies) {
      const dependency = packages.find((candidate) => candidate.name === name);
      if (dependency?.runtime === 'worker') await build(dependency);
    }
    if (!value.scripts.preview) throw new Error(`${value.name} needs a production preview script`);
    await pnpm(['--filter', value.name, 'build'], {
      cwd: root,
      signal: cancellation.signal,
      env: { ...process.env, STARTER_BUILD_MODE: 'offline' },
    });
  };
  const directory = path.join(root, 'artifacts/lighthouse', path.basename(pkg.directory));
  // Clear only this application's previous results; stale reports can never approve a run.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const before = contentId(root);
  const load = createRequire(path.join(cwd, 'package.json'));
  const chromium = (load('@playwright/test') as { chromium: { executablePath(): string } })
    .chromium;
  const browser = chromium.executablePath();
  // Match the official CLI's browser startup without using its detached launcher.
  // These SDK defaults suppress background services, not Lighthouse throttling/audits.
  const browserFlags = [
    ...(
      createRequire(load.resolve('lighthouse'))('chrome-launcher') as {
        Launcher: { defaultFlags(): string[] };
      }
    ).Launcher.defaultFlags(),
    // Lighthouse 13.5.0 cli/bin.js enables its WebMCP protocol before launch.
    '--enable-features=DevToolsWebMCPSupport',
  ];
  if (!existsSync(browser))
    throw new Error(
      `Lighthouse browser is missing; run pnpm --filter ${pkg.name} exec playwright install chromium and provision its OS prerequisites`,
    );
  const manifest = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
    starter?: { lighthouse?: { routes?: Record<string, string> } };
  };
  const state = mkdtempSync(path.join(os.tmpdir(), 'starter-lighthouse-'));
  const servers = new Servers(root, state);
  const api = (await import(pathToFileURL(load.resolve('lighthouse')).href)) as Parameters<
    typeof measure
  >[0];
  const stop = () => {
    cancellation.abort(new Error('Lighthouse validation interrupted'));
    void servers.stop(2_000).catch((error: Error) => {
      servers.failures.push(error);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const report = {
    schema: 1,
    package: pkg.name,
    sha: headSha(root) ?? 'uncommitted',
    contentId: before,
    templateOrigin:
      (JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as { origin?: unknown })
        .origin ?? null,
    os: `${process.platform}/${process.arch}`,
    node: process.version,
    lighthouse: (load('lighthouse/package.json') as { version: string }).version,
    chromium: runSync(browser, ['--version'], cwd),
    browserFlags,
    profiles: ['mobile', 'desktop'],
    runsPerPage: 3,
    origin: null as string | null,
    routes: [] as string[],
    status: 'failed' as 'failed' | 'passed',
    runs: [] as {
      route: string;
      profile: string;
      run: number;
      scores?: Record<string, number>;
      status: 'failed' | 'passed';
      json: string;
      html: string;
      error?: string;
    }[],
    error: null as string | null,
  };
  let failure: unknown;
  try {
    await build(pkg);
    report.routes = lighthouseRoutes(
      readFileSync(path.join(cwd, 'src/routeTree.gen.ts'), 'utf8'),
      manifest.starter?.lighthouse?.routes,
    );
    cancellation.signal.throwIfAborted();
    const origin = await servers.workers(pkg.name, 'preview');
    cancellation.signal.throwIfAborted();
    report.origin = origin;
    for (const [index, route] of report.routes.entries()) {
      cancellation.signal.throwIfAborted();
      const response = await fetch(new URL(route, origin), {
        redirect: 'manual',
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(180_000)]),
      });
      await response.arrayBuffer();
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html'))
        throw new Error(
          `Lighthouse requires a successful HTML page: ${route}, status ${response.status}`,
        );
      for (const profile of ['mobile', 'desktop'] as const)
        for (let count = 1; count <= 3; count++) {
          const prefix = path.join(directory, `page-${index}-${profile}-${count}`);
          const entry: (typeof report.runs)[number] = {
            route,
            profile,
            run: count,
            status: 'failed' as 'failed' | 'passed',
            json: path.relative(root, `${prefix}.report.json`),
            html: path.relative(root, `${prefix}.report.html`),
          };
          report.runs.push(entry);
          try {
            await measure(
              api,
              browser,
              browserFlags,
              new URL(route, origin).href,
              profile,
              prefix,
              state,
              cancellation.signal,
            );
            entry.scores = lighthouseScores(
              JSON.parse(readFileSync(`${prefix}.report.json`, 'utf8')) as unknown,
              profile,
            );
            if (!existsSync(`${prefix}.report.html`))
              throw new Error('Lighthouse did not produce the required HTML report');
            entry.status = 'passed';
            console.log(
              `LIGHTHOUSE ${pkg.name} ${route} ${profile} run ${count}: ${JSON.stringify(entry.scores)}`,
            );
          } catch (error) {
            entry.error = String(error);
            throw error;
          }
        }
    }
    if (servers.failures.length) throw new AggregateError(servers.failures);
    if (contentId(root) !== before)
      throw new Error(
        'Lighthouse input changed during validation; run setup/codegen before auditing',
      );
    report.status = 'passed';
  } catch (error) {
    report.error = String(error);
    failure = error;
  } finally {
    try {
      await servers.stop(2_000);
    } catch (error) {
      report.status = 'failed';
      report.error = `Lighthouse cleanup failed: ${String(error)}`;
      failure = failure === undefined ? error : new AggregateError([failure, error]);
    } finally {
      if (cancellation.signal.aborted) {
        report.status = 'failed';
        report.error ??= String(cancellation.signal.reason);
        failure ??= cancellation.signal.reason;
      }
      rmSync(state, { recursive: true, force: true });
      writeFileSync(path.join(directory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
  if (report.status !== 'passed') throw failure ?? new Error('Lighthouse validation failed');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.slice(2).some((argument) => argument !== '--'))
    throw new Error(
      'Lighthouse uses fixed official profiles and mandatory scores; no override flags are supported',
    );
  const cwd = process.cwd();
  const root = existsSync(path.join(cwd, 'pnpm-workspace.yaml')) ? cwd : path.resolve(cwd, '../..');
  if (!existsSync(path.join(root, 'pnpm-workspace.yaml')))
    throw new Error('Run Lighthouse from the workspace root or an owning application package');
  const selected = lighthousePackages(workspacePackages(root), root, cwd);
  if (!selected.length)
    console.log(
      'Lighthouse not_required: this selected configuration has no Web HTML application; Desktop/native and API checks remain separate',
    );
  for (const pkg of selected) await audit(root, pkg);
}
