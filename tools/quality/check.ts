import { pnpm } from '../process.ts';
import { structure } from './structure.ts';
import { documentation } from './documentation.ts';
import { checkGeneratedErrors } from '../errors/generate.ts';
import { workspacePackages } from './graph.ts';

await pnpm(['exec', 'vp', 'check'], {
  cwd: process.cwd(),
  env: { ...process.env, STARTER_CHECK_PHASE: 'quality' },
  timeout: 180_000,
});
const errors = [
  ...structure(process.cwd()),
  ...documentation(process.cwd()),
  ...checkGeneratedErrors(
    process.cwd(),
    workspacePackages(process.cwd()).filter((pkg) => pkg.runtime !== 'desktop'),
  ),
];
if (errors.length) throw new Error(errors.join('\n'));
await pnpm(['exec', 'knip', '--include', 'dependencies,unlisted', '--no-progress'], {
  cwd: process.cwd(),
  timeout: 180_000,
});
console.log('Static quality, runtime boundaries and documentation passed');
