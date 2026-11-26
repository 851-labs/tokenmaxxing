/**
 * Text widths for SVG that is laid out on the server and drawn in whatever
 * system font the viewer has, where nothing can be measured.
 *
 * Each row is an advance in hundredths of an em and the glyphs that have it:
 * the widest of San Francisco, Segoe UI (through the metric-compatible
 * Selawik), Noto Sans, Helvetica/Arial and Roboto at weight 600, as Chrome
 * measures them. A real string comes out 2–15% narrower than its estimate in
 * every one of them, so text fitted with these numbers stays inside its box in
 * all of them. Regular weight is narrower still.
 */
const ADVANCES: ReadonlyArray<readonly [advance: number, glyphs: string]> = [
  [28, " ',"],
  [29, ".ijl"],
  [34, "!:;·"],
  [37, "()I[]"],
  [38, "f"],
  [39, "{}"],
  [41, "-t"],
  [42, "\\"],
  [43, "/"],
  [44, "r"],
  [48, '"'],
  [50, "`"],
  [51, "z"],
  [55, "*"],
  [56, "J_cesvxy|"],
  [58, "17"],
  [59, "ak"],
  [60, "2"],
  [61, "5"],
  [62, "34?FLTbdopq"],
  [63, "8Zg"],
  [64, "$0hnu"],
  [65, "#69"],
  [67, "EPSVXY"],
  [70, "+<=>^~"],
  [73, "ABCKR"],
  [74, "D"],
  [75, "U"],
  [76, "H"],
  [78, "G"],
  [79, "OQ"],
  [80, "N"],
  [83, "w"],
  [84, "&"],
  [89, "%"],
  [94, "M"],
  [96, "m"],
  [98, "@"],
  [99, "W"],
];
/** Anything else is taken as a full em, the width of a CJK glyph or a dash. */
const UNKNOWN_ADVANCE = 100;
const ELLIPSIS = "…";

const advanceByGlyph = new Map<string, number>(
  ADVANCES.flatMap(([advance, glyphs]) => Array.from(glyphs, (glyph) => [glyph, advance] as const)),
);

interface FittedText {
  size: number;
  text: string;
}

/** Upper bound, in px, of `text` set at `fontSize` in a common system sans-serif. */
function estimateTextWidth(text: string, fontSize: number): number {
  let advance = 0;
  for (const glyph of text) {
    advance += advanceByGlyph.get(glyph) ?? UNKNOWN_ADVANCE;
  }

  return (advance * fontSize) / 100;
}

/**
 * `text` made to fit `maxWidth`: set smaller first, down to `minSize` in
 * half-pixel steps, and only then cut short with an ellipsis.
 */
function fitText(text: string, maxWidth: number, size: number, minSize = size): FittedText {
  const width = estimateTextWidth(text, size);
  if (width <= maxWidth) {
    return { size, text };
  }

  const fitted = Math.max(minSize, Math.floor(((size * maxWidth) / width) * 2) / 2);
  if (estimateTextWidth(text, fitted) <= maxWidth) {
    return { size: fitted, text };
  }

  const glyphs = Array.from(text);
  do {
    glyphs.pop();
  } while (glyphs.length > 1 && estimateTextWidth(glyphs.join("") + ELLIPSIS, fitted) > maxWidth);

  return { size: fitted, text: glyphs.join("") + ELLIPSIS };
}

export { estimateTextWidth, fitText };

export type { FittedText };
