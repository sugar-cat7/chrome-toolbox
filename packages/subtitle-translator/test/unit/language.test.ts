import { describe, expect, it } from 'vitest';
import { createLanguageTally } from '../../src/audio/language.ts';

const observeAll = (tally: ReturnType<typeof createLanguageTally>, langs: readonly string[]) => {
  for (const lang of langs) tally.observe(lang);
};
const times = (lang: string, n: number): string[] => Array.from({ length: n }, () => lang);

describe('language tally', () => {
  it('language tally follows the majority of the last 20 lines', () => {
    const tally = createLanguageTally(20);
    expect(tally.current()).toBeUndefined();
    observeAll(tally, [...times('en', 15), ...times('ko', 5)]);
    expect(tally.current()).toBe('en');
    // The last 20 are 4 en and 16 ko: the 11 older en lines are out of the window.
    observeAll(tally, times('ko', 11));
    expect(tally.current()).toBe('ko');
  });

  it.each([
    { name: '新しい方が ko', langs: [...times('en', 10), ...times('ko', 10)], current: 'ko' },
    { name: '新しい方が en', langs: [...times('ko', 10), ...times('en', 10)], current: 'en' },
    { name: '交互で最後が es', langs: ['en', 'es', 'en', 'es'], current: 'es' },
  ])('takes the newer language on a tie: $name', ({ langs, current }) => {
    const tally = createLanguageTally(20);
    observeAll(tally, langs);
    expect(tally.current()).toBe(current);
  });

  it('forgets every line on reset', () => {
    const tally = createLanguageTally(20);
    observeAll(tally, times('en', 3));
    tally.reset();
    expect(tally.current()).toBeUndefined();
    tally.observe('id');
    expect(tally.current()).toBe('id');
  });
});
