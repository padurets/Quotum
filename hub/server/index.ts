import {chmodSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {config} from './config.js';
import {Store} from './store/store.js';
import {ResetFeed} from './resets.js';
import {buildApp} from './api.js';
import {Ingest} from './ingest.js';
import {Duty} from './duty.js';
import {Pairing} from './pairing.js';
import {Directory} from './store/directory.js';
import {Setup} from './setup.js';

// The database and its WAL files are readable by this user only.
process.umask(0o077);
mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
const databaseFile = path.join(config.dataDir, config.databaseFile);
const store = new Store(databaseFile);
chmodSync(databaseFile, 0o600);
const directory = new Directory(store.db);

const resets = new ResetFeed();
const setup = new Setup(directory.userCount() === 0, config.auth.setupCode);
const app = await buildApp({store, directory, resets, ingest: new Ingest(store, directory, new Duty()), pairing: new Pairing(directory), setup});
await app.listen({host: config.http.host, port: config.http.port});
console.log(JSON.stringify({event: 'start', users: directory.userCount()}));
if (setup.pending) {
  const where = config.auth.publicUrl ? `Open ${config.auth.publicUrl}` : `Open the hub in a browser (it listens on port ${config.http.port})`;
  console.log(`\nQuotum has no account yet. ${where} and create the first one with the setup code ${setup.pending}\n`);
}
resets.start();

const prune = () => {
  const now = Date.now();
  store.prune(now);
  directory.prune(now);
};
prune();
const pruning = setInterval(prune, 3_600_000);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(pruning);
  resets.stop();
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
