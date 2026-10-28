import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pnpm, run } from '../process.ts';
import { workspacePackages } from '../quality/graph.ts';
import { prepareDatabase } from '../cloudflare/database.ts';
import { installHooks } from '../quality/hooks.ts';
import { finalizeManaged } from '../generators/format.ts';
import { digest } from '../generators/files.ts';
import { writeGeneratedErrors } from '../errors/generate.ts';

const root = process.cwd();
const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (args.some((argument) => argument !== '--javascript'))
  throw new Error('Expected only --javascript (CI renderer/runtime preparation)');
const javascript = args.includes('--javascript');
const statePath = path.join(root, '.template.json');
const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
  lockPending?: boolean;
  lockId?: string;
};
await pnpm(['install', state.lockPending ? '--no-frozen-lockfile' : '--frozen-lockfile'], {
  cwd: root,
});
if (state.lockPending || !state.lockId) {
  state.lockPending = false;
  state.lockId = digest(readFileSync(path.join(root, 'pnpm-lock.yaml')));
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await pnpm(['install', '--frozen-lockfile'], { cwd: root });
}
finalizeManaged(root);
for (const pkg of workspacePackages(root)) {
  const cwd = path.join(root, pkg.directory);
  if (pkg.runtime === 'worker') {
    await pnpm(['--filter', pkg.name, 'typegen'], { cwd: root });
    // Codegen/build is a preparation step; check/gates never write source files.
    await pnpm(['--filter', pkg.name, 'build'], { cwd: root });
    await prepareDatabase(cwd);
  }
  if (pkg.runtime === 'desktop' && !javascript) {
    await pnpm(
      ['--filter', pkg.name, 'exec', 'tauri', 'icon', 'icon.svg', '--output', 'src-tauri/icons'],
      { cwd: root },
    );
    if (!existsSync(path.join(cwd, 'src-tauri/rust-toolchain.toml')))
      throw new Error(`Missing native toolchain: ${pkg.name}`);
    await run('rustup', ['show', 'active-toolchain'], {
      cwd: path.join(cwd, 'src-tauri'),
      timeout: 10 * 60_000,
    });
  }
}
if (!javascript || !workspacePackages(root).some((pkg) => pkg.runtime === 'desktop'))
  writeGeneratedErrors(root, true);
installHooks(root);
