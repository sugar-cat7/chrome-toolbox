import type { KnipConfig } from 'knip';
import { workspacePackages } from './tools/quality/graph.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { walk } from './tools/generators/files.ts';

const packages = workspacePackages(process.cwd());
const workers = new Set(packages.filter((pkg) => pkg.runtime === 'worker').map((pkg) => pkg.name));

export default {
  workspaces: {
    '.': {
      entry: ['tools/**/*.{ts,mjs}'],
      project: ['tools/**/*.{ts,mjs}', '*.ts'],
      ignore: ['tools/generators/templates/**'],
    },
    ...Object.fromEntries(
      packages.map((pkg) => [
        pkg.directory,
        {
          entry: [
            'src/**/*.{ts,tsx}',
            ...(existsSync(path.join(pkg.directory, 'src')) &&
            walk(path.join(pkg.directory, 'src')).some((filename) => filename.endsWith('.css'))
              ? ['src/**/*.css']
              : []),
            ...(existsSync(path.join(pkg.directory, 'test')) ? ['test/**/*.ts'] : []),
          ],
          project: [
            'src/**/*.{ts,tsx}',
            ...(existsSync(path.join(pkg.directory, 'src')) &&
            walk(path.join(pkg.directory, 'src')).some((filename) => filename.endsWith('.css'))
              ? ['src/**/*.css']
              : []),
            '*.ts',
            ...(existsSync(path.join(pkg.directory, 'test')) ? ['test/**/*.ts'] : []),
          ],
          // Service dependencies express runtime startup order, not application imports.
          // The shared native helper invokes the WDIO CLI; WDIO resolves its local runner.
          ignoreDependencies: [
            ...pkg.dependencies.filter((name) => workers.has(name)),
            // Shared local D1/preview adapters invoke the owning Worker's Wrangler CLI.
            ...(pkg.runtime === 'worker' ? ['wrangler'] : []),
            ...(pkg.runtime === 'desktop' ? ['@wdio/cli', '@wdio/local-runner'] : []),
            // The shared Web audit loads the owning package's Lighthouse SDK.
            ...(pkg.scripts['test:lighthouse'] ? ['lighthouse'] : []),
          ],
        },
      ]),
    ),
  },
} satisfies KnipConfig;
