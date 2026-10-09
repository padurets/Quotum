import {migrateAnalyticsViews} from './analyticsView.js';
import type {DatabaseSync} from 'node:sqlite';
import {adoptDeclaredLayout} from './legacyDeclared.js';

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
  // 10 — declared account provenance, unknown key expiry and hard quota history bounds.
  `
  CREATE TABLE source_identity (
    source_id TEXT PRIMARY KEY REFERENCES sources(id), kind TEXT NOT NULL CHECK (kind IN ('supplier','declared')),
    owner_id TEXT REFERENCES users(id), CHECK ((kind='declared' AND owner_id IS NOT NULL) OR (kind='supplier' AND owner_id IS NULL)));
  INSERT INTO source_identity (source_id,kind,owner_id) SELECT id,'supplier',NULL FROM sources WHERE provider='openrouter';
  ALTER TABLE credentials ADD COLUMN expiry_kind TEXT NOT NULL DEFAULT 'none' CHECK (expiry_kind IN ('dated','none','unknown'));
  UPDATE credentials SET expiry_kind='dated' WHERE expires_at IS NOT NULL;
  ALTER TABLE meter_spans ADD COLUMN hold_until INTEGER;
  `,

  // 11 — declared accounts, truthful expiry and accepted observation interruptions.
  `
  CREATE TABLE declared_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, name_key TEXT NOT NULL, created_at INTEGER NOT NULL,
    lifecycle_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lifecycle_revision)='integer' AND lifecycle_revision>=0), UNIQUE(user_id,provider,name_key));
  CREATE INDEX declared_accounts_by_owner ON declared_accounts (user_id,provider,id);
  ALTER TABLE meter_spans ADD COLUMN interrupted_at INTEGER;
  CREATE TRIGGER declared_account_withdrawn AFTER DELETE ON credentials
    WHEN NOT EXISTS (SELECT 1 FROM credentials WHERE user_id=OLD.user_id AND source_id=OLD.source_id)
    BEGIN
      UPDATE declared_accounts SET lifecycle_revision=lifecycle_revision+1
        WHERE user_id=OLD.user_id AND provider=OLD.provider AND source_id=OLD.source_id;
    END;
  `,
  // 12 — sparse histories of safe provider context beside the exact money ledger.
  `
  CREATE TABLE meter_contexts (
    source_id TEXT NOT NULL, item TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
    stale_after_ms INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (source_id,item,from_at)) WITHOUT ROWID;
  CREATE INDEX meter_contexts_by_end ON meter_contexts (to_at);
  `,
  // 13 — shared exchange-rate data and separate monetary valuations.
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
  // 14 — private currency definitions, display preferences and immutable rate bindings.
  `
  CREATE TABLE currency_definitions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL,
    fraction_digits INTEGER NOT NULL, archived_at INTEGER);
  CREATE TABLE currency_preferences (user_id TEXT PRIMARY KEY, currency_id TEXT NOT NULL);
  ALTER TABLE exchange_rates ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX exchange_rates_by_owner ON exchange_rates(owner_id,reference_date);
  CREATE TABLE currency_bindings (
    owner_id TEXT NOT NULL, source_id TEXT NOT NULL, from_currency TEXT NOT NULL, target_currency TEXT NOT NULL,
    observation_at INTEGER NOT NULL, through_at INTEGER NOT NULL, anchor TEXT NOT NULL, steps TEXT NOT NULL,
    PRIMARY KEY(owner_id,source_id,from_currency,target_currency,observation_at,anchor)) WITHOUT ROWID;
  `,
  // 15 — preserve the initial nominal quote without retaining every zero-date revision.
  `
  ALTER TABLE currency_definitions ADD COLUMN initial_quote_id TEXT;
  UPDATE currency_definitions SET initial_quote_id=(SELECT q.id FROM exchange_rates q
    WHERE q.owner_id=currency_definitions.owner_id AND q.source='manual' AND q.reference_date=0
      AND json_type(q.payload,'$.rates."'||currency_definitions.id||'"') IS NOT NULL
    ORDER BY q.fetched_at,q.rowid LIMIT 1);
  `,
  // 16 — recoverable additions, concurrent board views and private connection discovery.
  `
  ALTER TABLE views ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE credentials ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE board_additions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, board_id TEXT,
    item TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    attempt_generation INTEGER NOT NULL DEFAULT 0, run_id TEXT, verify_until INTEGER,
    onboarding_id TEXT UNIQUE, UNIQUE(owner_id, request_id));
  CREATE INDEX additions_by_owner ON board_additions (owner_id, created_at DESC, id DESC);
  CREATE TABLE device_onboarding (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, board_id TEXT NOT NULL,
    code_id TEXT, token_id TEXT, device_id TEXT, source_ids TEXT, addition_id TEXT UNIQUE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
    UNIQUE(user_id, request_id));
  CREATE TABLE account_revisions (
    user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991));
  ${[
    ['holder_added', 'AFTER INSERT ON holders', 'NEW.user_id'],
    ['holder_removed', 'AFTER DELETE ON holders', 'OLD.user_id'],
    ['device_added', 'AFTER INSERT ON devices', 'NEW.user_id'],
    ['token_added', 'AFTER INSERT ON tokens', 'NEW.user_id'],
    ['token_changed', 'AFTER UPDATE OF hash, revoked_at ON tokens WHEN OLD.hash IS NOT NEW.hash OR OLD.revoked_at IS NOT NEW.revoked_at', 'NEW.user_id'],
    ['device_changed', 'AFTER UPDATE OF token_id, token_hash, revoked_at, label ON devices WHEN OLD.token_id IS NOT NEW.token_id OR OLD.token_hash IS NOT NEW.token_hash OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.label IS NOT NEW.label', 'NEW.user_id'],
    ['device_source_added', 'AFTER INSERT ON device_sources', '(SELECT user_id FROM devices WHERE id=NEW.device_id)'],
    ['device_source_changed', 'AFTER UPDATE OF source_id ON device_sources WHEN OLD.source_id IS NOT NEW.source_id', '(SELECT user_id FROM devices WHERE id=NEW.device_id)'],
    ['credential_added', 'AFTER INSERT ON credentials', 'NEW.user_id'],
    ['credential_removed', 'AFTER DELETE ON credentials', 'OLD.user_id'],
    ['credential_changed', 'AFTER UPDATE OF access_revision, expires_at, expiry_kind, last_error, unreadable ON credentials WHEN OLD.access_revision IS NOT NEW.access_revision OR OLD.expires_at IS NOT NEW.expires_at OR OLD.expiry_kind IS NOT NEW.expiry_kind OR OLD.last_error IS NOT NEW.last_error OR OLD.unreadable IS NOT NEW.unreadable', 'NEW.user_id'],
  ].map(([name, event, owner]) => `CREATE TRIGGER connections_${name} ${event} BEGIN
    INSERT INTO account_revisions (user_id,revision) VALUES (${owner},1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
  END;`).join('\n')}
  `,
  // 17 — reversible personal currencies, immutable pair lifecycle and recoverable settings saves.
  `
  CREATE TABLE currency_rate_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, currency_id TEXT NOT NULL,
    base TEXT NOT NULL, effective_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('rate','stop')), quote_id TEXT,
    CHECK((kind='rate' AND quote_id IS NOT NULL) OR (kind='stop' AND quote_id IS NULL)));
  CREATE INDEX currency_rate_timeline ON currency_rate_changes(owner_id,currency_id,base,effective_at,sequence);
  INSERT INTO currency_rate_changes(owner_id,currency_id,base,effective_at,recorded_at,kind,quote_id)
    SELECT q.owner_id,d.id,json_extract(q.payload,'$.base'),q.reference_date,q.fetched_at,'rate',q.id
    FROM exchange_rates q JOIN currency_definitions d ON d.owner_id=q.owner_id
    WHERE q.source='manual' AND json_type(q.payload,'$.rates."'||d.id||'"') IS NOT NULL
    ORDER BY q.reference_date,q.fetched_at,q.id;
  CREATE TABLE currency_unavailable_observations (
    owner_id TEXT NOT NULL, source_id TEXT NOT NULL, from_currency TEXT NOT NULL, target_currency TEXT NOT NULL,
    observation_at INTEGER NOT NULL, anchor TEXT NOT NULL,
    PRIMARY KEY(owner_id,source_id,from_currency,target_currency,observation_at,anchor)) WITHOUT ROWID;
  CREATE TABLE currency_mutations (
    owner_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    response TEXT NOT NULL, status INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,request_id)) WITHOUT ROWID;
  `,
  // 18 — public rate ordering reveals only the owner's own activity.
  `
  ALTER TABLE currency_rate_changes ADD COLUMN owner_sequence INTEGER NOT NULL DEFAULT 0;
  WITH numbered AS (SELECT sequence,row_number() OVER (PARTITION BY owner_id ORDER BY sequence) n FROM currency_rate_changes)
    UPDATE currency_rate_changes SET owner_sequence=(SELECT n FROM numbered WHERE numbered.sequence=currency_rate_changes.sequence);
  CREATE UNIQUE INDEX currency_rate_owner_sequence ON currency_rate_changes(owner_id,owner_sequence);
  INSERT INTO meta(key,value) SELECT 'currencyRateSequence:'||owner_id,CAST(max(owner_sequence) AS TEXT)
    FROM currency_rate_changes GROUP BY owner_id;
  `,
  // 19 — independently placed quota and budget analytics, with frozen addition targets.
  `ALTER TABLE board_additions ADD COLUMN widget_targets TEXT;`,
  // 20 — exact native credit coefficients and explicit financial consent on mixed sources.
  `
  ALTER TABLE readings ADD COLUMN amount_scale INTEGER NOT NULL DEFAULT 6 CHECK(amount_scale BETWEEN 0 AND 18);
  ALTER TABLE shares ADD COLUMN budget_since INTEGER;
  ALTER TABLE shares ADD COLUMN budget_anchor_at INTEGER;
  ALTER TABLE shares ADD COLUMN budget_revision TEXT NOT NULL DEFAULT '';
  UPDATE shares SET budget_revision=lower(hex(randomblob(16)));
  UPDATE shares SET budget_since=0,budget_anchor_at=0 WHERE source_id IN (SELECT id FROM sources WHERE provider IN ('openrouter','deepseek'));
  CREATE INDEX shares_budget_pending ON shares(source_id,budget_since) WHERE budget_anchor_at IS NULL AND budget_since IS NOT NULL;
  `,
  // 21 — coding clients have optional funding, independent process identities and inventory.
  `
  ALTER TABLE agent_sessions RENAME TO agent_sessions_before_clients;
  CREATE TABLE agent_sessions (
    id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, client TEXT NOT NULL CHECK(length(client)>0),
    source_id TEXT, origin TEXT NOT NULL, started_at INTEGER NOT NULL,
    project TEXT NOT NULL, folder TEXT NOT NULL, ordinal INTEGER NOT NULL, producer_id TEXT,
    account_by TEXT CHECK(account_by IN ('login','inferred','legacy')),
    route_class TEXT CHECK(route_class IN ('subscription','api','unknown')),
    route_by TEXT CHECK(route_by IN ('session','machine')), route_host TEXT, route_provider TEXT);
  INSERT INTO agent_sessions (id,device_id,client,source_id,origin,started_at,project,folder,ordinal,producer_id,account_by)
    SELECT s.id,s.device_id,
      COALESCE((SELECT provider FROM sources WHERE id=s.source_id),
        CASE WHEN instr(s.source_id,':') BETWEEN 2 AND 65 AND substr(s.source_id,1,1) GLOB '[a-z]' AND substr(s.source_id,1,instr(s.source_id,':')-1) NOT GLOB '*[^a-z0-9_-]*' THEN substr(s.source_id,1,instr(s.source_id,':')-1) ELSE 'unknown' END),
      s.source_id,s.origin,s.started_at,s.project,s.folder,s.ordinal,s.producer_id,'legacy'
    FROM agent_sessions_before_clients s;
  DROP TABLE agent_sessions_before_clients;
  CREATE UNIQUE INDEX agent_sessions_legacy_key ON agent_sessions
    (device_id,client,COALESCE(source_id,''),started_at,origin,project,folder,ordinal) WHERE producer_id IS NULL;
  CREATE UNIQUE INDEX agent_sessions_stable_key ON agent_sessions
    (device_id,client,producer_id,COALESCE(source_id,''),origin,project,folder) WHERE producer_id IS NOT NULL;
  CREATE INDEX agent_sessions_by_project ON agent_sessions(device_id,project,source_id,client);
  CREATE TABLE device_clients (device_id TEXT NOT NULL,client TEXT NOT NULL,version TEXT,seen_at INTEGER NOT NULL,
    PRIMARY KEY(device_id,client)) WITHOUT ROWID;
  CREATE TRIGGER device_clients_revoked AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL BEGIN
    DELETE FROM device_clients WHERE device_id=NEW.id;
  END;
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
    for (const step of STEPS.slice(adoptDeclaredLayout(db,current))) db.exec(step);
    if (current < 19) migrateAnalyticsViews(db, now);
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
