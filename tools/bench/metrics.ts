export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function normalizeForScoring(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  let previous = Array.from({ length: short.length + 1 }, (_, i) => i);
  for (let i = 1; i <= long.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= short.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (long[i - 1] === short[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
    }
    previous = current;
  }
  return previous[short.length] ?? 0;
}

const units = (text: string, unit: 'word' | 'char'): string[] => {
  const normalized = normalizeForScoring(text);
  if (normalized === '') return [];
  return unit === 'word' ? normalized.split(' ') : Array.from(normalized.replace(/\s+/gu, ''));
};

export function errorRate(reference: string, hypothesis: string, unit: 'word' | 'char'): number {
  const ref = units(reference, unit);
  const hyp = units(hypothesis, unit);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}
