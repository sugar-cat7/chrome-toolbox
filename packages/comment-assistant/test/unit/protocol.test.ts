import { describe, expect, it } from 'vitest';
import { MAX_COMMENT_TEXT, rawCommentSchema } from '../../src/protocol.ts';

describe('raw comment protocol compatibility', () => {
  it('keeps empty emoji-only text, numeric reader times and extension hold metadata', () => {
    const input = { id: 'line', author: '', text: '', at: -0.5, held: true };
    expect(rawCommentSchema.parse(input)).toEqual(input);
  });

  it('keeps the existing code-point limits at the extension message boundary', () => {
    const input = {
      id: '😀'.repeat(256),
      author: '😀'.repeat(256),
      text: '😀'.repeat(MAX_COMMENT_TEXT),
      at: 0,
      role: 'moderator',
    };
    expect(rawCommentSchema.parse(input)).toEqual(input);
    expect(rawCommentSchema.safeParse({ ...input, text: `${input.text}x` }).success).toBe(false);
    expect(rawCommentSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
  });
});
