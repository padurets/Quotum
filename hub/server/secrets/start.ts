import type {DatabaseSync} from 'node:sqlite';
import {SecretError, type RecordIdentity, type Sealed, type SecretKey} from './crypto.js';
import type {ResetIntent, SecretInputs} from './inputs.js';

export type SecretKeyOutcome = 'created' | 'ok' | 'rotated' | 'mismatch' | 'missing';
export type SecretKeyReport = {outcome: SecretKeyOutcome; stored: string | null; current: string | null; credentials: number; unreadable: number};
type EncryptedRow = RecordIdentity & Sealed & {key_version: number; unreadable: number};

/** A busy checkpoint never authorizes destruction of the key that opened the old WAL. */
export function checkpoint(db: DatabaseSync, code = 'secret_key_checkpoint_pending'): void {
  const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy: number; log: number; checkpointed: number};
  if (row.busy !== 0 || row.log > 0 || row.checkpointed > 0) throw new SecretError(code);
}

/** All startup decisions share one transaction, on server and desktop. */
export function startSecrets(db: DatabaseSync, inputs: SecretInputs, oneShot: ResetIntent | null = inputs.reset): SecretKeyReport {
  try {
    db.exec('BEGIN IMMEDIATE');
    let report: SecretKeyReport;
    try {
      report = decide(db, inputs.current, inputs.previous, oneShot);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (['created', 'ok', 'rotated'].includes(report.outcome)) checkpoint(db);
    return report;
  } catch (error) {
    throw error instanceof SecretError ? error : new SecretError('secret_key_start_failed');
  }
}

function decide(db: DatabaseSync, current: SecretKey | null, previous: SecretKey | null, reset: ResetIntent | null): SecretKeyReport {
  const meta = new Map((db.prepare("SELECT key, value FROM meta WHERE key IN ('secretKeyKcv', 'secretKeyVersion')").all() as {key: string; value: string}[]).map(row => [row.key, row.value]));
  const kcv = meta.get('secretKeyKcv');
  const version = meta.get('secretKeyVersion');
  if (meta.size && (meta.size !== 2 || !/^[0-9a-f]{64}$/.test(kcv ?? '') || !/^[1-9][0-9]*$/.test(version ?? '') || !Number.isSafeInteger(Number(version)))) throw new SecretError('secret_key_metadata_invalid');
  let generation = Number(version ?? 1);
  let stored = kcv?.slice(0, 16) ?? null;
  const rows = db.prepare('SELECT id, user_id, provider, cipher, nonce, key_version, unreadable FROM credentials ORDER BY id').all() as EncryptedRow[];
  const answer = (outcome: SecretKeyOutcome): SecretKeyReport => ({outcome, stored, current: current?.fingerprint ?? null, credentials: (db.prepare('SELECT count(*) AS n FROM credentials').get() as {n: number}).n, unreadable: (db.prepare('SELECT count(*) AS n FROM credentials WHERE unreadable != 0').get() as {n: number}).n});
  if (!current) {
    if (reset) throw new SecretError('secret_key_reset_conflict');
    return answer('missing');
  }
  if (reset && reset.to !== current.fingerprint) throw new SecretError('secret_key_reset_conflict');
  const writeMeta = () => {
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('secretKeyKcv', current.checkValue);
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('secretKeyVersion', String(generation));
    stored = current.fingerprint;
  };
  const readable = (key: SecretKey, row: EncryptedRow): boolean => {
    if (!Number.isSafeInteger(row.key_version) || row.key_version < 1) return false;
    try { key.use(row, () => {}); return true; } catch { return false; }
  };
  if (kcv && current.matches(kcv)) return answer('ok');
  if (kcv && previous?.matches(kcv)) {
    if (!Number.isSafeInteger(++generation)) throw new SecretError('secret_key_metadata_invalid');
    const replace = db.prepare('UPDATE credentials SET cipher = ?, nonce = ?, key_version = ?, unreadable = 0, last_error = NULL WHERE id = ?');
    const mark = db.prepare("UPDATE credentials SET unreadable = 1, last_error = 'credential_unreadable' WHERE id = ?");
    for (const row of rows) {
      if (!readable(previous, row)) { mark.run(row.id); continue; }
      const sealed = previous.use(row, plain => current.seal(row, plain));
      replace.run(sealed.cipher, sealed.nonce, generation, row.id);
    }
    writeMeta();
    return answer('rotated');
  }
  if (reset) {
    if (reset.from !== stored || reset.from === reset.to) throw new SecretError('secret_key_reset_conflict');
    db.exec('DELETE FROM credentials');
    writeMeta();
    return answer('created');
  }
  if (!rows.length) { writeMeta(); return answer('created'); }
  if (!kcv) {
    // One bad first row does not prove that the key is wrong for this database.
    const first = rows.find(row => readable(current, row));
    if (first) {
      generation = first.key_version;
      const mark = db.prepare('UPDATE credentials SET unreadable = ?, last_error = ? WHERE id = ?');
      for (const row of rows) {
        const ok = readable(current, row);
        mark.run(ok ? 0 : 1, ok ? null : 'credential_unreadable', row.id);
      }
      writeMeta();
      return answer('ok');
    }
  }
  return answer('mismatch');
}
