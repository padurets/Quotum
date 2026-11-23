import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {panningSet, seedPanningBudgets} from '../../bench/fixture.js';
import {SETS} from '../../demo/catalogue.js';
import {seedWork, setUp} from '../../demo/setup.js';
import {buildApp} from '../../server/api.js';
import {Cadence} from '../../server/cadence.js';
import {Duty} from '../../server/duty.js';
import {Events} from '../../server/events.js';
import {HistoryTiles} from '../../server/history.js';
import {Ingest} from '../../server/ingest.js';
import {Pairing} from '../../server/pairing.js';
import {PeriodReader} from '../../server/periodRead.js';
import {ResetFeed} from '../../server/resets.js';
import {Setup} from '../../server/setup.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';

/** Feed the same SQLite measurements, native work and monetary histories as the browser fixture. */
export async function seedCyclePhase(t: TestContext, now: number) {
  t.mock.timers.enable({apis: ['Date'], now});
  const dir = mkdtempSync(join(tmpdir(), 'quotum-history-cycle-')),
    file = join(dir, 'quotum.sqlite'),
    store = new Store(file, now),
    directory = new Directory(store.db);
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const code = 'BCDF-GHJK',
    app = await buildApp(cycleHub(store, directory, new Setup(true, code))),
    base = 'http://127.0.0.1';
  // The demo uses public HTTP requests. Keep their serialization and routing inside this process.
  const wire = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(new URL(url).origin, base);
    const response = await app.inject({
      method: options.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: url.slice(base.length),
      headers: {...Object.fromEntries(new Headers(options.headers)), host: '127.0.0.1'},
      payload: options.body as string | undefined,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, String(value));
    }
    return new Response(response.statusCode === 204 ? null : response.payload, {
      headers,
      status: response.statusCode,
    });
  });
  let stand;
  try {
    stand = await setUp(base, panningSet(SETS[0]), now, code, Date.now, true);
    seedWork(store, stand);
    seedPanningBudgets(file, stand);
  } finally {
    wire.mock.restore();
    await app.close();
    store.close();
    t.mock.timers.reset();
  }
  const owner = [...stand.people.values()][0];
  return {file, dir, user: owner.id, board: owner.personalBoard};
}

export type CycleSeed = Awaited<ReturnType<typeof seedCyclePhase>>;

function cycleHub(store: Store, directory: Directory, setup: Setup) {
  return {
    store,
    directory,
    ingest: new Ingest(store, directory, new Duty(), new Cadence()),
    resets: new ResetFeed(undefined, () => {}),
    pairing: new Pairing(directory),
    setup,
    local: null,
  };
}

/** Each navigation gets an independent database and event feed, including its own late writes. */
export function cycleSeed(seed: CycleSeed, now: number) {
  const dir = mkdtempSync(join(seed.dir, 'reader-')),
    file = join(dir, 'quotum.sqlite');
  copyFileSync(seed.file, file);
  const store = new Store(file, now),
    directory = new Directory(store.db),
    hub = cycleHub(store, directory, new Setup(false, null)),
    events = new Events(hub, undefined, {now: () => Date.now(), after: () => () => {}}, null),
    tiles = new HistoryTiles(store),
    reader = new PeriodReader(hub, tiles, events);
  events.onHistory = (source, since, scopes, work) => {
    tiles.touch(source, since, scopes);
    reader.touch(source, since, scopes, work);
  };
  events.onClientHistory = (user, since, device) => {
    tiles.touchClient(user, since, device);
    reader.touchClient(user, since, device);
  };
  events.attach();
  return {
    store,
    directory,
    events,
    reader,
    board: seed.board,
    user: seed.user,
    close() {
      events.close();
      store.close();
      rmSync(dir, {recursive: true, force: true});
    },
  };
}
