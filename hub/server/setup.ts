import {newUserCode, normalizeUserCode} from './domain/auth.js';

/**
 * Claiming a new hub. Until it has an account, whoever reaches it first could make
 * themselves its owner; so the first account needs a code that only the person who
 * started the hub can see: printed to its log (or set with `QUOTUM_SETUP_CODE`).
 */
export class Setup {
  private code: string | null;

  /** `pending`: the hub has no account yet. */
  constructor(pending: boolean, code: string | null) {
    this.code = pending ? (normalizeUserCode(code ?? '') ?? code ?? newUserCode()) : null;
  }

  /** The code to print, while the hub waits for its first account. */
  get pending(): string | null {
    return this.code;
  }

  /** Whether a code someone typed is this hub's; forgiving about case, spaces and the dash. */
  matches(typed: unknown): boolean {
    if (!this.code || typeof typed !== 'string') return false;
    return (normalizeUserCode(typed) ?? typed.trim()) === this.code;
  }

  /** The first account exists: no more code. */
  done() {
    this.code = null;
  }
}
