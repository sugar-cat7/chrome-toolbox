import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/relay.ts'],
    dts: true,
    deps: { neverBundle: ['@chrome-toolbox/contracts', 'zod'] },
  },
  test: {
    include: ['src/**/*.test.ts', 'testing/**/*.test.ts', 'test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
