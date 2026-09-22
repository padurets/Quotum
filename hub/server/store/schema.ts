import type {DatabaseSync} from 'node:sqlite';

export const SCHEMA_VERSION = 4;

const V1 = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS state (provider TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guards (provider TEXT PRIMARY KEY, signature TEXT NOT NULL, scope TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS samples (
    provider TEXT NOT NULL, scope TEXT NOT NULL, bucket TEXT NOT NULL,
    source_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, label TEXT NOT NULL,
    used REAL NOT NULL, reset_at INTEGER, minutes INTEGER,
    PRIMARY KEY (provider, scope, bucket, source_at));
  CREATE INDEX IF NOT EXISTS history ON samples (provider, bucket, source_at);
  CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, at INTEGER NOT NULL, error TEXT);
`;

/**
 * v2 keys everything by *source* (one provider account) instead of by provider, so a
 * second subscription of the same provider becomes another row rather than a schema
 * change. Existing rows belong to the single default account of their provider.
 */
const V2 = `
  ALTER TABLE samples ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
  UPDATE samples SET source_id = provider WHERE source_id = '';
  CREATE INDEX IF NOT EXISTS samples_by_source ON samples (source_id, bucket, source_at);
  ALTER TABLE state RENAME COLUMN provider TO source_id;
  ALTER TABLE guards RENAME COLUMN provider TO source_id;
  ALTER TABLE attempts RENAME COLUMN provider TO source_id;
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_key TEXT NOT NULL, created_at INTEGER NOT NULL);
  INSERT OR IGNORE INTO sources (id, provider, account_key, created_at)
    SELECT DISTINCT provider, provider, 'default', ${'$'}{now} FROM samples;
`;

/**
 * v3 lets each measurement say how long it stays representative (agents measure on
 * their own schedule), and maps agent accounts and machines to sources.
 */
const V3 = `
  ALTER TABLE samples ADD COLUMN stale_after_ms INTEGER;
  CREATE TABLE IF NOT EXISTS agent_accounts (
    provider TEXT NOT NULL, account TEXT NOT NULL, source_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, account));
  CREATE TABLE IF NOT EXISTS agent_machines (
    machine_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL,
    agent TEXT NOT NULL, seen_at INTEGER NOT NULL,
    PRIMARY KEY (machine_id, provider));
`;

/**
 * v4 adds people and boards: users with sessions, boards with members, invites and
 * tokens, devices (one running agent each) and the device-code flow. Sources belong to
 * a board; everything collected so far belongs to the default board, which the first
 * user to sign up takes over.
 */
const V4 = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL,
    role TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, personal INTEGER NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE members (
    board_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, user_id));
  CREATE TABLE invites (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, machine_id TEXT NOT NULL, name TEXT NOT NULL, os TEXT NOT NULL,
    arch TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT NOT NULL, owner_user_id TEXT, token_id TEXT,
    token_hash TEXT UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
  CREATE UNIQUE INDEX devices_by_machine ON devices (board_id, machine_id);
  CREATE TABLE device_codes (
    id TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, machine TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, polled_at INTEGER, status TEXT NOT NULL, board_id TEXT, user_id TEXT);
  CREATE TABLE device_sources (
    device_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, provider));
  ALTER TABLE sources ADD COLUMN board_id TEXT NOT NULL DEFAULT 'default';
  INSERT INTO boards VALUES ('default', 'Мои лимиты', 1, NULL, ${'$'}{now});
  CREATE TABLE agent_accounts_v4 (
    board_id TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL, source_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (board_id, provider, account));
  INSERT INTO agent_accounts_v4 SELECT 'default', provider, account, source_id, created_at FROM agent_accounts;
  DROP TABLE agent_accounts;
  ALTER TABLE agent_accounts_v4 RENAME TO agent_accounts;
  DROP TABLE agent_machines;
`;

/** Applies pending migrations inside one transaction and records the new version. */
export function migrate(db: DatabaseSync, now: number) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const current = Number((db.prepare('PRAGMA user_version').get() as any).user_version ?? 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (current < 1) db.exec(V1);
    if (current < 2) db.exec(V2.replaceAll('${now}', String(now)));
    if (current < 3) db.exec(V3);
    if (current < 4) db.exec(V4.replaceAll('${now}', String(now)));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('collectionStart', String(now));
}
