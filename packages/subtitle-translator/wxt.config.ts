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
    name: '配信字幕翻訳',
    description: '配信や動画の音声をローカルLLMで日本語字幕にします。',
    // tabCapture and offscreen capture the tab's audio for speech subtitles; activeTab shows the
    // captured tab's URL after the shortcut, so leaving www.youtube.com stops the capture (Task 13).
    permissions: ['storage', 'sidePanel', 'tabCapture', 'offscreen', 'activeTab'],
    // Local llama.cpp is reachable without a prompt; LAN hosts are requested at runtime.
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '配信字幕翻訳' },
    // The service worker steps the saved display (runtime.ts); every tab follows it. The audio
    // shortcut starts or stops the capture of the tab in front (sessions.ts).
    commands: {
      'cycle-display': {
        suggested_key: { default: 'Alt+Shift+J' },
        description: '字幕の表示を切り替え（日本語／併記／原語／オフ）',
      },
      'toggle-audio': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '音声で字幕を開始／停止',
      },
    },
  },
});
