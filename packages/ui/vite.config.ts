import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.tsx'],
    dts: true,
    deps: { neverBundle: ['react', '@starter/contracts'] },
  },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom', passWithNoTests: false },
});
