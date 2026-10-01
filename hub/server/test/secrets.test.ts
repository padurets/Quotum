import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SecretError, SecretKey, readInputs, startSecrets, type SecretInputs} from '../secrets/index.js';
import {secretCode, type SecretCode} from '../secrets/crypto.js';
import {Store} from '../store/store.js';

const key = (byte = 0) => SecretKey.parse(Buffer.from(Buffer.alloc(32, byte).toString('base64url')));
const inputs = (current: SecretKey | null, previous: SecretKey | null = null): SecretInputs => ({current, previous, reset: null, storageAtStart: null, wasFileAtStart: false});
const identity = {id: 'credential-test', user_id: 'user-test', provider: 'test'};
const canary = Buffer.from('CANARY_QUOTUM_KEY_0123456789');
function insert(db: DatabaseSync, k = key(), id = identity.id) {
  const record = {...identity, id};
  const sealed = k.seal(record, canary);
  db.prepare("INSERT INTO credentials (id, user_id, provider, cipher, nonce, key_version, abilities, created_at) VALUES (?, ?, ?, ?, ?, 1, '[]', 1)").run(id, record.user_id, record.provider, sealed.cipher, sealed.nonce);
  return {...record, ...sealed};
}
const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM credentials ORDER BY id').all();
const fail = (code: string) => (error: unknown) => error instanceof SecretError && error.code === code && error.message === code && !('cause' in error);

test('runtime error codes cannot turn arbitrary supplier or database text into a private DTO', () => {
  const error = new SecretError(canary.toString() as SecretCode);
  assert.equal(error.code, 'credential_failed');
  assert.equal(error.message, 'credential_failed');
  assert.equal(secretCode(canary.toString()), null);
  assert.equal(inspect(error).includes(canary.toString()), false);
});

test('the shared HKDF/KCV/AAD vector opens, with no key serialization', () => {
  const k = key();
  assert.equal(k.checkValue, 'fb5238eccc6095ae26dd1f2fe0867d6802fb676e7d1dc1c49043df93fb671759');
  assert.equal(k.fingerprint, 'fb5238eccc6095ae');
  const record = {...identity, nonce: Buffer.alloc(12), cipher: Buffer.from('b34f3d2ee3934a74b45fe564432c6e6d6cc581ae6a08d31b4c217d40556c456571b5bef13112734d29a7acca', 'hex')};
  k.use(record, plain => assert.deepEqual(plain, canary));
  assert.equal(JSON.stringify(k), 'null');
  assert.equal(inspect(k), '[SecretKey]');
  assert.equal(k.matches(key(1).checkValue), false);
});

test('seal uses fresh nonces; authentication binds id, owner, provider, nonce and tag', () => {
  const k = key();
  const a = k.seal(identity, canary), b = k.seal(identity, canary);
  assert.notDeepEqual(a.nonce, b.nonce);
  for (const change of [{id: 'other'}, {user_id: 'other'}, {provider: 'other'}, {nonce: Buffer.alloc(12)}, {cipher: Buffer.alloc(a.cipher.length)}, {nonce: Buffer.alloc(11)}, {cipher: Buffer.alloc(15)}]) {
    assert.throws(() => k.use({...identity, ...a, ...change}, () => assert.fail('unauthenticated plaintext')), fail('credential_unreadable'));
  }
  let borrowed: Buffer | undefined;
  assert.throws(() => k.use({...identity, ...a}, plain => { borrowed = plain; throw new Error('consumer'); }));
  assert.ok(borrowed?.every(byte => byte === 0));
});

test('KEK format rejects invalid bytes and noncanonical trailing bits', () => {
  const valid = Buffer.alloc(32).toString('base64url');
  for (const value of [valid + '=', valid.slice(0, -1) + 'B', valid + '\n', valid.slice(1), '\0' + valid.slice(1), 'é' + valid.slice(2)]) assert.throws(() => SecretKey.parse(Buffer.from(value)), fail('secret_key_invalid'));
  assert.throws(() => SecretKey.parse(Buffer.alloc(43, 255)), fail('secret_key_invalid'));
});

test('input capture removes the secret namespace even on failure and checks variable presence', () => {
  const env: Record<string, string | undefined> = {QUOTUM_SECRET_KEY: '', QUOTUM_SECRET_KEY_FILE: '', QUOTUM_SECRET_KEY_EXTRA: 'private', KEEP: 'ok'};
  assert.throws(() => readInputs(env, '.', false), fail('secret_key_configuration_invalid'));
  assert.deepEqual(env, {KEEP: 'ok'});
  assert.equal(Reflect.get(process.report, 'excludeEnv'), true);
  assert.equal(Object.hasOwn(process.report.getReport()!, 'environmentVariables'), false);
  for (const bad of [{QUOTUM_SECRET_KEY_PREVIOUS: Buffer.alloc(32).toString('base64url')}, {QUOTUM_SECRET_KEY_RESET: ''}]) assert.throws(() => readInputs(bad, '.', false), fail('secret_key_configuration_invalid'));
  const ignored = readInputs({QUOTUM_SECRET_KEY_STATE: 'arbitrary'}, '.', false);
  assert.equal(ignored.storageAtStart, null);
  assert.throws(() => readInputs({QUOTUM_SECRET_KEY_STATE: 'arbitrary'}, '.', true), fail('secret_key_configuration_invalid'));
  const local = readInputs({QUOTUM_SECRET_KEY_STATE: 'keystore_was_file'}, '.', true);
  assert.equal(local.storageAtStart, 'keystore');
  assert.equal(local.wasFileAtStart, true);
});

test('key file accepts only the specified byte endings and checks real paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'quotum-key-input-'));
  const data = path.join(root, 'data'); mkdirSync(data);
  const file = path.join(root, 'key');
  const value = Buffer.alloc(32).toString('base64url');
  for (const ending of ['', '\n', '\r\n']) {
    writeFileSync(file, value + ending);
    assert.equal(readInputs({QUOTUM_SECRET_KEY_FILE: file}, data, false).current?.fingerprint, key().fingerprint);
  }
  for (const bad of [value + '\r', value + '\n\n', ' ' + value, value + '\0', Buffer.alloc(43, 255)]) {
    writeFileSync(file, bad);
    assert.throws(() => readInputs({QUOTUM_SECRET_KEY_FILE: file}, data, false), fail('secret_key_invalid'));
  }
  writeFileSync(file, value);
  const inside = path.join(data, 'key'); writeFileSync(inside, value);
  const inward = path.join(root, 'inward'); symlinkSync(inside, inward);
  const outward = path.join(data, 'outward'); symlinkSync(file, outward);
  assert.throws(() => readInputs({QUOTUM_SECRET_KEY_FILE: inward}, data, false), fail('secret_key_file_in_data'));
  assert.equal(readInputs({QUOTUM_SECRET_KEY_FILE: outward}, data, false).current?.fingerprint, key().fingerprint);
});

test('a FIFO key file without a writer is rejected before the child watchdog', {skip: process.platform === 'win32'}, t => {
  const root = mkdtempSync(path.join(tmpdir(), 'quotum-key-fifo-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const data = path.join(root, 'data'); mkdirSync(data);
  const file = path.join(root, 'key');
  execFileSync('mkfifo', [file], {timeout: 5000, killSignal: 'SIGKILL'});
  const script = `import {readInputs, SecretError} from ${JSON.stringify(new URL('../secrets/index.ts', import.meta.url).href)};
    try { readInputs({QUOTUM_SECRET_KEY_FILE: process.argv[1]}, process.argv[2], false); process.stdout.write('unexpected_success'); process.exitCode = 1; }
    catch (error) { process.stdout.write(error instanceof SecretError ? error.code : 'unexpected_error'); }`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('QUOTUM_')));
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, file, data], {env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'});
  assert.equal(result.error, undefined, 'a special file must not hold startup until the watchdog kills it');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'secret_key_invalid');
  assert.equal(result.stderr, '');
});

test('missing and mismatched KEKs preserve every credential and metadata', () => {
  const store = new Store(':memory:');
  const k = key();
  assert.equal(startSecrets(store.db, inputs(k)).outcome, 'created');
  insert(store.db, k);
  const before = rows(store.db);
  assert.deepEqual(startSecrets(store.db, inputs(null)), {outcome: 'missing', stored: k.fingerprint, current: null, credentials: 1, unreadable: 0});
  assert.equal(startSecrets(store.db, inputs(key(1))).outcome, 'mismatch');
  assert.deepEqual(rows(store.db), before);
  assert.equal(startSecrets(store.db, inputs(k, k)).outcome, 'ok');
  store.close();
});

test('a new key can initialize an empty database and replace an unused key', () => {
  const store = new Store(':memory:');
  assert.equal(startSecrets(store.db, inputs(null)).outcome, 'missing');
  assert.equal(startSecrets(store.db, inputs(key())).outcome, 'created');
  assert.equal(startSecrets(store.db, inputs(key(1))).outcome, 'created');
  assert.equal(startSecrets(store.db, inputs(key(1))).outcome, 'ok');
  store.close();
});

test('without KCV, a bad first record does not hide a readable second record', () => {
  const store = new Store(':memory:');
  insert(store.db, key(1), 'a');
  insert(store.db, key(), 'b');
  store.db.exec('UPDATE credentials SET unreadable = 1, key_version = 3');
  const report = startSecrets(store.db, inputs(key()));
  assert.equal(report.outcome, 'ok');
  assert.equal(report.unreadable, 1);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'secretKeyVersion'").get()?.value, '3');
  assert.equal(rows(store.db)[0].unreadable, 1);
  assert.equal(rows(store.db)[1].unreadable, 0);
  store.close();
});

test('without KCV, no authenticated record means mismatch with no changes', () => {
  const store = new Store(':memory:'); insert(store.db, key(1));
  const before = rows(store.db);
  assert.equal(startSecrets(store.db, inputs(key())).outcome, 'mismatch');
  assert.deepEqual(rows(store.db), before);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'secretKeyKcv'").get(), undefined);
  store.close();
});

test('malformed metadata is never treated as a new database', () => {
  for (const values of [['x', '1'], [key().checkValue, '0'], [key().checkValue, '01'], [key().checkValue, '9007199254740992'], [key().checkValue, null]]) {
    const store = new Store(':memory:');
    store.db.prepare('INSERT INTO meta VALUES (?, ?)').run('secretKeyKcv', values[0]);
    if (values[1]) store.db.prepare('INSERT INTO meta VALUES (?, ?)').run('secretKeyVersion', values[1]);
    const before = store.db.prepare('SELECT * FROM meta').all();
    assert.throws(() => startSecrets(store.db, inputs(key())), fail('secret_key_metadata_invalid'));
    assert.deepEqual(store.db.prepare('SELECT * FROM meta').all(), before);
    store.close();
  }
});

test('rotation rewrites readable rows with new nonces and retains damaged ciphertext', () => {
  const store = new Store(':memory:'); const old = key(), next = key(1);
  startSecrets(store.db, inputs(old));
  const a = insert(store.db, old, 'a'); insert(store.db, key(2), 'b');
  const damaged = rows(store.db)[1];
  const report = startSecrets(store.db, inputs(next, old));
  assert.deepEqual(report, {outcome: 'rotated', stored: next.fingerprint, current: next.fingerprint, credentials: 2, unreadable: 1});
  const after = rows(store.db);
  assert.notDeepEqual(after[0].nonce, a.nonce);
  next.use({...identity, id: 'a', cipher: after[0].cipher as Uint8Array, nonce: after[0].nonce as Uint8Array}, plain => assert.deepEqual(plain, canary));
  assert.deepEqual(after[1].cipher, damaged.cipher);
  assert.equal(after[1].key_version, 1);
  assert.equal(after[0].key_version, 2);
  assert.equal(startSecrets(store.db, inputs(next, old)).outcome, 'ok');
  store.close();
});

test('SQL failure rolls back the whole rotation, including KCV', () => {
  const store = new Store(':memory:'); const old = key(); startSecrets(store.db, inputs(old));
  insert(store.db, old, 'a'); insert(store.db, old, 'b');
  const before = rows(store.db);
  store.db.exec("CREATE TRIGGER fail_rotation BEFORE UPDATE ON credentials WHEN OLD.id = 'b' BEGIN SELECT RAISE(ABORT, 'raw-private-failure'); END");
  assert.throws(() => startSecrets(store.db, inputs(key(1), old)), fail('secret_key_start_failed'));
  assert.deepEqual(rows(store.db), before);
  assert.equal(startSecrets(store.db, inputs(old)).outcome, 'ok');
  store.close();
});

test('one-shot reset checks both fingerprints, and never repeats when a backup returns', () => {
  const store = new Store(':memory:'); const old = key(), next = key(1);
  startSecrets(store.db, inputs(old)); const record = insert(store.db, old);
  const intent = {from: old.fingerprint, to: next.fingerprint};
  for (const bad of [{...intent, from: key(2).fingerprint}, {...intent, to: key(2).fingerprint}]) assert.throws(() => startSecrets(store.db, inputs(next), bad), fail('secret_key_reset_conflict'));
  assert.equal(rows(store.db).length, 1);
  assert.equal(startSecrets(store.db, inputs(next), intent).outcome, 'created');
  insert(store.db, next);
  assert.equal(startSecrets(store.db, inputs(next), intent).outcome, 'ok');
  assert.equal(rows(store.db).length, 1, 'repeating the intent does not erase matching credentials');
  store.db.prepare("UPDATE meta SET value = ? WHERE key = 'secretKeyKcv'").run(old.checkValue);
  store.db.prepare('UPDATE credentials SET cipher = ?, nonce = ?').run(record.cipher, record.nonce);
  assert.equal(startSecrets(store.db, inputs(next)).outcome, 'mismatch');
  assert.equal(rows(store.db).length, 1);
  store.close();
});

test('previous-key rotation takes priority over reset, including unreadable records', () => {
  const store = new Store(':memory:'); const old = key(), next = key(1);
  startSecrets(store.db, inputs(old)); insert(store.db, old);
  assert.equal(startSecrets(store.db, inputs(next, old), {from: old.fingerprint, to: next.fingerprint}).outcome, 'rotated');
  assert.equal(rows(store.db).length, 1);
  store.close();
});

test('explicit reset can erase legacy rows without KCV, but missing KEK never can', () => {
  const store = new Store(':memory:'); insert(store.db, key(1));
  assert.throws(() => startSecrets(store.db, inputs(null), {from: null, to: key().fingerprint}), fail('secret_key_reset_conflict'));
  assert.equal(startSecrets(store.db, inputs(key()), {from: null, to: key().fingerprint}).outcome, 'created');
  assert.equal(rows(store.db).length, 0);
  store.close();
});

test('busy checkpoint refuses a positive report after commit; same-current retry finishes it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'quotum-key-checkpoint-'));
  const file = path.join(root, 'db.sqlite');
  const store = new Store(file); const old = key(), next = key(1);
  startSecrets(store.db, inputs(old)); const original = insert(store.db, old);
  const reader = new DatabaseSync(file);
  reader.exec('BEGIN'); reader.prepare('SELECT * FROM credentials').all();
  store.db.exec('PRAGMA busy_timeout = 1');
  assert.throws(() => startSecrets(store.db, inputs(next, old)), fail('secret_key_checkpoint_pending'));
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'secretKeyKcv'").get()?.value, next.checkValue, 'commit already happened');
  assert.ok(readFileSync(file + '-wal').includes(Buffer.from(original.cipher)));
  reader.exec('COMMIT'); reader.close();
  assert.equal(startSecrets(store.db, inputs(next, old)).outcome, 'ok');
  assert.equal(readFileSync(file + '-wal').length, 0);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(readFileSync(file + suffix).includes(canary), false);
  store.close();
});
