import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pnpm } from '../process.ts';

type BuildManifest = { mainModule: string; modules: Record<string, { type: string }> };

export function moduleRules(bundle: string, manifest: BuildManifest) {
  if (!manifest?.modules || !Object.keys(manifest.modules).length)
    throw new Error('Local preview requires the SDK build manifest');
  const esm: string[] = [];
  const data: string[] = [];
  const realBundle = realpathSync(bundle);
  for (const [file, module] of Object.entries(manifest.modules)) {
    if (
      path.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      file.includes('\\') ||
      !path.resolve(bundle, file).startsWith(`${path.resolve(bundle)}${path.sep}`) ||
      !existsSync(path.join(bundle, file)) ||
      !statSync(path.join(bundle, file)).isFile() ||
      !realpathSync(path.join(bundle, file)).startsWith(`${realBundle}${path.sep}`) ||
      !['esm', 'data', 'sourcemap'].includes(module.type) ||
      (module.type === 'esm' && !/\.m?js$/u.test(file)) ||
      (module.type === 'sourcemap' && !file.endsWith('.map'))
    )
      throw new Error(`Invalid, missing or unsupported SDK-built module: ${file}`);
    if (module.type === 'esm') esm.push(file);
    else if (module.type === 'data') data.push(file);
    // Source maps remain SDK metadata, never an executable/raw-data module.
  }
  if (!esm.includes(manifest.mainModule))
    throw new Error('SDK build manifest is missing its ESM main module');
  return [
    { type: 'ESModule', globs: esm, fallthrough: true },
    ...(data.length ? [{ type: 'Data', globs: data, fallthrough: true }] : []),
  ];
}

// cloudflare.config.ts -> SDK build output -> SDK Wrangler conversion.
// No authored second binding/environment configuration is maintained.
export async function preview(
  convert: (input: unknown) => unknown,
  build: {
    rootConfig: { buildContext: { mode?: string | undefined } };
    workers: {
      default: {
        config: { manifest?: BuildManifest | undefined; [key: string]: unknown };
        bundleDir: string | undefined;
        assetsDir: string | undefined;
      };
    };
  },
): Promise<void> {
  const cwd = process.cwd();
  if (build.rootConfig.buildContext.mode !== 'offline')
    throw new Error('Local production preview needs an offline build; run pnpm build first');
  // The official SDK resolves v2 partial manifests and rejects symlinked output.
  const { manifest, ...worker } = build.workers.default.config;
  const bundle = build.workers.default.bundleDir;
  if (!bundle || !manifest) throw new Error('Local preview requires the SDK build manifest');
  const rules = moduleRules(bundle, manifest);
  const config = convert({ worker, containers: [] }) as {
    assets?: Record<string, unknown>;
    [key: string]: unknown;
  };
  config.main = path.join(bundle, manifest.mainModule);
  config.base_dir = bundle;
  config.find_additional_modules = true;
  config.rules = rules;
  const assets = build.workers.default.assetsDir;
  if (assets) config.assets = { ...config.assets, directory: assets };
  const filename = path.join(cwd, '.cloudflare/preview.wrangler.json');
  writeFileSync(filename, `${JSON.stringify(config, null, 2)}\n`);
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await pnpm(
      [
        'exec',
        'wrangler',
        'dev',
        '--config',
        filename,
        '--no-bundle',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        process.env.STARTER_PORT ?? '8787',
        '--inspector-port',
        '0',
        '--persist-to',
        path.join(
          process.env.STARTER_STATE_ROOT ?? path.resolve(cwd, '../../.state'),
          path.basename(cwd),
        ),
      ],
      {
        cwd,
        timeout: 24 * 60 * 60_000,
        terminationGraceMs: 1_000,
        signal: cancellation.signal,
        env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false' },
      },
    );
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
