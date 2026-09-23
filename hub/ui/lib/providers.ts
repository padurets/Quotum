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
 * apart. Also clear of the status hues; validated on the dark chart surface over every
 * pair (colour-vision deficiency sits at the floor between blue and violet, which is
 * why the legend and the tooltip name every line).
 */
export const CARD_COLORS = ['#5b8ff5', '#1fa89c', '#c06ad0', '#df6f4a'];

/** Windows of one source are distinguished by dash pattern within its colour. */
export const DASHES = ['', '7 5', '2 4', '10 3 2 3'];
