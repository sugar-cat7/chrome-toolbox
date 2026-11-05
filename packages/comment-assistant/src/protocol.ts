import { z } from 'zod/mini';
import {
  commentCategorySchema,
  commentRecordSchema,
  defineProtocol,
  llmProtocolSpec,
  type ProtocolHandlers,
} from '@chrome-toolbox/extension-core';
import { MAX_STREAMER, MAX_TITLE } from './stream-context.ts';

const siteSchema = commentRecordSchema.shape.site;
/**
 * The store partition of one comment source: YouTube live chat and its replay use the video id
 * (`<videoId>`), the same video's comments `<videoId>#comments`, Twitch the channel login.
 */
const channelSchema = z.string().check(z.minLength(1), z.maxLength(256));
const partitionSchema = z.strictObject({ site: siteSchema, channel: channelSchema });

/**
 * Longest comment text the service worker takes (YouTube chat allows about 200 characters,
 * Twitch 500); the content script cuts longer text, such as video comments, to this length.
 */
export const MAX_COMMENT_TEXT = 1000;
/** Most comments one 'comments/ingest' message carries; the content script sends more in parts. */
export const MAX_INGEST_COMMENTS = 1000;
/**
 * Who posted a comment, as the page shows it: the channel's owner (streamer), a moderator or a
 * verified account (YouTube only: Twitch's verified Partner badge is no role, R41). Their posts
 * are never hidden (R38); other authors have no role.
 */
export const authorRoleSchema = z.enum(['owner', 'moderator', 'verified']);
export type AuthorRole = z.infer<typeof authorRoleSchema>;
// Caps bound what one message and the stores can hold.
export const rawCommentSchema = z.strictObject({
  id: z.string().check(z.minLength(1), z.maxLength(256)),
  author: z.string().check(z.maxLength(256)),
  text: z.string().check(z.maxLength(MAX_COMMENT_TEXT)),
  at: z.number(),
  role: z.optional(authorRoleSchema),
  /**
   * The frame keeps this comment's line out of sight until it is judged (R52). The service
   * worker takes held comments first while they can still be judged in time (R57); lines on
   * screen when the chat came back (R44) are never held.
   */
  held: z.optional(z.literal(true)),
});
/** A comment as the content script read it from the page. */
export type RawComment = Readonly<z.infer<typeof rawCommentSchema>>;

/** What decided a category: a fixed rule, the language model, or Clef (abusive only). */
export const verdictSourceSchema = z.enum(['rule', 'model', 'clef']);
export type VerdictSource = z.infer<typeof verdictSourceSchema>;

export const annotationSchema = z.strictObject({
  id: z.string(),
  translation: z.optional(z.string()),
  category: commentCategorySchema,
  state: commentRecordSchema.shape.state,
  /**
   * `'show'`: the viewer marked this hidden comment as fine ('comments/feedback' `ok`). The
   * annotation is sent again with category `chatter`, and the content script shows the comment
   * whatever its filter settings say, undoing an earlier hide or blur.
   */
  override: z.optional(z.literal('show')),
});
/** How the content script shows one comment; `skipped` and `failed` comments stay in the original. */
export type Annotation = Readonly<z.infer<typeof annotationSchema>>;
/** Background → content script, fire-and-forget to the frame that sent the comments. */
export const annotationsMessageSchema = z.strictObject({
  type: z.literal('comments/annotations'),
  payload: z.array(annotationSchema),
});

/** The viewer's verdict on a hidden comment: `ok` (it is fine, show it) or `correct` (rightly hidden). */
export const feedbackVerdictSchema = z.enum(['ok', 'correct']);
export type FeedbackVerdict = z.infer<typeof feedbackVerdictSchema>;
/**
 * A comment the pipeline hid, blurred or flagged (abusive, spam or spoiler), kept in memory so
 * the viewer can review it: the newest 200 per channel. `at` is the comment's own time.
 */
export const hiddenEntrySchema = z.strictObject({
  id: z.string(),
  site: siteSchema,
  channel: z.string(),
  text: z.string(),
  translation: z.optional(z.string()),
  category: commentCategorySchema,
  /** Clef's probability that the comment is abusive, when Clef judged it. */
  abusive: z.optional(z.number()),
  /** What decided the category (`rule`: a fixed rule such as copypasta detection). */
  source: z.optional(verdictSourceSchema),
  at: z.number(),
  /** The verdict already given; a listed comment can only have `correct` (`ok` ones are shown again). */
  verdict: z.optional(feedbackVerdictSchema),
});
export type HiddenEntry = Readonly<z.infer<typeof hiddenEntrySchema>>;

/** What a page reported about its stream: the streamer key and the title, each optional. */
const streamerSchema = z.string().check(z.minLength(1), z.maxLength(MAX_STREAMER));
const titleSchema = z.string().check(z.minLength(1), z.maxLength(MAX_TITLE));
/** One stream as the service worker knows it (`StreamContext` without the spoiler note). */
export const streamSchema = z.strictObject({
  site: siteSchema,
  /** The stream's partition: the video id on YouTube (also for its comments), the login on Twitch. */
  partition: channelSchema,
  streamer: z.optional(streamerSchema),
  title: z.optional(titleSchema),
});
/**
 * Service worker → every frame of a tab that reported a stream: the streamer and title of the
 * stream as known, so the live chat frame (which knows only its video) can use the streamer's
 * filters.
 */
export const streamInfoMessageSchema = z.strictObject({
  type: z.literal('comments/stream-info'),
  payload: streamSchema,
});
/** Service worker → extension pages: some tab's stream changed; the side panel asks again. */
export const streamChangedMessageSchema = z.strictObject({
  type: z.literal('comments/stream-changed'),
});
/** Service worker → a tab's top frame: which stream do you show? */
export const pingMessageSchema = z.strictObject({ type: z.literal('comments/ping') });
/**
 * The `type` of a message, or undefined. Every frame and extension page receives every message
 * the others send to the service worker (about 20 ingest messages a second): a listener compares
 * this first and decodes only the messages of its own types (R45).
 */
export const messageType = (message: unknown): unknown =>
  typeof message === 'object' && message !== null && 'type' in message ? message.type : undefined;
/**
 * The top frame's answer to a ping: its stream's partition with the streamer and title the
 * page shows, or `{}` when it shows no stream.
 */
export const pingReplySchema = z.strictObject({
  site: z.optional(siteSchema),
  partition: z.optional(channelSchema),
  streamer: z.optional(streamerSchema),
  title: z.optional(titleSchema),
});
export type PingReply = z.infer<typeof pingReplySchema>;

/** The summary windows the side panel offers, in minutes. */
export const SUMMARY_WINDOWS = [5, 15, 30] as const;
export const summaryWindowSchema = z.literal(SUMMARY_WINDOWS);
export type SummaryWindow = z.infer<typeof summaryWindowSchema>;
const countSchema = z.int().check(z.nonnegative());
/**
 * A summary of a partition's chat over the last `windowMinutes`. `total` (every stored comment),
 * `languages` (most comments first), `from` (the oldest comment read: later than the window
 * start when the store limit of 5,000 comments cut it short), `peaks` (the three busiest minutes
 * without abusive or spam comments, in time order, `minute` being the minute's start) and
 * `important` (newest first, each text once) are counted from the stored comments. `topics`,
 * merged `questions` and the peaks' `label` come from the model when it answered; a question's
 * `count` is always the number of comments it stands for. `unprocessed`: comments of the window
 * read while their chat was not in front of the viewer, counted in `total` and the peaks but
 * neither translated nor classified (R44). `modelFailed`: the model was asked but failed or
 * answered nothing usable, so only the counted parts are there.
 */
export const summarySchema = z.strictObject({
  windowMinutes: summaryWindowSchema,
  total: countSchema,
  languages: z.array(z.string()),
  from: z.number(),
  generatedAt: z.number(),
  topics: z.array(z.string()).check(z.maxLength(4)),
  questions: z
    .array(z.strictObject({ text: z.string(), count: countSchema }))
    .check(z.maxLength(5)),
  peaks: z
    .array(
      z.strictObject({ minute: z.number(), count: countSchema, label: z.optional(z.string()) }),
    )
    .check(z.maxLength(3)),
  important: z
    .array(z.strictObject({ author: z.string(), text: z.string(), at: z.number() }))
    .check(z.maxLength(5)),
  unprocessed: countSchema,
  modelFailed: z.optional(z.literal(true)),
});
export type Summary = Readonly<z.infer<typeof summarySchema>>;

export const commentStatsSchema = z.strictObject({
  /** The channel's comments in the store (the last 30 minutes, at most 5,000). */
  records: countSchema,
  /**
   * Comments only stored, without the model or Clef (R44): read while their chat was not in
   * front of the viewer (a hidden tab or minimized window, a chat closed or off screen), or
   * waiting when it left. One processed later (on screen when the chat came back) no longer
   * counts (R50).
   */
  stored: countSchema,
  pending: countSchema,
  /**
   * Waiting comments given up and shown in the original: the oldest beyond 200 waiting, or the
   * waiting ones of a channel evicted for another.
   */
  dropped: countSchema,
  /**
   * Comments only to be stored (R44) that were not stored because every kept channel had
   * comments waiting for the model or was processed in the last minute (R53, R55).
   */
  unstored: countSchema,
  failed: countSchema,
  /** Answered from the text cache of earlier replies, without the model or Clef. */
  cached: countSchema,
  /**
   * Stock reactions (`lol`, `www`, `888` …), emotes and laughter (`KEKW`, `hahaha`) and
   * copypasta answered by rule, without the model or Clef. A viewer's copypasta with an abuse
   * cue goes to the model and Clef instead (R53) and is not counted here.
   */
  trivial: countSchema,
  /** Waited over 8 s without reaching the model and stayed in the original. */
  expired: countSchema,
  /**
   * Batch comments not asked of Clef while Clef judges abuse: no abuse cue and no abusive model
   * verdict (R43), a failed model line included. Rule and text cache answers count under
   * `trivial` and `cached`.
   */
  clefSkipped: countSchema,
  /** The abusive judge in use: Clef, or the LLM category after Clef proved unavailable. */
  judge: z.enum(['clef', 'llm']),
  /**
   * The median (nearest rank) time from a comment's arrival to its first annotation over the
   * channel's latest 200 comments that entered the model queue (a translation, a failed line,
   * a cache answer after waiting, or the original after expiry or a drop), measured in the
   * pipeline; rule and immediate cache answers do not count. A comment stored first counts from
   * when it was processed. Absent until one was answered (R53, R55).
   */
  latencyP50Ms: z.optional(z.number().check(z.nonnegative())),
  /** Error code of the latest failed LLM batch; cleared by the next successful one. */
  lastError: z.optional(z.string()),
  /**
   * Error code of the latest failed Clef request; cleared by the next successful one. A Clef
   * error never fails a batch: its comments keep the model's category (R53). `clef_unavailable`
   * stays once Clef proved unavailable (`judge` is then `llm`).
   */
  judgeError: z.optional(z.string()),
  /**
   * Error code while the saved feedback cannot be read: verdicts then last for this session
   * only and are saved once a later read succeeds.
   */
  feedbackError: z.optional(z.string()),
});
export type CommentStats = z.infer<typeof commentStatsSchema>;

export const commentProtocolSpec = {
  ...llmProtocolSpec,
  'comments/ingest': {
    request: z.strictObject({
      site: siteSchema,
      channel: channelSchema,
      /**
       * The stream's streamer and title as the frame knows them (from the page, or as the
       * service worker told it): a restarted service worker learns the stream again from here.
       */
      streamer: z.optional(streamerSchema),
      title: z.optional(titleSchema),
      /**
       * `false`: the comments are only stored, without the model or Clef (R44): the chat is not
       * in front of the viewer, or they are above or below what it shows. `true` (the default)
       * processes them, also ones stored earlier.
       */
      process: z.optional(z.boolean()),
      /**
       * The frame's chat just left the viewer (R49): the channel's comments still waiting for
       * the model that no other frame shows are stored instead. Sent once, without comments.
       */
      left: z.optional(z.boolean()),
      comments: z.array(rawCommentSchema).check(z.maxLength(MAX_INGEST_COMMENTS)),
    }),
    /**
     * `lastError`: the latest batch of the model failed (as in 'comments/stats'), so the frame
     * lets new lines in without waiting for their judgement until a reply without it (R52).
     */
    response: z.strictObject({
      accepted: countSchema,
      dropped: countSchema,
      lastError: z.optional(z.string()),
    }),
  },
  'comments/stats': { request: partitionSchema, response: commentStatsSchema },
  /**
   * A content script's frame reports its stream: on load, after a navigation and when the page
   * shows new metadata. The live chat frame sends only its partition; the watch page and Twitch
   * add the streamer and title. Without a partition the tab's top frame left its stream (YouTube
   * home after a watch page, Twitch's directory). Content scripts only (the sender's tab and
   * frame matter).
   */
  'comments/context': {
    request: z.strictObject({
      site: siteSchema,
      partition: z.optional(channelSchema),
      streamer: z.optional(streamerSchema),
      title: z.optional(titleSchema),
    }),
    response: z.strictObject({}),
  },
  // The routes below answer extension pages (the side panel) only; a content script, whose
  // sender is a web page, gets `sender_forbidden`.
  /**
   * The stream the tab shows: its top frame names the partition, the service worker adds what
   * the pages reported (streamer, title). `{}` when the tab shows no stream or has no content
   * script.
   */
  'comments/stream': {
    request: z.strictObject({ tabId: z.int().check(z.nonnegative()) }),
    response: z.strictObject({ stream: z.optional(streamSchema) }),
  },
  /** The channel's hidden comments, oldest first. */
  'comments/hidden': { request: partitionSchema, response: z.array(hiddenEntrySchema) },
  /**
   * A summary of the partition's chat over the last 5, 15 or 30 minutes. The side panel asks
   * for it by hand and, while it is visible with auto refresh on, every 2 minutes (R35). The
   * model's parts may be missing: the counted parts come back whether or not llama.cpp answered.
   */
  'comments/summary': {
    request: z.extend(partitionSchema, { windowMinutes: summaryWindowSchema }),
    response: summarySchema,
  },
  /**
   * The viewer's verdict on one hidden comment. `ok` also sends the frames that show it, and
   * every other hidden copy of its text in the channel, an annotation with `override: 'show'`,
   * keeps the text visible in the channel from then on and lets the channel's prompts and
   * abuse threshold learn from it. The first verdict on a comment wins: a later one changes
   * nothing and gets the first one's answer. The verdict is in effect at once; `persisted:
   * false` means it is not in extension storage yet (the write failed, or the saved verdicts
   * could not be read) and the next successful write saves it.
   */
  'comments/feedback': {
    request: z.extend(partitionSchema, {
      id: rawCommentSchema.shape.id,
      verdict: feedbackVerdictSchema,
    }),
    response: z.strictObject({ persisted: z.boolean() }),
  },
  /** Every saved verdict as JSONL (text, translation, category, Clef probability, verdict, time). */
  'comments/export': {
    request: z.strictObject({}),
    response: z.strictObject({ jsonl: z.string() }),
  },
  /** Forgets every verdict (and so every allowlist and raised threshold), in memory and storage. */
  'comments/feedback/clear': {
    request: z.strictObject({}),
    response: z.strictObject({}),
  },
};
/** Content script and side panel → service worker. */
export const commentProtocol = defineProtocol(commentProtocolSpec);
export type CommentProtocolHandlers = ProtocolHandlers<typeof commentProtocolSpec>;
