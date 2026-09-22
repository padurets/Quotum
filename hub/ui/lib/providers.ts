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

/** Windows of one source are distinguished by dash pattern within its colour. */
export const DASHES = ['', '7 5', '2 4', '10 3 2 3'];
