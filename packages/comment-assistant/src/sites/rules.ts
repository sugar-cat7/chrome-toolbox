import { MAX_RULES } from '../stream-context.ts';
import { cut } from './types.ts';

/** Characters of a description read for its rules (YouTube allows 5,000). */
export const MAX_DESCRIPTION = 5000;
/** Lines of one rules section after its heading. */
const MAX_RULE_LINES = 20;
/** Characters of a heading line. */
const MAX_HEADING = 30;
/**
 * A heading of a stream's rules (R63, R68), after NFKC and in lower case: the keyword (お約束,
 * おやくそく, Rule, ルール, 禁止事項, 注意事項, お願い) and nothing but decoration, brackets or a
 * colon around it (`【お約束】`, `■配信ルール`, `ルール：`, `⚠️注意事項⚠️`), maybe after a scope
 * (`配信`, `コメント欄の`, `chat `) and before a closing aside (`配信ルール（ご協力お願いします）`). A
 * greeting or a sentence is none: `よろしくお願いいたします`, `お願い致します`, `Please read the rules
 * below`, `ルール説明はこちら`.
 */
const HEADING =
  /^[\p{P}\p{S}\p{M}\p{Cf}\s]*(?:[\p{L}\p{N}]{1,8}の|配信|コメント|チャット|視聴|[a-z]+\s+)?(?:お約束|おやくそく|rules?|ルール|禁止事項|注意事項|お願い)[\p{P}\p{S}\p{M}\p{Cf}\s]*$/u;
/** A closing aside in brackets after a heading: `（ご協力お願いします）`. */
const ASIDE = /[(（][^()（）]{0,30}[)）][\p{P}\p{S}\p{M}\p{Cf}\s]*$/u;
/** A line of symbols only: a separator (`━━━━`, `-----`). */
const SEPARATOR = /^[\p{P}\p{S}\s]+$/u;
/** A line that starts another section: a bracketed heading of its own, or hashtags. */
const NEXT_SECTION = /^(?:【[^】]*】$|#)/u;
/** Whether a line of a description is a heading of the stream's rules (`HEADING`). */
export function isRulesHeading(line: string): boolean {
  const text = line.normalize('NFKC').toLowerCase().trim();
  return text.length <= MAX_HEADING && HEADING.test(text.replace(ASIDE, ''));
}

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
    if (!isRulesHeading(heading)) continue;
    const section = [heading];
    for (; i < lines.length && section.length <= MAX_RULE_LINES; i += 1) {
      const line = lines[i] ?? '';
      // A blank or separator line right after the heading belongs to it.
      if (line === '' || SEPARATOR.test(line)) {
        if (section.length > 1) break;
        continue;
      }
      if (isRulesHeading(line) || NEXT_SECTION.test(line)) break;
      section.push(line);
    }
    sections.push(section.join('\n'));
  }
  return cut(sections.join('\n'), MAX_RULES);
}
