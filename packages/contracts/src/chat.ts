import { z } from 'zod/mini';

/** Maximum sizes of the raw fields, in UTF-16 code units. */
export const MAX_COMMENT_ID = 256;
export const MAX_COMMENT_AUTHOR = 256;
export const MAX_COMMENT_TEXT = 1000;

/** Roles reported by the page; consumers decide whether a role grants any exemption. */
export const authorRoleSchema = z.enum(['owner', 'moderator', 'verified']);
export type AuthorRole = z.infer<typeof authorRoleSchema>;

/** Counts supplementary characters as two units, matching Rust's `encode_utf16().count()`. */
const utf16Limit = (maximum: number) =>
  z.superRefine<string>((text, context) => {
    let units = 0;
    for (const character of text) {
      units += (character.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      if (units <= maximum) continue;
      context.addIssue({ code: 'too_big', origin: 'string', maximum, inclusive: true });
      break;
    }
  });

/** A raw comment read from the page; `at` is the reader's Unix time in milliseconds. */
export const rawChatCommentSchema = z.strictObject({
  id: z.string().check(z.minLength(1), utf16Limit(MAX_COMMENT_ID)),
  author: z.string().check(utf16Limit(MAX_COMMENT_AUTHOR)),
  text: z.string().check(z.minLength(1), utf16Limit(MAX_COMMENT_TEXT)),
  at: z.int().check(z.nonnegative()),
  role: z.optional(authorRoleSchema),
});
export type RawChatComment = Readonly<z.infer<typeof rawChatCommentSchema>>;
