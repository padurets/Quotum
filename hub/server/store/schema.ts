import type {DatabaseSync} from 'node:sqlite';

/**
 * The database layout. Each version is one step applied in order; a database records
 * the version it reached, so an upgrade runs only the steps it has not seen, all inside
 * one transaction.
 */
const STEPS = [
  // 1 — the layout of 0.1.
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- People, boards and the ways to join them.
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  -- Personal boards have no name: the dashboard names them in the reader's language.
  CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, personal INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE members (
    board_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, user_id));
  CREATE TABLE invites (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
  -- How a board is arranged (domain/view.ts): widgets' order, hidden ones, spending plans.
  -- Its owner arranges it; everyone on the board sees it the same way.
  CREATE TABLE views (board_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);

  -- Machines running an agent (one row per board they deliver to), pending one-time
  -- codes, and the last failure each device reported per provider.
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, machine_id TEXT NOT NULL, name TEXT NOT NULL, os TEXT NOT NULL,
    arch TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT NOT NULL, owner_user_id TEXT, token_id TEXT,
    token_hash TEXT UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
  CREATE UNIQUE INDEX devices_by_machine ON devices (board_id, machine_id);
  CREATE TABLE device_codes (
    id TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, machine TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, polled_at INTEGER, status TEXT NOT NULL, board_id TEXT, user_id TEXT);
  CREATE TABLE device_failures (
    device_id TEXT NOT NULL, provider TEXT NOT NULL, error TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (device_id, provider));

  -- Subscriptions on boards (domain/sources.ts), and which device last delivered each.
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (board_id, provider, account));
  CREATE TABLE device_sources (
    device_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, provider));

  -- What the cards show (the last measurement of each source), and every window value
  -- ever measured, for the history chart and the spending totals.
  CREATE TABLE state (source_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE samples (
    source_id TEXT NOT NULL, window_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT,
    used REAL NOT NULL, reset_at INTEGER, minutes INTEGER, stale_after_ms INTEGER NOT NULL,
    PRIMARY KEY (source_id, window_id, at)) WITHOUT ROWID;
  CREATE INDEX samples_by_time ON samples (at);
  -- What happened to a source besides its values: free resets granted (detail: how many).
  CREATE TABLE events (source_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT,
    PRIMARY KEY (source_id, at, kind)) WITHOUT ROWID;
  `,
];

export const SCHEMA_VERSION = STEPS.length;

/** Brings a database to the current layout; refuses one written by a newer version. */
export function migrate(db: DatabaseSync, now: number) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const current = Number((db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version);
  if (current > SCHEMA_VERSION) throw new Error(`the database has layout ${current}; this version of the hub knows up to ${SCHEMA_VERSION}`);
  if (current === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const step of STEPS.slice(current)) db.exec(step);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('historyStart', String(now));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
