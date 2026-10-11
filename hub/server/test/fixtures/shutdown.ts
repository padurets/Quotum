import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {runHub} from '../../main.js';
import {Store} from '../../store/store.js';
import {Currencies} from '../../currencies/service.js';

const scenario = process.env.QUOTUM_TEST_STOP;
const close = Store.prototype.close;
Store.prototype.close = function () {
  close.call(this);
  appendFileSync(path.join(process.env.QUOTUM_DATA_DIR!, 'closed'), 'closed\n');
};
if (scenario === 'integration') {
  // Cancellation need not settle a third-party promise. HTTP must drain alongside it.
  Currencies.prototype.stop = () => new Promise(() => {});
}
if (scenario === 'failure') Currencies.prototype.stop = async () => { throw new Error('synthetic-secret-sentinel'); };
if (scenario === 'busy') {
  process.prependListener('SIGTERM', () => {
    const end = Date.now() + 200;
    while (Date.now() < end) { /* A busy turn delays the child's signal handler. */ }
  });
}
await runHub(app => {
  app.get('/test/hang', async () => new Promise(() => {}));
});
