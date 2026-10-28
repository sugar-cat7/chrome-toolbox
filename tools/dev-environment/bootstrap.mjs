// Cold start uses only Node's standard library. Node 24 executes the TS tools without a loader.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const statePath = path.join(root, '.template.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
/** @param {string} command @param {string[]} parameters */
const invoke = (command, parameters) => {
  const result = spawnSync(command, parameters, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw new Error(`${command}: ${result.error?.message ?? `exit ${result.status}`}`);
};
try {
  if (args.some((argument) => ['--target', '--dry-run', '--no-install'].includes(argument)))
    throw new Error(
      'Bootstrap runs setup in this repository; use template:init directly for --target, --dry-run or --no-install',
    );
  if (args.length && !args.includes('--reference')) {
    const { main } = await import('../generators/cli.ts');
    await main(['init', ...args, '--no-install']);
  } else if (state?.kind !== 'project' && !args.includes('--reference')) {
    throw new Error(
      'Choose a project before installing: mise run setup -- --name my-project --scope @my-team [--preset web] (maintainers: --reference)',
    );
  }
  invoke('mise', ['install', 'aqua:pnpm/pnpm@12.11.2']);
  const manager = ['exec', 'aqua:pnpm/pnpm@12.11.2', '--', 'pnpm'];
  // Initialization may have changed identity/preset while the clone still has its old lock.
  const initialized = JSON.parse(readFileSync(statePath, 'utf8'));
  invoke('mise', [
    ...manager,
    'install',
    ...(initialized.lockPending || !existsSync(path.join(root, 'pnpm-lock.yaml'))
      ? ['--no-frozen-lockfile']
      : ['--frozen-lockfile']),
  ]);
  invoke('mise', [...manager, 'env:setup']);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
