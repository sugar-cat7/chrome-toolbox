import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/runtime.test.ts', 'test/**/*.runtime.test.ts'],
    passWithNoTests: false,
  },
});
