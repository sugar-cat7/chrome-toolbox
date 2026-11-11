import { defineConfig } from 'vite-plus';

/** Single-file IIFE embedded into the Rust binary and injected into chat webviews. */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/reader.ts',
      formats: ['iife'],
      name: 'ChromeToolboxRelayReader',
      fileName: () => 'reader.js',
    },
    outDir: 'dist-reader',
    emptyOutDir: true,
    minify: 'esbuild',
  },
});
