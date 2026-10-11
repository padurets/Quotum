import type {DatabaseSync} from 'node:sqlite';
import {transaction} from '../touches.js';

const KEY = 'attentionCycle';
const invalid = () => new Error('invalid_attention_cycle');

function counter(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as {value: string} | undefined;
  if (!row) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(row.value) || !Number.isSafeInteger(Number(row.value))) throw invalid();
  return Number(row.value);
}

/** Bootstrap before any ledger can be removed, including by a source-delete trigger. */
export function bootstrapAttentionCycles(db: DatabaseSync): boolean {
  try {
    transaction(db, () => {
      const current = counter(db);
      const legacy = (db.prepare('SELECT max(cycle) AS cycle FROM attention_windows').get() as {cycle: number | null}).cycle ?? 0;
      if (!Number.isSafeInteger(legacy) || legacy < 0) throw invalid();
      const high = Math.max(current ?? 0, legacy);
      if (current !== high) db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(KEY, String(high));
    });
    return true;
  } catch {
    // Cleanup can remove the invalid legacy evidence: keep allocation disabled across restart too.
    try { db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(KEY, 'invalid'); }
    catch { /* The store also keeps the failed bootstrap in memory. */ }
    return false;
  }
}

/** The caller persists this allocation and its ledger in the measurement transaction. */
export function nextAttentionCycle(db: DatabaseSync): number {
  const current = counter(db);
  if (current === null || current === Number.MAX_SAFE_INTEGER || !db.isTransaction) throw invalid();
  const next = current + 1;
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(next), KEY);
  return next;
}
