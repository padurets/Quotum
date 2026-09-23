/**
 * Identity colors are fixed per provider and deliberately avoid the status hues
 * (green / amber / red), so a series colour never reads as a warning.
 * Validated for colour-vision deficiency as a three-slot categorical set.
 * Their logos are in components/logos.ts.
 */
export const PROVIDERS: Record<string, {name: string; color: string}> = {
  claude: {name: 'Claude', color: '#df6f4a'},
  codex: {name: 'Codex', color: '#5b8ff5'},
  antigravity: {name: 'Antigravity', color: '#d264b0'},
};

/** The colour of a series whose provider has none. */
export const FALLBACK_COLOR = '#8b90b5';

/**
 * Colours a board's owner can give cards, so subscriptions of one provider can be told
 * apart: a few hues, each in five steps of OKLCH lightness from light to dark, the
 * middle one the hue itself (Codex's blue and Claude's orange among them). The hues are
 * clear of the status ones and tell apart on the dark chart surface; a fifth, Antigravity's
 * pink, would be too close to the purple. Every step keeps 3:1 contrast with the surface.
 */
export const MIDDLE_STEP = 2;
export const CARD_COLORS: string[][] = [
  ['#a6c5ff', '#7eaaff', '#5b8ff5', '#4779dd', '#3363c5'],
  ['#63dcce', '#45c2b5', '#1fa89c', '#099186', '#067a71'],
  ['#f0a2fe', '#da83eb', '#c06ad0', '#a954b9', '#933fa3'],
  ['#ffb096', '#fb8863', '#df6f4a', '#c75934', '#af441d'],
  ['#cdd3e8', '#b4b9ce', '#9ba0b4', '#868b9e', '#717689'],
];

/** Windows of one source are distinguished by dash pattern within its colour. */
export const DASHES = ['', '7 5', '2 4', '10 3 2 3'];
