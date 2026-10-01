/** Explicit test composition over the built hub, never a production connector or route. */
import {mkdirSync} from 'node:fs';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {TLS_CERT, TLS_KEY} from './connector-tls.fixture.js';

const built = new URL('../../../dist/server/', import.meta.url);
const {Store} = await import(new URL('store/store.js', built).href) as typeof import('../../store/store.js');
const {Directory} = await import(new URL('store/directory.js', built).href) as typeof import('../../store/directory.js');
const secrets = await import(new URL('secrets/index.js', built).href) as typeof import('../../secrets/index.js');
const {ConnectorTransport} = await import(new URL('connectors/index.js', built).href) as typeof import('../../connectors/index.js');
const {buildApp} = await import(new URL('api.js', built).href) as typeof import('../../api.js');
const {Ingest} = await import(new URL('ingest.js', built).href) as typeof import('../../ingest.js');
const {Duty} = await import(new URL('duty.js', built).href) as typeof import('../../duty.js');
const {Cadence} = await import(new URL('cadence.js', built).href) as typeof import('../../cadence.js');
const {Pairing} = await import(new URL('pairing.js', built).href) as typeof import('../../pairing.js');
const {ResetFeed} = await import(new URL('resets.js', built).href) as typeof import('../../resets.js');
const {Setup} = await import(new URL('setup.js', built).href) as typeof import('../../setup.js');
const {hashPassword} = await import(new URL('domain/auth.js', built).href) as typeof import('../../domain/auth.js');
const say = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');

try {
  process.umask(0o077);
  const data = process.env.QUOTUM_DATA_DIR!; mkdirSync(data, {recursive:true, mode:0o700});
  const inputs = secrets.readInputs(process.env, data, false);
  const store = new Store(path.join(data, 'quotum.sqlite'));
  const report = secrets.startSecrets(store.db, inputs);
  const directory = new Directory(store.db);
  if (!directory.userCount()) {
    const alice = directory.createUser('alice@fixture.example', 'Alice', await hashPassword('fixture-password'), Date.now());
    const bob = directory.createUser('bob@fixture.example', 'Bob', await hashPassword('fixture-password'), Date.now());
    const team = directory.createBoard('Shared fixture', alice.id, Date.now()); directory.addMember(team.id, bob.id, Date.now());
  }
  const supplier = createServer({key:TLS_KEY, cert:TLS_CERT}, (request, response) => response.end(JSON.stringify({ok:true, echo:request.headers.authorization, creator_user_id:'ignored'})));
  supplier.listen(0, '127.0.0.1'); await once(supplier, 'listening');
  const transport = new ConnectorTransport({host:'127.0.0.1', port:(supplier.address() as AddressInfo).port, operations:{probe:{path:'/probe'}}}, {ca:TLS_CERT});
  const credentials = new secrets.Credentials(store, inputs.current, report, new Map([['test', {id:'test', secretFormat:(value:string) => value.length >= 16, abilities:['balance'], transport, map:() => ({abilities:['balance'], expiresAt:null}), identify:async () => ({account:'0'.repeat(24),abilities:['balance'],expiresAt:Date.now()+3_600_000}), measure:async () => {throw new secrets.SecretError('connector_invalid_response');}}]]));
  const app = await buildApp({store, directory, credentials, ingest:new Ingest(store, directory, new Duty(), new Cadence()), pairing:new Pairing(directory), resets:new ResetFeed(undefined, () => {}), setup:new Setup(false, null), local:null});
  await app.listen({host:'127.0.0.1', port:0}); say({event:'start', port:(app.server.address() as AddressInfo).port, secretKey:report});
  const lines = createInterface({input:process.stdin});
  for await (const line of lines) {
    try {
      const command: unknown = JSON.parse(line);
      if (!command || typeof command !== 'object' || !('op' in command)) throw new secrets.SecretError('credential_invalid');
      if (command.op === 'probe' && 'id' in command && typeof command.id === 'string') {
        const owner = directory.credentials('alice@fixture.example')!.user.id;
        try { await credentials.probe(owner, command.id, 'probe'); say({event:'probe', code:'ok'}); }
        catch (error) { say({event:'probe', code:error instanceof secrets.SecretError ? error.code : 'credential_failed'}); }
      } else if (command.op === 'fault') {
        store.db.function('test_failure', () => { throw new Error('CANARY_PRIVATE_PROVIDER_0123456789'); });
        store.db.exec('CREATE TRIGGER test_failure BEFORE UPDATE ON credentials BEGIN SELECT test_failure(); END'); say({event:'fault', code:'ok'});
      } else if (command.op === 'clear_fault') {
        store.db.exec('DROP TRIGGER test_failure'); say({event:'clear_fault', code:'ok'});
      } else throw new secrets.SecretError('credential_invalid');
    } catch (error) { say({event:'operation', code:error instanceof secrets.SecretError ? error.code : 'credential_failed'}); }
  }
  await app.close(); transport.close(); supplier.closeAllConnections(); supplier.close(); store.close();
} catch (error) {
  say({event:'error', code:error instanceof secrets.SecretError ? error.code : 'credential_failed'});
  process.exitCode = 1;
}
