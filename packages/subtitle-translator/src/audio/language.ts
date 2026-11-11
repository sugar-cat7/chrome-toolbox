/** The spoken language as the status shows it, from the languages of the last lines heard. */
export type LanguageTally = {
  /** One line's language (the ASR's `<lang>`); silent segments say nothing about it (S35). */
  observe(this: void, lang: string): void;
  /** The most frequent language of the last `size` lines, the newer one on a tie; none before one. */
  current(this: void): string | undefined;
  reset(this: void): void;
};

export function createLanguageTally(size: number): LanguageTally {
  /** The last `size` languages, oldest first. */
  let langs: string[] = [];
  return {
    observe(lang) {
      langs.push(lang);
      if (langs.length > size) langs.shift();
    },
    current() {
      const counts = new Map<string, number>();
      for (const lang of langs) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      let best: string | undefined;
      let bestCount = 0;
      // Newest first, so a later language with the same count never replaces the newer one.
      for (let at = langs.length - 1; at >= 0; at -= 1) {
        const lang = langs[at] ?? '';
        const count = counts.get(lang) ?? 0;
        if (count > bestCount) {
          best = lang;
          bestCount = count;
        }
      }
      return best;
    },
    reset() {
      langs = [];
    },
  };
}
