import {chmodSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {config} from './config.js';
import {Store} from './store/store.js';
import {VendorClient} from './sources/vendor.js';
import {Collector} from './collector.js';
import {ResetFeed} from './sources/resets.js';
import {buildApp} from './api.js';

mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
const databaseFile = path.join(config.dataDir, config.databaseFile);
const store = new Store(databaseFile);
chmodSync(databaseFile, 0o600);

const collector = new Collector(store, new VendorClient());
const resets = new ResetFeed();
const app = await buildApp(store, collector, resets);
await app.listen({host: config.http.host, port: config.http.port});
collector.start();
resets.start();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  resets.stop();
  await collector.stop();
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
