import { defineConfig } from 'vite-plus';
import { workspacePackages } from './tools/quality/graph.ts';

const ownedBuilds = workspacePackages(process.cwd()).flatMap((pkg) => [
  `${pkg.directory}/dist/**`,
  `${pkg.directory}/.cloudflare/**`,
  `${pkg.directory}/.wrangler/**`,
  `${pkg.directory}/src/routeTree.gen.ts`,
  ...(pkg.runtime === 'desktop'
    ? [`${pkg.directory}/src-tauri/target/**`, `${pkg.directory}/src-tauri/gen/**`]
    : []),
]);

export default defineConfig({
  lint: {
    categories: { correctness: 'error' },
    options: {
      typeAware: process.env.STARTER_CHECK_PHASE !== 'index',
      typeCheck: process.env.STARTER_CHECK_PHASE !== 'index',
    },
    plugins: ['typescript', 'react', 'import', 'vitest', 'promise', 'jsx-a11y'],
    rules: {
      'no-debugger': 'error',
      'no-empty': 'error',
      'no-unsafe-finally': 'error',
      'no-async-promise-executor': 'error',
      eqeqeq: 'error',
      'typescript/no-floating-promises':
        process.env.STARTER_CHECK_PHASE === 'index' ? 'off' : ['error', { ignoreVoid: false }],
      'typescript/no-misused-promises':
        process.env.STARTER_CHECK_PHASE === 'index' ? 'off' : 'error',
      'typescript/switch-exhaustiveness-check':
        process.env.STARTER_CHECK_PHASE === 'index' ? 'off' : 'error',
      'react/rules-of-hooks': 'error',
      'react/exhaustive-deps': 'error',
      'react/jsx-key': 'error',
      'react/no-array-index-key': 'error',
      'react/no-unstable-nested-components': 'error',
      'vitest/no-commented-out-tests': 'error',
      'promise/no-return-wrap': 'error',
      'promise/no-new-statics': 'error',
      'typescript/no-explicit-any': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
    },
    ignorePatterns: ['**/node_modules/**', ...ownedBuilds],
  },
  fmt: {
    singleQuote: true,
    ignorePatterns: [
      '**/node_modules/**',
      ...ownedBuilds,
      'artifacts/**',
      // Machine-generated ownership hashes are validated by template checks.
      '.template.json',
    ],
  },
  test: {
    include: ['tools/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
