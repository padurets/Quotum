import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildApp} from '../../server/api.js';
import {Cadence} from '../../server/cadence.js';
import {decodeOpenRouter, openRouter} from '../../server/connectors/openrouter.js';
import {ConnectorTransport} from '../../server/connectors/transport.js';
import {WIDGETS, widgetVisible} from '../../server/domain/widgets.js';
import {Duty} from '../../server/duty.js';
import {Ingest} from '../../server/ingest.js';
import {Pairing} from '../../server/pairing.js';
import {ResetFeed} from '../../server/resets.js';
import {Credentials, SecretKey, startSecrets} from '../../server/secrets/index.js';
import {Setup} from '../../server/setup.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';
import type {Snapshot} from '../../ui/lib/board.js';
import {accessTone, budgetView, capLeft} from '../../ui/lib/money.js';
import {SETS} from '../catalogue.js';
import {earliest} from '../model.js';
import {setUp} from '../setup.js';
import {
  seedShowcaseOpenRouter,
  SHOWCASE_OPENROUTER_KEY,
  showcaseOpenRouterReply,
} from '../showcaseOpenRouter.js';

test('the wallet showcase connects a live budget and three distinct active allowances', async t => {
  const start = Date.UTC(2026, 10, 20, 17, 30);
  t.mock.timers.enable({apis: ['Date'], now: start});
  const store = new Store(':memory:', start);
  const directory = new Directory(store.db);
  const key = SecretKey.parse(Buffer.from(Buffer.alloc(32, 31).toString('base64url')));
  const report = startSecrets(store.db, {
    current: key,
    previous: null,
    reset: null,
    storageAtStart: null,
    wasFileAtStart: false,
  });
  const transport = new ConnectorTransport({host: '127.0.0.1', port: 443, operations: {}});
  const expiresAt = new Date(start + 14 * 86_400_000).toISOString();
  transport.send = async (operation, secret, query = {}) => {
    assert.equal(secret.toString('ascii'), SHOWCASE_OPENROUTER_KEY);
    return decodeOpenRouter(JSON.stringify(showcaseOpenRouterReply(operation, expiresAt, query)));
  };
  const credentials = new Credentials(
    store,
    key,
    report,
    new Map([['openrouter', openRouter(transport)]]),
  );
  const app = await buildApp({
    store,
    directory,
    credentials,
    ingest: new Ingest(store, directory, new Duty(), new Cadence()),
    pairing: new Pairing(directory),
    setup: new Setup(true, 'BCDF-GHJK'),
    resets: new ResetFeed(undefined, () => {}),
    local: null,
  });
  t.after(async () => {
    await app.close();
    transport.close();
    store.close();
  });
  const base = await app.listen({host: '127.0.0.1', port: 0});
  const set = SETS.find(set => set.id === 'showcase-openrouter')!;
  const stand = await setUp(base, set, start, 'BCDF-GHJK', Date.now, true);
  await seedShowcaseOpenRouter(directory, stand);
  const owner = stand.people.get('alex')!;
  const [credential] = credentials.details(owner.id);
  assert.equal(credential.expiresAt, Date.parse(expiresAt));
  t.mock.timers.tick(1000);
  await credentials.measure(credential.sourceId!);

  const board = await owner.get<Snapshot>('/api/overview?board=' + owner.personalBoard);
  assert.equal(board.historyStart, start + earliest(set));
  assert.equal(board.sources.length, 2);
  const wallet = board.sources.find(s => s.provider === 'openrouter')!;
  const claude = board.sources.find(s => s.provider === 'claude')!;
  assert.deepEqual(
    [claude, wallet].map(s => {
      const {x, w} = board.view.layout.places['source:' + s.id];
      return [x, w];
    }),
    [
      [0, 3],
      [3, 3],
    ],
  );
  assert.deepEqual(
    WIDGETS.filter(id => widgetVisible(board.view, id, 2)),
    [],
  );
  assert.deepEqual(wallet.inventory, {complete: true, observed: 3, missing: 0, error: null});
  assert.equal(accessTone(board.sourceAccess![wallet.id], Date.now()), 'neutral');
  const budget = budgetView(wallet, wallet.keys);
  const [{total}] = budget.remaining.values;
  assert.deepEqual([total.amount, total.unit, total.stale], ['42800000', 'USD', false]);
  assert.deepEqual(
    budget.limits
      .map(({part, meter}) => [
        part.name,
        part.disabled,
        meter.scope,
        capLeft(meter),
        meter.limit,
        meter.stale,
      ])
      .sort(),
    [
      ['ci-review', false, 'weekly', '4200000', '20000000', false],
      ['coding-agent', false, 'daily', '6500000', '15000000', false],
      ['dev-workstation', false, 'monthly', '18400000', '50000000', false],
    ],
  );
});
