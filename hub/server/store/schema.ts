import type {DatabaseSync} from 'node:sqlite';

/**
 * The database layout. Each version is one step applied in order; a database records
 * the version it reached, so an upgrade runs only the steps it has not seen, all inside
 * one transaction.
 */
export const STEPS = [
  // 1 — the layout of 0.2. A released step never changes (test/schema.test.ts); a new
  // layout is a new step.
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
  -- How a board is arranged (domain/view.ts): widgets' order, sizes, names, hidden ones, plans.
  -- Its owner arranges it; everyone on the board sees it the same way.
  CREATE TABLE views (board_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);

  -- Machines running an agent, each a person's; the tokens with which many machines
  -- join as that person; pending one-time codes; the last failure each device reported
  -- per provider. A device's name is what the machine reports; its label, what people
  -- named it on the hub.
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL, name TEXT NOT NULL, label TEXT, os TEXT NOT NULL,
    arch TEXT NOT NULL, agent TEXT NOT NULL, token_id TEXT, token_hash TEXT UNIQUE, created_at INTEGER NOT NULL,
    last_seen_at INTEGER, revoked_at INTEGER);
  CREATE UNIQUE INDEX devices_by_machine ON devices (user_id, machine_id);
  CREATE TABLE device_codes (
    id TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, machine TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, polled_at INTEGER, status TEXT NOT NULL, user_id TEXT);
  CREATE TABLE device_failures (
    device_id TEXT NOT NULL, provider TEXT NOT NULL, error TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (device_id, provider));

  -- Subscriptions (domain/sources.ts), each kept once however many devices measure it;
  -- the people whose devices measure it (they see it on their personal board and may
  -- share it); the shared boards it is shared with; which device last delivered each.
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (provider, account));
  CREATE TABLE holders (source_id TEXT NOT NULL, user_id TEXT NOT NULL, since INTEGER NOT NULL,
    PRIMARY KEY (source_id, user_id)) WITHOUT ROWID;
  CREATE INDEX holders_by_user ON holders (user_id);
  CREATE TABLE shares (board_id TEXT NOT NULL, source_id TEXT NOT NULL, shared_by TEXT NOT NULL, shared_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, source_id)) WITHOUT ROWID;
  CREATE INDEX shares_by_source ON shares (source_id);
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
  -- Resets for everyone that the community trackers reported (server/resets.ts). The
  -- trackers only tell the latest one; the chart marks every one of the period.
  CREATE TABLE announcements (provider TEXT NOT NULL, at INTEGER NOT NULL, url TEXT NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (provider, at)) WITHOUT ROWID;
  `,
  // 2 — how long coding agents worked on each subscription.
  `
  -- In five-minute cells: agent time (two agents working for a minute count two) and the
  -- time any of them worked. Reported by agents with the sessions they see (server/sessions.ts).
  CREATE TABLE work (source_id TEXT NOT NULL, at INTEGER NOT NULL, agent_ms INTEGER NOT NULL, busy_ms INTEGER NOT NULL,
    PRIMARY KEY (source_id, at)) WITHOUT ROWID;
  `,
  // 3 — what agents did, rather than sums of it: each session and when it worked, and the
  // names people give their projects. Sums are worked out when read (domain/work.ts).
  `
  DROP TABLE work;
  -- A coding agent as its machine reported it: on which subscription, where it runs, since when
  -- (the agent's clock), in which project and folder ('' for none), names as reported. A change of
  -- any of these is a session of its own. Agents alike in all of it (started together by a script:
  -- Linux tells start times in hundredths of a second) are told apart by their place among them.
  CREATE TABLE agent_sessions (
    id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, source_id TEXT NOT NULL, origin TEXT NOT NULL,
    started_at INTEGER NOT NULL, project TEXT NOT NULL, folder TEXT NOT NULL, ordinal INTEGER NOT NULL,
    UNIQUE (device_id, source_id, started_at, origin, project, folder, ordinal));
  -- When it worked, on the hub's clock: each list counts until the next one, for at most 200 seconds.
  CREATE TABLE agent_work (session_id INTEGER NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, from_at)) WITHOUT ROWID;
  CREATE INDEX agent_work_by_end ON agent_work (to_at);
  -- What a person's machines report as a project, and the name it is shown and counted under.
  CREATE TABLE project_names (user_id TEXT NOT NULL, reported TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY (user_id, reported)) WITHOUT ROWID;
  `,
];

export const SCHEMA_VERSION = STEPS.length;

/** Brings a database to the current layout; refuses one written by a newer version. */
export function migrate(db: DatabaseSync, now: number) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const current = Number((db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version);
  if (current > SCHEMA_VERSION) throw new Error(`the database has layout ${current}; this version of the hub knows up to ${SCHEMA_VERSION}`);
  // Hubs before 0.2 were never released, and their layout was numbered 1 as well.
  if (current >= 1 && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'holders'").get()) {
    throw new Error('the database comes from a development version of the hub before 0.2, which cannot be upgraded; move it aside to start afresh');
  }
  if (current === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const step of STEPS.slice(current)) db.exec(step);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('historyStart', String(now));
    // Before this, how agents worked is not known (the sums of layout 2 are gone), rather than none worked.
    if (current < 3) db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('agentWorkSince', String(now));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
