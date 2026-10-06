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
  // 4 — which projects of a machine worked on a subscription, found without reading all its
  // sessions: a board's history is keyed by the names of those it shows (Store.workKey).
  `
  CREATE INDEX agent_sessions_by_project ON agent_sessions (device_id, project, source_id);
  `,
  // 5 — consumed desktop events, independent of notification delivery or UI lifetime.
  `
  CREATE TABLE attention_windows (
    source_id TEXT NOT NULL, window_id TEXT NOT NULL, cycle INTEGER NOT NULL, last_at INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (source_id, window_id)) WITHOUT ROWID;
  CREATE TABLE attention_announcements (
    provider TEXT PRIMARY KEY, last_announced_at INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TRIGGER attention_source_deleted AFTER DELETE ON sources BEGIN
    DELETE FROM attention_windows WHERE source_id = OLD.id;
  END;
  `,
  // 6 — one measuring preference per subscription, shared by all its boards.
  `
  ALTER TABLE sources ADD COLUMN measure_interval_ms INTEGER DEFAULT NULL
    CHECK (measure_interval_ms IS NULL OR measure_interval_ms IN (60000, 120000, 300000, 900000));
  `,
  // 7 — trusted connector credentials, encrypted before they reach SQLite.
  `
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT,
    cipher BLOB NOT NULL, nonce BLOB NOT NULL, key_version INTEGER NOT NULL,
    hint TEXT, abilities TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    last_used_at INTEGER, last_error TEXT, unreadable INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX credentials_by_owner ON credentials (user_id, provider);
  `,
  // 8 — opaque producer identity beside the unchanged legacy session namespace.
  `
  ALTER TABLE agent_sessions RENAME TO agent_sessions_legacy;
  CREATE TABLE agent_sessions (
    id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, source_id TEXT NOT NULL, origin TEXT NOT NULL,
    started_at INTEGER NOT NULL, project TEXT NOT NULL, folder TEXT NOT NULL, ordinal INTEGER NOT NULL,
    producer_id TEXT);
  INSERT INTO agent_sessions (id, device_id, source_id, origin, started_at, project, folder, ordinal, producer_id)
    SELECT id, device_id, source_id, origin, started_at, project, folder, ordinal, NULL FROM agent_sessions_legacy;
  DROP TABLE agent_sessions_legacy;
  CREATE UNIQUE INDEX agent_sessions_legacy_key ON agent_sessions
    (device_id, source_id, started_at, origin, project, folder, ordinal) WHERE producer_id IS NULL;
  CREATE UNIQUE INDEX agent_sessions_stable_key ON agent_sessions
    (device_id, producer_id, source_id, origin, project, folder) WHERE producer_id IS NOT NULL;
  CREATE INDEX agent_sessions_by_project ON agent_sessions (device_id, project, source_id);
  `,
  // 9 — exact unit-valued measurements and continuous observation spans.
  `
  CREATE TABLE readings (
    source_id TEXT NOT NULL, meter_id TEXT NOT NULL, at INTEGER NOT NULL, previous_at INTEGER,
    kind TEXT NOT NULL, unit TEXT NOT NULL, amount INTEGER NOT NULL, limit_amount INTEGER,
    reset_at INTEGER, minutes INTEGER, scope TEXT, label TEXT, stale_after_ms INTEGER NOT NULL,
    PRIMARY KEY (source_id, meter_id, at)) WITHOUT ROWID;
  CREATE INDEX readings_by_time ON readings (at);
  CREATE TABLE meter_spans (
    source_id TEXT NOT NULL, meter_id TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
    stale_after_ms INTEGER NOT NULL, PRIMARY KEY (source_id, meter_id, from_at)) WITHOUT ROWID;
  CREATE INDEX meter_spans_by_end ON meter_spans (to_at);
  CREATE INDEX credentials_by_source ON credentials (source_id, created_at, id);
  `,
  // 10 — declared accounts, truthful expiry and accepted observation interruptions.
  `
  CREATE TABLE declared_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, name_key TEXT NOT NULL, created_at INTEGER NOT NULL,
    lifecycle_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lifecycle_revision)='integer' AND lifecycle_revision>=0), UNIQUE(user_id,provider,name_key));
  CREATE INDEX declared_accounts_by_owner ON declared_accounts (user_id,provider,id);
  ALTER TABLE credentials ADD COLUMN expiry_kind TEXT NOT NULL DEFAULT 'none' CHECK(expiry_kind IN ('at','none','unknown'));
  UPDATE credentials SET expiry_kind='at' WHERE expires_at IS NOT NULL;
  ALTER TABLE meter_spans ADD COLUMN interrupted_at INTEGER;
  CREATE TRIGGER declared_account_withdrawn AFTER DELETE ON credentials
    WHEN NOT EXISTS (SELECT 1 FROM credentials WHERE user_id=OLD.user_id AND source_id=OLD.source_id)
    BEGIN
      UPDATE declared_accounts SET lifecycle_revision=lifecycle_revision+1
        WHERE user_id=OLD.user_id AND provider=OLD.provider AND source_id=OLD.source_id;
    END;
  `,
  // 11 — sparse histories of safe provider context beside the exact money ledger.
  `
  CREATE TABLE meter_contexts (
    source_id TEXT NOT NULL, item TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
    stale_after_ms INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (source_id,item,from_at)) WITHOUT ROWID;
  CREATE INDEX meter_contexts_by_end ON meter_contexts (to_at);
  `,
  // 12 — shared exchange-rate data and separate monetary valuations.
  `
  CREATE TABLE exchange_rates (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, reference_date INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE INDEX exchange_rates_by_date ON exchange_rates(reference_date);
  CREATE TABLE money_valuations (
    source_id TEXT NOT NULL, meter_id TEXT NOT NULL, at INTEGER NOT NULL, previous_at INTEGER,
    native_id TEXT NOT NULL, native_unit TEXT NOT NULL, native_amount TEXT NOT NULL,
    unit TEXT NOT NULL, amount TEXT NOT NULL, quote_id TEXT NOT NULL, semantics TEXT NOT NULL,
    stale_after_ms INTEGER NOT NULL, PRIMARY KEY(source_id,meter_id,at)) WITHOUT ROWID;
  CREATE INDEX money_valuations_by_time ON money_valuations(at);
  -- Preserve old derived history, while current provider state contains only reported facts.
  UPDATE state SET payload=json_set(json_remove(payload,'$.usdRate'),'$.meters',json(
    (SELECT coalesce(json_group_array(json(value)),'[]') FROM json_each(state.payload,'$.meters')
     WHERE json_extract(value,'$.id') NOT LIKE 'converted:%')))
    WHERE json_type(payload,'$.meters')='array';
  UPDATE state SET payload=json_set(payload,'$.balanceStatus.issues',json(
    (SELECT coalesce(json_group_array(value),'[]') FROM json_each(state.payload,'$.balanceStatus.issues') WHERE value<>'rate_unavailable')),
    '$.balanceStatus.partial',json(CASE WHEN EXISTS(SELECT 1 FROM json_each(state.payload,'$.balanceStatus.issues') WHERE value<>'rate_unavailable') THEN 'true' ELSE 'false' END))
    WHERE json_type(payload,'$.balanceStatus.issues')='array';
  `,
];

export const SCHEMA_VERSION = STEPS.length;

/** Brings a database to the current layout; refuses one written by a newer version. */
export function migrate(db: DatabaseSync, now: number) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA synchronous = FULL;');
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
