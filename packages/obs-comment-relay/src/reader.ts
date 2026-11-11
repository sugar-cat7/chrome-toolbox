import { invoke } from '@tauri-apps/api/core';
import { launch } from '@chrome-toolbox/contracts';
import {
  createTwitchChat,
  observeComments,
  youtubeLiveChat,
  type ChatDomAdapter,
} from '@chrome-toolbox/extension-core/chat-dom';

/**
 * Reader IIFE injected into the app-owned chat webview. Rust embeds the source session id as
 * `window.__RELAY_SOURCE_SESSION__`; every batch is schema-checked again on the Rust side.
 */

declare global {
  interface Window {
    __RELAY_SOURCE_SESSION__?: string;
  }
}

const MAX_BATCH = 16;

function adapterFor(url: URL): ChatDomAdapter | undefined {
  if (youtubeLiveChat.matches(url)) return youtubeLiveChat;
  const twitch = createTwitchChat(crypto.randomUUID());
  return twitch.matches(url) ? twitch : undefined;
}

function send(input: Record<string, unknown>): void {
  launch(
    async () => {
      await invoke('chat_ingest', { input });
    },
    () => undefined,
  );
}

function state(adapter: ChatDomAdapter, sessionId: string, state: string): void {
  const channel = adapter.channel(document);
  if (!channel) return;
  send({
    kind: 'state',
    v: 1,
    sourceSessionId: sessionId,
    batchId: crypto.randomUUID(),
    site: adapter.site,
    channel,
    state,
  });
}

const sessionId = window.__RELAY_SOURCE_SESSION__;
if (sessionId) {
  const adapter = adapterFor(new URL(window.location.href));
  if (adapter) {
    observeComments(
      adapter,
      document,
      (comments) => {
        const channel = adapter.channel(document);
        if (!channel) return;
        for (let start = 0; start < comments.length; start += MAX_BATCH) {
          send({
            kind: 'comments',
            v: 1,
            sourceSessionId: sessionId,
            batchId: crypto.randomUUID(),
            site: adapter.site,
            channel,
            comments: comments.slice(start, start + MAX_BATCH),
          });
        }
      },
      () => undefined,
      {
        mode: 'background',
        onContainer: (container) => {
          if (container) state(adapter, sessionId, 'reading');
        },
      },
    );
  }
}
