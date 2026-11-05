import { defineConfig } from 'vite-plus';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // Explicit root: tools such as knip evaluate this config from the repository root.
  plugins: [WxtVitest({ root: import.meta.dirname })],
  test: { include: ['test/unit/**/*.test.{ts,tsx}'], passWithNoTests: false },
});
