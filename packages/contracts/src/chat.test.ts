import { describe, expect, it } from 'vitest';
import { rawChatCommentSchema } from './index.ts';

const comment = { id: 'line-1', author: '', text: 'hello', at: 0 };

describe('raw chat comments', () => {
  it.each([
    { field: 'id', max: 256 },
    { field: 'author', max: 256 },
    { field: 'text', max: 1000 },
  ])('bounds $field by UTF-16 units, including supplementary characters', ({ field, max }) => {
    for (const value of [
      'x'.repeat(max),
      '😀'.repeat(max / 2),
      `${'x'.repeat(max - 2)}😀`,
      'e\u0301'.repeat(max / 2),
      `${'x'.repeat(max - 1)}\ud800`,
    ]) {
      expect(rawChatCommentSchema.safeParse({ ...comment, [field]: value }).success).toBe(true);
      const result = rawChatCommentSchema.safeParse({ ...comment, [field]: `${value}x` });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Oversized chat field was accepted');
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'too_big',
          origin: 'string',
          maximum: max,
          inclusive: true,
          path: [field],
        }),
      );
    }
    expect(
      rawChatCommentSchema.safeParse({ ...comment, [field]: `${'x'.repeat(max - 1)}😀` }).success,
    ).toBe(false);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an unsafe or nonnegative-integer timestamp: %s',
    (at) => {
      expect(rawChatCommentSchema.safeParse({ ...comment, at }).success).toBe(false);
    },
  );

  it('preserves data and optional roles without normalizing text', () => {
    expect(rawChatCommentSchema.parse(comment)).toEqual(comment);
    for (const role of ['owner', 'moderator', 'verified']) {
      const input = { ...comment, role, at: Number.MAX_SAFE_INTEGER, text: ' hello ' };
      expect(rawChatCommentSchema.parse(input)).toEqual(input);
    }
  });

  it.each([
    { ...comment, id: '' },
    { ...comment, text: '' },
    { ...comment, role: 'member' },
    { ...comment, held: true },
    { ...comment, extra: 'unknown' },
    { id: 'line-1', author: '', text: 'hello' },
  ])('refuses empty required fields, missing fields and unknown data: %j', (input) => {
    expect(rawChatCommentSchema.safeParse(input).success).toBe(false);
  });
});
