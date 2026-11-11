import { observeComments as observeChatDom } from '@chrome-toolbox/extension-core/chat-dom';
import type { ObserveHooks } from '@chrome-toolbox/extension-core/chat-dom';
import type { RawComment } from '../protocol.ts';
import type { SiteAdapter } from './types.ts';

export type { ObserveHooks } from '@chrome-toolbox/extension-core/chat-dom';

/** Observes comments with the extension's existing foreground policy and hook contract. */
export function observeComments(
  adapter: SiteAdapter,
  doc: Document,
  onBatch: (comments: RawComment[], process: boolean) => void,
  onLeave: () => void = () => undefined,
  hooks: ObserveHooks = {},
): () => void {
  return observeChatDom(adapter, doc, onBatch, onLeave, { ...hooks, mode: 'foreground' });
}
