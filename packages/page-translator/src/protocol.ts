import { z } from 'zod/mini';
import {
  defineProtocol,
  llmProtocolSpec,
  type PageToken,
  type ProtocolHandlers,
} from '@chrome-toolbox/extension-core';

/**
 * How a translated page shows the translation: `replace` writes it into the text nodes (the
 * default), `pair` keeps the text and shows the translation under each paragraph.
 */
export const DISPLAY_MODES = ['replace', 'pair'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** The port the popup opens to a tab's page script (`tabs.connect`) to follow its progress. */
export const PROGRESS_PORT = 'page-progress';

/**
 * What the page script asks the background to translate: the page's paragraphs (`page`, one
 * batch at a time) or the selected text (`selection`, the bubble). `id` tells the units apart in
 * the reply; `page` is context for the model.
 */
export type TranslateRequest = {
  purpose: 'page' | 'selection';
  units: { id: number; tokens: PageToken[] }[];
  page: { title: string; site: string };
};
/**
 * The background's answer: the translation of each unit's text tokens (`readPagePieces`), with
 * no `pieces` for a unit that could not be read back, which fails alone (P21); the model that
 * translated, and `plamo_missing` when PLaMo was chosen but the server has none.
 */
export type TranslateReply = {
  results: { id: number; pieces?: string[] }[];
  translator: 'gemma' | 'plamo';
  notice?: 'plamo_missing';
};

const count = z.int().check(z.minimum(0));
/**
 * How a tab's translation goes, for the popup. Counts are paragraphs (`waiting`: units waiting
 * or asked for); `tracked` is how many paragraphs hold or will hold their original text, and
 * `limit` that new paragraphs were left untranslated at `PAGE_LIMITS.tracked`. `notice` tells
 * why paragraphs stay original (`unreachable`) or that Gemma stands in for PLaMo.
 */
export const progressSchema = z.strictObject({
  state: z.enum(['idle', 'on', 'restoring', 'restored']),
  mode: z.enum(DISPLAY_MODES),
  found: count,
  done: count,
  waiting: count,
  failed: count,
  tracked: count,
  cached: count,
  limit: z.boolean(),
  notice: z.optional(z.enum(['unreachable', 'plamo_missing'])),
  translator: z.optional(z.enum(['gemma', 'plamo'])),
});
export type Progress = z.infer<typeof progressSchema>;

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
