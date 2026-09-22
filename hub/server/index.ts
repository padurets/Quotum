import {chmodSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {config} from './config.js';
import {Store} from './store/store.js';
import {ResetFeed} from './sources/resets.js';
import {buildApp} from './api.js';
import {Ingest} from './ingest.js';
import {Duty} from './duty.js';
import {Pairing} from './pairing.js';
import {Directory} from './store/directory.js';

mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
const databaseFile = path.join(config.dataDir, config.databaseFile);
const store = new Store(databaseFile);
chmodSync(databaseFile, 0o600);
const directory = new Directory(store.db);

const ingest = new Ingest(store, directory, config.ingest.tokens, new Duty());
const resets = new ResetFeed();
const app = await buildApp({store, directory, resets, ingest, pairing: new Pairing(directory)});
await app.listen({host: config.http.host, port: config.http.port});
console.log(JSON.stringify({event: 'start', users: directory.userCount()}));
resets.start();

const prune = () => store.prune(Date.now());
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
