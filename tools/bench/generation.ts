import { commentReplyBudget, streamCategories } from '@chrome-toolbox/extension-core';

/**
 * Fixed generation settings for every translation request a bench sends. They are written to
 * the meta record of each results file, so two runs are comparable only when these match.
 */
export const GENERATION = {
  /** Greedy decoding, so a rerun on the same build and model gives the same text. */
  temperature: 0,
  /**
   * Non-thinking replies. A template that ignores `enable_thinking` still thinks: use a
   * non-thinking model variant or start llama-server with `--reasoning-budget 0`.
   */
  templateKwargs: { enable_thinking: false },
  /**
   * Token budgets; a reply cut by the budget fails to decode and is counted as a failure. A
   * comment batch gets `commentBatchMaxTokens`: a compact line per comment plus, for a
   * translated one, 3 tokens per character its grammar allows the translation (R46).
   */
  maxTokens: { subtitle: 256, comment: commentReplyBudget, judge: 16 },
} as const;

/**
 * The stream a comment-batch bench poses as: genre `other` with the categories it has on
 * (relay, privacy, sensitive, R62), as every real batch of a stream not yet classified, so the
 * user turn is as long as the extension's.
 */
export const BENCH_STREAM = {
  genre: 'other',
  categories: streamCategories({ genre: 'other', relaxations: [], spoilerTargets: false }),
} as const;
