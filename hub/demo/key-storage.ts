import type {AppState} from '../ui/lib/app.js';

/** App settings fixtures, shared by the catalogue and its isolated browser renderer. */
export const KEY_STORAGE = {
  keystore: {state: 'keystore', outcome: 'ok', wasFile: false, retainedFile: false, resetAvailable: false, busy: false},
  file: {state: 'file', outcome: 'ok', wasFile: true, retainedFile: false, resetAvailable: false, busy: false},
  wasFile: {state: 'keystore', outcome: 'rotated', wasFile: true, retainedFile: false, resetAvailable: false, busy: false},
  retainedFile: {state: 'keystore', outcome: 'ok', wasFile: true, retainedFile: true, resetAvailable: false, busy: false},
  waiting: {state: 'waiting', outcome: 'missing', wasFile: false, retainedFile: false, resetAvailable: true, busy: false},
  missing: {state: 'missing', outcome: 'missing', wasFile: false, retainedFile: false, resetAvailable: true, busy: false},
  mismatch: {state: 'missing', outcome: 'mismatch', wasFile: false, retainedFile: false, resetAvailable: true, busy: false},
} satisfies Record<string, NonNullable<AppState['secretKey']>>;
