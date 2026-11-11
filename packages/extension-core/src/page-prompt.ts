import * as z from 'zod/mini';
import type { ChatMessage } from './llm.ts';
import {
  codePoints,
  commentReplyBudget,
  DATA_NOT_INSTRUCTIONS,
  translationLimit,
  translationRule,
} from './prompts.ts';

/**
 * One piece of a page paragraph, in document order: a text node to translate, a text node of
 * only whitespace (never rewritten), the start or end of an inline element (a link, emphasis)
 * or an inline element that stays as it is (code). Open and keep numbers each count from 1.
 */
export const pageTokenSchema = z.union([
  z.object({ t: z.literal('text'), text: z.string() }),
  z.object({ t: z.literal('space') }),
  z.object({ t: z.literal('open'), n: z.int().check(z.minimum(1)) }),
  z.object({ t: z.literal('close'), n: z.int().check(z.minimum(1)) }),
  z.object({ t: z.literal('keep'), n: z.int().check(z.minimum(1)), text: z.string() }),
]);
export type PageToken = z.infer<typeof pageTokenSchema>;
type PageUnit = readonly PageToken[];

/** Markers (`open` and `keep`) one unit may have, and the characters of its text nodes. */
export const PAGE_MARKERS_MAX = 12;
export const PAGE_UNIT_CHARS = 400;
const PAGE_KEEP_CHARS = 200;
const PAGE_TITLE_CHARS = 200;
/**
 * `max_tokens` cap of one PLaMo unit: its translation is at most `translationLimit` of a unit of
 * `PAGE_UNIT_CHARS` characters, 2 tokens per character at most, plus the line's own tokens.
 */
export const PAGE_PLAMO_MAX_TOKENS = 2 * PAGE_UNIT_CHARS + 16;

/**
 * Page text goes out with `<` and `>` written as the lookalikes `‹` and `›`, so a text can never
 * spell a marker; a text of no letters holding one is kept as written in the translation.
 */
const escaped = (text: string): string => text.replaceAll('<', '‹').replaceAll('>', '›');
const hasAngle = (text: string): boolean => /[<>]/u.test(text);
const hasLetter = (text: string): boolean => /\p{L}/u.test(text);
/** A text node whose translation is its own text: no letters and an angle bracket. */
const isLiteral = (text: string): boolean => hasAngle(text) && !hasLetter(text);

/**
 * Whether `tokens` make a unit that can be translated and written back: a text node at least,
 * elements properly nested and numbered from 1, at most `PAGE_MARKERS_MAX` markers and
 * `PAGE_UNIT_CHARS` characters of text. Two text nodes need a marker between them: the
 * translation is read back by splitting at the markers.
 */
export function pageTokensValid(tokens: PageUnit): boolean {
  const open: number[] = [];
  let opened = 0;
  let kept = 0;
  let texts = 0;
  let chars = 0;
  let afterText = false;
  for (const token of tokens) {
    if (!pageTokenSchema.safeParse(token).success) return false;
    switch (token.t) {
      case 'space':
        break;
      case 'text': {
        const length = codePoints(token.text);
        chars += length;
        if (length < 1 || length > PAGE_UNIT_CHARS || chars > PAGE_UNIT_CHARS || afterText)
          return false;
        texts += 1;
        afterText = true;
        break;
      }
      case 'open':
        opened += 1;
        if (token.n !== opened) return false;
        open.push(token.n);
        afterText = false;
        break;
      case 'close':
        if (open.pop() !== token.n) return false;
        afterText = false;
        break;
      case 'keep':
        kept += 1;
        if (token.n !== kept || codePoints(token.text) > PAGE_KEEP_CHARS) return false;
        afterText = false;
        break;
    }
  }
  return open.length === 0 && texts >= 1 && opened + kept <= PAGE_MARKERS_MAX;
}

/**
 * The text a unit is sent as: the text nodes with `<n>`, `</n>` and `<kN/>` between them, and
 * the text of each kept element under its `kN` in `keep` (absent when there is none).
 */
export function pageUnitSource(tokens: PageUnit): { text: string; keep?: Record<string, string> } {
  const keep: Record<string, string> = {};
  const text = tokens
    .map((token): string => {
      switch (token.t) {
        case 'text':
          return escaped(token.text);
        case 'space':
          return ' ';
        case 'open':
          return `<${token.n}>`;
        case 'close':
          return `</${token.n}>`;
        case 'keep':
          keep[`k${token.n}`] = token.text;
          return `<k${token.n}/>`;
      }
    })
    .join('');
  return Object.keys(keep).length === 0 ? { text } : { text, keep };
}

/** The markers of a unit in order, as the translation writes them. */
const markersOf = (tokens: PageUnit): string[] =>
  tokens.flatMap((token): string[] => {
    switch (token.t) {
      case 'open':
        return [`<${token.n}>`];
      case 'close':
        return [`</${token.n}>`];
      case 'keep':
        return [`<k${token.n}/>`];
      case 'text':
      case 'space':
        return [];
    }
  });

/**
 * Reply budget of one page batch: a line per unit, a few tokens per marker, and 3 tokens per
 * character each text node's grammar allows its translation (see `commentReplyBudget`).
 */
export const PAGE_REPLY_BUDGET = {
  line: commentReplyBudget.line,
  perMarker: 4,
  perCharacter: commentReplyBudget.perTranslationCharacter,
} as const;
export const pageBatchMaxTokens = (units: readonly PageUnit[]): number =>
  units.reduce(
    (total, tokens) =>
      total +
      PAGE_REPLY_BUDGET.line +
      PAGE_REPLY_BUDGET.perMarker *
        tokens.filter((token) => token.t === 'open' || token.t === 'keep').length +
      PAGE_REPLY_BUDGET.perCharacter *
        tokens.reduce(
          (sum, token) => sum + (token.t === 'text' ? translationLimit(token.text) : 0),
          0,
        ),
    0,
  );

const PAGE_SYSTEM = `You translate parts of a web page into natural, concise Japanese for the reader. Each segment is a paragraph, a heading, a list item, a table cell, a label or a button.
<n>…</n> wraps the words of a link or emphasis, and <kN/> stands for code or a name that stays as it is (its text is in the segment's "keep"). Copy every marker in the same order, and put the translation of the marked words between <n> and </n>.
Keep URLs, numbers, product names, code and file names as written. Write no notes, readings, alternatives or original text.
The user turn's "Page" is context only.
${DATA_NOT_INSTRUCTIONS}
Reply with one line per segment, in order: the segment's id, a tab and the Japanese translation (one line).
Example: for {"id":1,"text":"Final Boss Guide"} and {"id":2,"text":"Roll <1>backward</1> to dodge the light attack."} reply
1\tラスボス攻略
2\t光の攻撃は<1>後ろに</1>転がると避けられる。`;

/**
 * One line per unit, `<n>\t<translation>\n`, like the comment batch: the number and every
 * marker are fixed, and each text node has its own rule, one line of at most `translationLimit`
 * characters without `<` or `>` that is not empty (and does not start with a space) when the
 * text has a letter, so a link's words cannot disappear.
 */
function pageBatchGrammar(units: readonly PageUnit[]): string {
  const rules: string[] = [];
  const lines = units.map((tokens, i) => {
    const n = i + 1;
    let pieces = 0;
    const body = tokens.flatMap((token): string[] => {
      switch (token.t) {
        case 'text': {
          pieces += 1;
          if (isLiteral(token.text)) return [JSON.stringify(escaped(token.text))];
          const name = `ja${n}-${pieces}`;
          rules.push(
            hasLetter(token.text)
              ? translationRule(name, token.text)
              : `${name} ::= [^\\t\\n<>]{0,${translationLimit(token.text)}}`,
          );
          return [name];
        }
        case 'space':
          return [];
        case 'open':
        case 'close':
        case 'keep':
          return markersOf([token]).map((marker) => `"${marker}"`);
      }
    });
    return `line${n} ::= "${n}\\t" ${[...body, '"\\n"'].join(' ')}`;
  });
  return [
    `root ::= ${units.length === 0 ? '""' : units.map((_, i) => `line${i + 1}`).join(' ')}`,
    ...lines,
    ...rules,
  ].join('\n');
}

/**
 * The prompt of a page batch: the units as JSON lines, the page's title and site as context.
 * The system turn is one fixed prefix (R25).
 */
export const pageBatchPrompt = (
  input: Readonly<{
    page: Readonly<{ title: string; site: string }>;
    units: readonly PageUnit[];
  }>,
): { messages: ChatMessage[]; grammar: string } => {
  const title = Array.from(input.page.title).slice(0, PAGE_TITLE_CHARS).join('');
  const lines = input.units.map((tokens, i) =>
    JSON.stringify({ id: i + 1, ...pageUnitSource(tokens) }),
  );
  return {
    messages: [
      { role: 'system', content: PAGE_SYSTEM },
      {
        role: 'user',
        content: [
          `Page (JSON): ${JSON.stringify({ title, site: input.page.site })}`,
          `Segments (one JSON object per line):\n${lines.join('\n')}`,
        ].join('\n\n'),
      },
    ],
    grammar: pageBatchGrammar(input.units),
  };
};

const MARKER_SPLIT = /(<\/?\d+>|<k\d+\/>)/u;

/**
 * The translation of each text node of `tokens`, read from one translation line (without the
 * number and tab): the markers must be those of the unit, in its order, and a text node with a
 * letter keeps a non-empty translation under its limit. Each piece is trimmed. `undefined` when
 * a marker is missing, extra or out of order, a translation is empty or reached its limit, or
 * words stand where the unit has no text node.
 */
export function readPagePieces(text: string, tokens: PageUnit): string[] | undefined {
  const parts = text.split(MARKER_SPLIT);
  const found = parts.filter((_, i) => i % 2 === 1);
  const expected = markersOf(tokens);
  if (found.length !== expected.length || found.some((marker, i) => marker !== expected[i]))
    return undefined;
  // The text nodes between markers: the unit holds at most one in each gap (pageTokensValid).
  const gaps: (string | undefined)[] = [undefined];
  for (const token of tokens) {
    if (token.t === 'text') gaps[gaps.length - 1] = token.text;
    else if (token.t !== 'space') gaps.push(undefined);
  }
  const pieces: string[] = [];
  for (const [i, source] of gaps.entries()) {
    const written = parts[i * 2] ?? '';
    const piece = written.trim();
    if (source === undefined) {
      if (piece !== '') return undefined;
      continue;
    }
    if (isLiteral(source)) {
      if (piece !== escaped(source)) return undefined;
      pieces.push(source);
      continue;
    }
    if (codePoints(written) >= translationLimit(source)) return undefined;
    if (piece === '' && hasLetter(source)) return undefined;
    pieces.push(piece);
  }
  return pieces.length === tokens.filter((token) => token.t === 'text').length ? pieces : undefined;
}

/**
 * The pieces of each unit of a batch reply, in input order: line i is unit i, so a line with
 * another number, a missing line or a translation `readPagePieces` refuses is `undefined`. When
 * `cut` (max_tokens may have stopped the reply), a last line without its newline is unfinished.
 */
export function parsePageBatch(
  text: string,
  units: readonly PageUnit[],
  { cut }: Readonly<{ cut: boolean }>,
): (string[] | undefined)[] {
  const lines = text.split('\n');
  if (cut || lines.at(-1) === '') lines.pop();
  return units.map((tokens, i): string[] | undefined => {
    const line = lines[i];
    const tab = line?.indexOf('\t') ?? -1;
    if (line === undefined || tab < 0 || line.slice(0, tab) !== String(i + 1)) return undefined;
    const translation = line.slice(tab + 1);
    return translation.includes('\t') ? undefined : readPagePieces(translation, tokens);
  });
}
