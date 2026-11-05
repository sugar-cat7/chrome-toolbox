import { MAX_RULES } from '../stream-context.ts';
import { cut } from './types.ts';

/** Characters of a description read for its rules (YouTube allows 5,000). */
export const MAX_DESCRIPTION = 5000;
/** Lines of one rules section after its heading. */
const MAX_RULE_LINES = 20;
/** Characters of a heading line: a sentence that only mentions a rule is none. */
const MAX_HEADING = 30;
/**
 * A heading of a stream's rules (R63): お約束, おやくそく, Rule, ルール (配信ルール), 禁止事項,
 * 注意事項 and お願い as a noun (`★お願い★`, not `お願いします`), after NFKC and in lower case.
 */
const HEADING = /お約束|おやくそく|\brules?\b|ルール|禁止事項|注意事項|お願い(?!し)/u;
/** A line of symbols only: a separator (`━━━━`, `-----`). */
const SEPARATOR = /^[\p{P}\p{S}\s]+$/u;
/** A line that starts another section: a bracketed heading of its own, or hashtags. */
const NEXT_SECTION = /^(?:【[^】]*】$|#)/u;
const isHeading = (line: string): boolean => {
  const text = line.normalize('NFKC').toLowerCase();
  return text.length <= MAX_HEADING && HEADING.test(text);
};

/**
 * The rules sections of a stream description (R63): each heading line and the lines after it,
 * up to a blank or separator line after them, another heading or section, or 20 lines. Reads the
 * first 5,000 characters and returns at most `MAX_RULES`; empty without a heading.
 */
export function rulesOf(description: string): string {
  const lines = cut(description, MAX_DESCRIPTION)
    .split('\n')
    .map((line) => line.trim());
  const sections: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const heading = lines[i] ?? '';
    i += 1;
    if (!isHeading(heading)) continue;
    const section = [heading];
    for (; i < lines.length && section.length <= MAX_RULE_LINES; i += 1) {
      const line = lines[i] ?? '';
      // A blank or separator line right after the heading belongs to it.
      if (line === '' || SEPARATOR.test(line)) {
        if (section.length > 1) break;
        continue;
      }
      if (isHeading(line) || NEXT_SECTION.test(line)) break;
      section.push(line);
    }
    sections.push(section.join('\n'));
  }
  return cut(sections.join('\n'), MAX_RULES);
}
