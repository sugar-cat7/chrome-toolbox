import path from 'node:path';
import { once } from 'node:events';
import { workspacePackages } from '../quality/graph.ts';
import { Servers } from './servers.ts';

const root = process.cwd();
const packages = workspacePackages(root);
const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (args.length > 1 || args[0]?.startsWith('--'))
  throw new Error('Expected one application name or packages/<directory>');
const target = args[0];
const chosen = target
  ? packages.filter(
      (pkg) =>
        pkg.runtime !== 'library' &&
        (pkg.name === target ||
          pkg.directory === target ||
          path.basename(pkg.directory) === target),
    )
  : packages.filter((pkg) => pkg.runtime !== 'library');
if (!chosen.length)
  throw new Error(`No runnable application matches ${target ?? 'the selected configuration'}`);
const servers = new Servers(root);
const stop = () => {
  void servers.stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  for (const pkg of chosen) {
    if (pkg.runtime === 'worker') await servers.workers(pkg.name);
    else if (pkg.runtime === 'desktop') {
      // Tauri's own beforeDevCommand starts its renderer at the configured port.
      // Native launcher passes a worktree-local devUrl override; no other server is terminated.
      await servers.start(pkg, 'dev:renderer');
      await servers.native(pkg, [
        'dev',
        '--config',
        JSON.stringify({ build: { beforeDevCommand: '', devUrl: servers.origins.get(pkg.name) } }),
      ]);
    }
  }
  await Promise.race(
    servers.children.map((child) =>
      child.exitCode === null ? once(child, 'exit') : Promise.resolve(),
    ),
  );
  if (servers.failures.length) throw new AggregateError(servers.failures);
} catch (error) {
  if (!servers.stopping) throw error;
} finally {
  await servers.stop();
}
