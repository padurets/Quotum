import {chmodSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {config} from './config.js';
import {Store} from './store/store.js';
import {VendorClient} from './sources/vendor.js';
import {Collector} from './collector.js';
import {ResetFeed} from './sources/resets.js';
import {buildApp, type Pacer} from './api.js';
import {Ingest} from './ingest.js';

mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
const databaseFile = path.join(config.dataDir, config.databaseFile);
const store = new Store(databaseFile);
chmodSync(databaseFile, 0o600);

// CodexBar is collected only when its token is present; agents push when ingest tokens are set.
const collector = config.vendor.token ? new Collector(store, new VendorClient()) : null;
const ingest = config.ingest.tokens.length ? new Ingest(store, config.ingest.tokens, !collector) : null;
const idle: Pacer = {
  status: () => ({collecting: false, cycle: 0, nextAt: Date.now() + config.collection.intervalMs, intervalMs: config.collection.intervalMs}),
};
const resets = new ResetFeed();
const app = await buildApp(store, collector ?? ingest ?? idle, resets, ingest);
await app.listen({host: config.http.host, port: config.http.port});
console.log(JSON.stringify({event: 'start', collector: !!collector, ingest: !!ingest}));
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
