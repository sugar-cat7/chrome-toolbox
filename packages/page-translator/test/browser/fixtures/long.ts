// A long made-up page: numbered paragraphs of a fixed height, one under the other from the top
// of the page (no margins), so the paragraphs near the viewport follow from the scroll position.

export const LONG_URL = 'https://log.fixture.test/harbor';
/** The paragraphs of the scroll test's page, and their height in px. */
export const LONG_COUNT = 300;
export const LONG_HEIGHT = 100;

/** Made-up endings, so that paragraphs differ in length as well as in number. */
const ENDINGS = [
  'the night crew counted the boats twice.',
  'a gull stole the last biscuit of the cook.',
  'fog rolled in before the lamps were lit, and the bell rang for an hour.',
  'nobody wrote down the name of the trawler.',
  'the tide came in early and soaked the nets.',
] as const;

/** Paragraph `n`'s text: `Harbor log <n>: …`. */
export const longText = (n: number): string =>
  `Harbor log ${n}: ${ENDINGS[n % ENDINGS.length] ?? ENDINGS[0]}`;

/** The number of the paragraph a unit's text comes from, or undefined. */
export function longNumberOf(text: string): number | undefined {
  const found = /Harbor log (\d+):/u.exec(text)?.[1];
  return found === undefined ? undefined : Number(found);
}

/** The page: `count` paragraphs `#p1`…, each `height` px high. */
export function longHtml({
  count = LONG_COUNT,
  height = LONG_HEIGHT,
}: Readonly<{ count?: number; height?: number }> = {}): string {
  const paragraphs = Array.from(
    { length: count },
    (_, i) => `<p id="p${i + 1}">${longText(i + 1)}</p>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Harbor log</title>
    <style>
      body { margin: 0; font: 16px/20px sans-serif; }
      p { height: ${height}px; margin: 0; overflow: hidden; }
    </style>
  </head>
  <body>
${paragraphs}
  </body>
</html>`;
}
