import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: Number(process.env.STARTER_PORT ?? 5174), strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
