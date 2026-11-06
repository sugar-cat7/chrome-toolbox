import { z } from 'zod/mini';
import {
  defineProtocol,
  llmProtocolSpec,
  type ProtocolHandlers,
} from '@chrome-toolbox/extension-core';

/** Longest selected text a `selection` command carries (spec §8); a longer one is cut. */
export const MAX_SELECTION = 2000;

/**
 * What the background asks the page script in a tab's top frame: answer that it runs (`ping`),
 * translate the page, restore its original text, or translate the selection (`text` when the
 * context menu gave it).
 */
export const pageCommandSchema = z.union([
  z.strictObject({ action: z.enum(['ping', 'translate', 'restore']) }),
  z.strictObject({
    action: z.literal('selection'),
    text: z.optional(z.string().check(z.maxLength(MAX_SELECTION))),
  }),
]);
export type PageCommand = z.infer<typeof pageCommandSchema>;
/** Background → the page script, by `tabs.sendMessage` to frame 0. */
export const pageCommandMessageSchema = z.strictObject({
  type: z.literal('page/command'),
  payload: pageCommandSchema,
});

export const pageProtocolSpec = {
  ...llmProtocolSpec,
  // The routes below answer extension pages (the popup, the options page) only; any other
  // sender gets `sender_forbidden`.
  /**
   * Translate the tab: the background injects the page script into its top frame and sends it
   * the `translate` command. `url` is the tab's URL as the popup read it (`activeTab`).
   */
  'page/start': {
    request: z.strictObject({ tabId: z.int(), url: z.optional(z.string()) }),
    response: z.strictObject({}),
  },
};
/** Popup, options page and page script → service worker. */
export const pageProtocol = defineProtocol(pageProtocolSpec);
export type PageProtocolHandlers = ProtocolHandlers<typeof pageProtocolSpec>;
