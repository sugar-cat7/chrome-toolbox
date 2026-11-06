import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// The root dev runner assigns a worktree-local port; WXT's own default applies otherwise.
const port = Number(process.env.STARTER_PORT ?? 3000);

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  imports: false,
  hooks: {
    // `imports: false` still registers unimport's Vite plugin, which would inject wxt/*
    // imports for free identifiers (e.g. a `storage` prop in packages/ui). Imports stay explicit.
    'config:resolved': (wxt) => {
      Object.assign(wxt.config.imports, { autoImport: false });
    },
  },
  vite: () => ({ plugins: [react(), tailwind()] }),
  // Agents and developers load dist/chrome-mv3-dev themselves (see the extension skill).
  webExt: { disabled: true },
  dev: {
    server: { host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}`, strictPort: true },
  },
  manifest: {
    name: 'コメントアシスタント',
    description: 'ライブチャットとコメントを翻訳・分類・要約します。',
    permissions: ['storage', 'sidePanel'],
    // Local llama.cpp is reachable without a prompt; LAN hosts are requested at runtime.
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: 'コメントアシスタント' },
  },
});
