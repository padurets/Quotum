import claudeIcon from '../icons/claude.svg';
import codexIcon from '../icons/codex.svg';
import antigravityIcon from '../icons/antigravity.svg';

/**
 * Identity colors are fixed per provider and deliberately avoid the status hues
 * (green / amber / red), so a series colour never reads as a warning.
 * Validated for colour-vision deficiency as a three-slot categorical set.
 */
export const PROVIDERS: Record<string, {name: string; icon: string; color: string}> = {
  claude: {name: 'Claude', icon: claudeIcon, color: '#df6f4a'},
  codex: {name: 'Codex', icon: codexIcon, color: '#5b8ff5'},
  antigravity: {name: 'Antigravity', icon: antigravityIcon, color: '#d264b0'},
};

export const KNOWN_PROVIDERS = Object.keys(PROVIDERS);

/** Windows of one source are distinguished by dash pattern within its colour. */
export const DASHES = ['', '7 5', '2 4', '10 3 2 3'];
