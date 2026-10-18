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

export const HOOK_STATES={
  off:{status:{state:'off'},error:null},
  enabled_no_records:{status:{state:'enabled_no_records'},error:null},
  observing:{status:{state:'observing'},error:null},
  update_pending:{status:{state:'update_pending'},error:null},
  remove_pending:{status:{state:'remove_pending'},error:null},
  error:{status:{state:'error',code:'conflict'},error:'conflict'},
  untrusted:{status:{state:'off'},error:'untrusted_payload'},
} satisfies Record<string,NonNullable<AppState['claudeHook']>>;
