import { describe, expect, it } from 'vitest';
import { errorRate, normalizeForScoring, percentile } from './metrics.ts';

describe('percentile', () => {
  it.each([
    { values: [], p: 50, expected: undefined },
    { values: [3, 1, 2], p: 50, expected: 2 },
    { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p: 95, expected: 10 },
  ])('percentile $p of $values', ({ values, p, expected }) =>
    expect(percentile(values, p)).toBe(expected),
  );
});

describe('errorRate', () => {
  it.each([
    { ref: 'the cat sat', hyp: 'the cat sat', unit: 'word', expected: 0 },
    { ref: 'the cat sat', hyp: 'the bat sat', unit: 'word', expected: 1 / 3 },
    { ref: '你好世界', hyp: '你好', unit: 'char', expected: 0.5 },
    { ref: '', hyp: '', unit: 'word', expected: 0 },
    { ref: '', hyp: 'noise', unit: 'word', expected: 1 },
    { ref: 'Hello, World!', hyp: 'hello world', unit: 'word', expected: 0 },
  ])('errorRate($ref, $hyp)', ({ ref, hyp, unit, expected }) =>
    expect(errorRate(ref, hyp, unit as 'word' | 'char')).toBeCloseTo(expected),
  );
});

describe('normalizeForScoring', () => {
  it('applies NFKC, lowercase, punctuation strip and whitespace collapse', () => {
    expect(normalizeForScoring('  ＨＥＬＬＯ,\n  World!! ')).toBe('hello world');
  });
});
