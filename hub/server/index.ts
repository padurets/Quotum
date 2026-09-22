import {chmodSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {config} from './config.js';
import {Store} from './store/store.js';
import {VendorClient} from './sources/vendor.js';
import {Collector} from './collector.js';
import {ResetFeed} from './sources/resets.js';
import {buildApp} from './api.js';
import {Ingest} from './ingest.js';
import {Pairing} from './pairing.js';
import {Directory} from './store/directory.js';

mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
const databaseFile = path.join(config.dataDir, config.databaseFile);
// The built-in CodexBar collector runs only when its token is present; agents can always push.
const collecting = !!config.vendor.token;
const store = new Store(databaseFile, Date.now(), {legacyDefaults: collecting});
chmodSync(databaseFile, 0o600);
const directory = new Directory(store.db);

const collector = collecting ? new Collector(store, new VendorClient()) : null;
const ingest = new Ingest(store, directory, config.ingest.tokens, !collector);
const resets = new ResetFeed();
const app = await buildApp({store, directory, pacer: collector ?? ingest, resets, ingest, pairing: new Pairing(directory)});
await app.listen({host: config.http.host, port: config.http.port});
console.log(JSON.stringify({event: 'start', collector: !!collector, users: directory.userCount()}));
collector?.start();
resets.start();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  resets.stop();
  await collector?.stop();
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
