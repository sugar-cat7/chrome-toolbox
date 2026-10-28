import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { availablePort, stopTree } from '../dev-environment/servers.ts';
import { spawnOwned, pnpm, run } from '../process.ts';
import { nativeCases, rustCases } from './test-results.ts';
import { headSha } from './checkout.ts';
import { contentId } from './gate.ts';
import { checkGeneratedErrors } from '../errors/generate.ts';
import { workspacePackages } from './graph.ts';

const cwd = process.cwd();
const root = path.resolve(cwd, '../..');
const native = path.join(cwd, 'src-tauri');
const cargo = readFileSync(path.join(native, 'Cargo.toml'), 'utf8');
const name = /^name = "([^"]+)"/mu.exec(cargo)?.[1];
if (!name) throw new Error('Cargo package name missing');
const operation = process.argv[2];
const generatedDrift = checkGeneratedErrors(
  root,
  workspacePackages(root).filter((pkg) => path.resolve(root, pkg.directory) === cwd),
);
if (generatedDrift.length) throw new Error(generatedDrift.join('\n'));
const target = path.join(
  root,
  '.state',
  path.basename(cwd),
  `target-${operation === 'e2e' ? 'e2e' : 'release'}`,
);
const binary = path.join(target, 'release', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const environment = { ...process.env, CARGO_TARGET_DIR: target };
const testTimeout = Math.min(30 * 60000, Number(process.env.STARTER_TEST_TIMEOUT_MS ?? 30 * 60000));
if (!Number.isFinite(testTimeout) || testTimeout <= 0)
  throw new Error(
    'STARTER_TEST_TIMEOUT_MS must be positive and cannot extend the standard timeout',
  );
if (
  process.platform === 'linux' &&
  ['e2e', 'release'].includes(operation ?? '') &&
  !process.env.DISPLAY
)
  throw new Error(
    'Native Linux validation requires a real display (CI uses Xvfb); renderer-only tests are separate',
  );
if (operation === 'rust') {
  await run('cargo', ['fmt', '--', '--check'], { cwd: native });
  await run('cargo', ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'], {
    cwd: native,
    env: environment,
    timeout: 30 * 60_000,
  });
  const output = await run('cargo', ['test', '--locked'], {
    cwd: native,
    env: environment,
    timeout: testTimeout,
    capture: true,
  });
  console.log(`Executed ${rustCases(output)} Rust cases`);
} else if (operation === 'e2e') {
  await pnpm(
    [
      'exec',
      'tauri',
      'build',
      '--no-bundle',
      '--features',
      'e2e',
      '--config',
      'src-tauri/tauri.e2e.conf.json',
      '--config',
      JSON.stringify({ build: { beforeBuildCommand: 'pnpm build:renderer --mode e2e' } }),
      '--',
      '--locked',
    ],
    { cwd, env: environment, timeout: 30 * 60_000 },
  );
  const owned = path.join(root, 'artifacts', `native-${process.platform}`);
  mkdirSync(owned, { recursive: true });
  for (const scenario of ['save', 'cancel', 'error']) {
    const reportDirectory = path.join(owned, scenario);
    rmSync(reportDirectory, { recursive: true, force: true });
    mkdirSync(reportDirectory, { recursive: true });
    const telemetryDirectory = path.join(reportDirectory, 'telemetry');
    mkdirSync(telemetryDirectory, { mode: 0o700 });
    const runId = `native-${process.platform}-${scenario}-${headSha(root) ?? 'local'}`;
    const savePath =
      scenario === 'cancel'
        ? 'cancel'
        : scenario === 'error'
          ? path.join(owned, 'missing', 'notes.json')
          : path.join(owned, 'notes.json');
    await pnpm(['exec', 'wdio', 'run', 'wdio.conf.ts'], {
      cwd,
      timeout: 180_000,
      env: {
        ...environment,
        STARTER_NATIVE_BINARY: binary,
        STARTER_DRIVER_PORT: String(await availablePort()),
        STARTER_TEST_SAVE_PATH: savePath,
        STARTER_EXPORT_CASE: scenario,
        STARTER_NATIVE_REPORT_DIR: reportDirectory,
        STARTER_OTEL_NATIVE_DIR: telemetryDirectory,
        STARTER_OTEL_RUN_ID: runId,
        STARTER_OTEL_VERSION: headSha(root) ?? 'local',
      },
    });
    const cases = nativeCases(
      readdirSync(reportDirectory)
        .filter((filename) => filename.endsWith('.json'))
        .map(
          (filename) =>
            JSON.parse(readFileSync(path.join(reportDirectory, filename), 'utf8')) as unknown,
        ),
    );
    const telemetry = Object.fromEntries(
      ['traces', 'logs', 'metrics'].map((signal) => {
        const lines = readFileSync(path.join(telemetryDirectory, `native.${signal}.jsonl`), 'utf8')
          .trim()
          .split('\n');
        if (!lines.length) throw new Error(`Native ${signal} were not emitted`);
        const payloads = lines.map((line) => JSON.parse(line) as unknown);
        const text = JSON.stringify(payloads);
        if (
          !text.includes(runId) ||
          !text.includes('notes.add') ||
          !text.includes('notes.export') ||
          text.includes('Native note') ||
          text.includes('notes.json')
        )
          throw new Error(
            `Native ${signal} are missing correlation or contain private application data`,
          );
        if (signal !== 'metrics' && !text.includes('app.diagnostic.id'))
          throw new Error(`Native ${signal} did not record the expected input failure`);
        return [signal, { records: lines.length }];
      }),
    );
    writeFileSync(
      path.join(reportDirectory, 'verified.json'),
      `${JSON.stringify({ scenario, cases, os: process.platform, binary, runId, sha: headSha(root), contentId: contentId(root), telemetry }, null, 2)}\n`,
    );
    console.log(`Executed ${cases} real native cases (${scenario})`);
  }
} else if (operation === 'build') {
  await pnpm(['exec', 'tauri', 'build', '--no-bundle', '--', '--locked'], {
    cwd,
    env: environment,
    timeout: 30 * 60_000,
  });
} else if (operation === 'release') {
  // Separate target and renderer mode prevent reusing feature-enabled artifacts.
  await pnpm(['exec', 'tauri', 'build', '--no-bundle', '--', '--locked'], {
    cwd,
    env: environment,
    timeout: 30 * 60_000,
  });
  const tree = await run('cargo', ['tree', '--locked', '-e', 'normal'], {
    cwd: native,
    env: environment,
    capture: true,
    timeout: 60000,
  });
  if (tree.includes('tauri-plugin-wdio'))
    throw new Error('WebDriver dependency leaked into release graph');
  const config = JSON.parse(readFileSync(path.join(native, 'tauri.conf.json'), 'utf8')) as {
    app: { withGlobalTauri: boolean; security: { capabilities: unknown[] } };
  };
  if (
    config.app.withGlobalTauri ||
    JSON.stringify(config.app.security.capabilities).includes('wdio')
  )
    throw new Error('WebDriver permission leaked into release config');
  const assets = path.join(cwd, 'dist/assets');
  const { walk } = await import('../generators/files.ts');
  for (const filename of walk(assets).filter((value) => value.endsWith('.js')))
    if (/__wdio|wdio:|plugin:wdio/u.test(readFileSync(path.join(assets, filename), 'utf8')))
      throw new Error('WebDriver frontend leaked into release bundle');
  const port = await availablePort();
  const child = spawnOwned(binary, [], {
    cwd,
    env: { ...environment, TAURI_WEBDRIVER_PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let passed = false;
  try {
    while (!output.includes('NATIVE_READY') && performance.now() - start < 30_000) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Release exited before startup: ${output}`);
      await pause(100);
    }
    if (!output.includes('NATIVE_READY'))
      throw new Error(`Release native startup timeout: ${output}`);
    await pause(1_000);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Release crashed after startup: ${output}`);
    let reachable = false;
    try {
      await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1_000) });
      reachable = true;
    } catch {
      /* Feature-off release must have no driver listener. */
    }
    if (reachable) throw new Error('WebDriver server enabled in release');
    passed = true;
    console.log(`Release native startup passed on ${process.platform}; WebDriver disabled`);
  } finally {
    try {
      const evidence = path.join(root, 'artifacts', `native-${process.platform}`);
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        path.join(evidence, 'release-startup.json'),
        `${JSON.stringify(
          {
            os: process.platform,
            binary,
            startedAt,
            durationMs: performance.now() - start,
            startupPassed: passed,
            nativeReady: output.includes('NATIVE_READY'),
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            display: process.env.DISPLAY ?? null,
            sessionBusConfigured: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
            output: output.slice(-16_000),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await stopTree(child);
    }
  }
} else throw new Error('Expected rust|e2e|release|build');
// Cleanup is limited to our test export; caches remain owned by this worktree.
if (
  operation === 'e2e' &&
  existsSync(path.join(root, 'artifacts', `native-${process.platform}`, 'notes.json'))
)
  rmSync(path.join(root, 'artifacts', `native-${process.platform}`, 'notes.json'));
