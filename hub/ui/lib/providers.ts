/**
 * Identity colors are fixed per provider and deliberately avoid the status hues
 * (green / amber / red), so a series colour never reads as a warning.
 * Validated for colour-vision deficiency as a three-slot categorical set.
 * Their logos are in components/logos.ts.
 */
export const PROVIDERS: Record<string, {name: string; color: string}> = {
  claude: {name: 'Claude', color: '#de7b5b'},
  codex: {name: 'Codex', color: '#6897f0'},
  antigravity: {name: 'Antigravity', color: '#d271b3'},
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
  ['#b1ccfe', '#88b1ff', '#6897f0', '#5481d9', '#406bc1'],
  ['#7ae0d4', '#5fc6ba', '#43aca1', '#27968c', '#008077'],
  ['#ffa8fa', '#e48fdf', '#c976c5', '#b261ae', '#9b4c98'],
  ['#febaa4', '#fa9473', '#de7b5b', '#c66646', '#af5031'],
  ['#d5d9ec', '#bbbfd2', '#a2a6b8', '#8c91a2', '#787c8d'],
];

/** Windows of one source are distinguished by dash pattern within its colour. */
export const DASHES = ['', '7 5', '2 4', '10 3 2 3'];
