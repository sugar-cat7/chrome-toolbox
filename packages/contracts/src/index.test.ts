import { describe, expect, it } from 'vitest';
import { noteInput, noteSchema, notesSchema } from './index';

describe('portable communication schemas', () => {
  it('normalizes user text and refuses missing, empty, extra and oversized input', () => {
    expect(noteInput.parse({ text: '  a note  ' })).toEqual({ text: 'a note' });
    expect(noteInput.parse({ text: '\uFEFFa note\uFEFF' })).toEqual({ text: 'a note' });
    expect(noteInput.parse({ text: '\u0085' })).toEqual({ text: '\u0085' });
    expect(noteInput.parse({ text: '\uFEFF\u0085note\u0085\uFEFF' })).toEqual({
      text: '\u0085note\u0085',
    });
    for (const input of [
      {},
      { text: '' },
      { text: '   ' },
      { text: '\uFEFF' },
      { text: 'x'.repeat(1001) },
      { text: 'valid', path: '/tmp/file' },
    ]) {
      expect(noteInput.safeParse(input).success).toBe(false);
    }
  });
  it('checks identifiers and time without relying on a platform SDK', () => {
    expect(noteSchema.safeParse({ id: 'not-a-uuid', text: 'note', createdAt: 1 }).success).toBe(
      false,
    );
    expect(
      noteSchema.parse({ id: '993a848f-d07f-43a2-85f8-333b05292ed4', text: 'note', createdAt: 1 })
        .text,
    ).toBe('note');
  });
  it('preserves maximum text, strict data and safe nonnegative integer time boundaries', () => {
    expect(noteInput.parse({ text: ` ${'x'.repeat(1000)} ` }).text).toHaveLength(1000);
    const note = { id: '993a848f-d07f-43a2-85f8-333b05292ed4', text: 'note', createdAt: 0 };
    expect(noteSchema.parse(note)).toEqual(note);
    for (const createdAt of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(noteSchema.safeParse({ ...note, createdAt }).success).toBe(false);
    expect(noteSchema.safeParse({ ...note, unexpected: true }).success).toBe(false);
  });
  it('limits UTF-16 units after trimming, including supplementary characters', () => {
    const note = { id: '993a848f-d07f-43a2-85f8-333b05292ed4', createdAt: 0 };
    for (const text of ['😀'.repeat(500), `${'x'.repeat(998)}😀`, 'e\u0301'.repeat(500)]) {
      expect(text.length).toBe(1000);
      expect(noteInput.parse({ text: `\uFEFF ${text} \uFEFF` }).text).toBe(text);
      expect(noteSchema.parse({ ...note, text }).text).toBe(text);
      expect(notesSchema.parse([{ ...note, text }])[0]?.text).toBe(text);
    }
    for (const text of ['😀'.repeat(501), `${'😀'.repeat(500)}x`, `${'x'.repeat(999)}😀`]) {
      expect(notesSchema.safeParse([{ ...note, text }]).success).toBe(false);
      for (const result of [
        noteInput.safeParse({ text: `\uFEFF${text}\uFEFF` }),
        noteSchema.safeParse({ ...note, text }),
      ]) {
        expect(result.success).toBe(false);
        if (result.success) throw new Error('Oversized supplementary text was accepted');
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            code: 'too_big',
            origin: 'string',
            maximum: 1000,
            inclusive: true,
            path: ['text'],
          }),
        );
      }
    }
  });
});
