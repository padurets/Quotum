import type {DatabaseSync} from 'node:sqlite';

/** Adopt the unreleased declared-account layouts without changing released migration steps. */
export function adoptDeclaredLayout(db:DatabaseSync,current:number):number {
  if(current<10||current>14||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='declared_accounts'").get()||db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_identity'").get())return current;
  db.exec(`
    CREATE TABLE source_identity (
      source_id TEXT PRIMARY KEY REFERENCES sources(id), kind TEXT NOT NULL CHECK(kind IN ('supplier','declared')),
      owner_id TEXT REFERENCES users(id), CHECK((kind='declared' AND owner_id IS NOT NULL) OR (kind='supplier' AND owner_id IS NULL)));
    INSERT INTO source_identity SELECT id,'supplier',NULL FROM sources WHERE provider='openrouter';
    INSERT INTO source_identity SELECT source_id,'declared',user_id FROM declared_accounts;
    ALTER TABLE meter_spans ADD COLUMN hold_until INTEGER;
    DROP TRIGGER IF EXISTS declared_account_withdrawn;
    CREATE TABLE credentials_next (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT,
      cipher BLOB NOT NULL, nonce BLOB NOT NULL, key_version INTEGER NOT NULL,
      hint TEXT, abilities TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
      last_used_at INTEGER, last_error TEXT, unreadable INTEGER NOT NULL DEFAULT 0,
      expiry_kind TEXT NOT NULL DEFAULT 'none' CHECK(expiry_kind IN ('dated','none','unknown')));
    INSERT INTO credentials_next SELECT id,user_id,provider,source_id,cipher,nonce,key_version,hint,abilities,
      created_at,expires_at,last_used_at,last_error,unreadable,CASE expiry_kind WHEN 'at' THEN 'dated' ELSE expiry_kind END FROM credentials;
    DROP TABLE credentials;
    ALTER TABLE credentials_next RENAME TO credentials;
    CREATE INDEX credentials_by_owner ON credentials(user_id,provider);
    CREATE INDEX credentials_by_source ON credentials(source_id,created_at,id);
    CREATE TRIGGER declared_account_withdrawn AFTER DELETE ON credentials
      WHEN NOT EXISTS(SELECT 1 FROM credentials WHERE user_id=OLD.user_id AND source_id=OLD.source_id)
      BEGIN
        UPDATE declared_accounts SET lifecycle_revision=lifecycle_revision+1
          WHERE user_id=OLD.user_id AND provider=OLD.provider AND source_id=OLD.source_id;
      END;
  `);
  return current+1;
}
