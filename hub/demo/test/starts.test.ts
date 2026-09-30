import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseBatch, subscriptionKey, toMeasurement} from '../../server/domain/ingest.js';
import {Forecasts} from '../../server/forecasts.js';
import {Store} from '../../server/store/store.js';
import {announcedOf} from '../../ui/lib/forecast.js';
import type {SeriesForecast, Win} from '../../ui/lib/types.js';
import {SCENES, SETS} from '../catalogue.js';
import {awake, cards, DAY, delivered, historyTimes, machineInfo, machineOf, MIN, snapshot, spanOf, type Card, type DemoSet} from '../model.js';
import {cadence, forecastCodes, points, resetsOf} from './reads.js';

/** The codes of a line of the table that say where a weekly window leads (`CardCheck`). */
const CODES = ['outlook', 'tone', 'unit', 'burst', 'cold', 'why'];

/**
 * Other starts than the catalogue test's, at the same minute of the hour: other hours of the
 * day in UTC, which is where the demo's days begin for the forecast (the demo goes by
 * offsets from its start, so a day of the week alone changes nothing). Each with an hour of
 * its own for the subscriptions' forecasts, which goes by a source's id, and some of the
 * catalogue's ids by its random users': whole, as late as it gets, or the cards' own here.
 */
const STARTS: {at: number; shift?: (source: string) => number}[] = [
  {at: Date.UTC(2026, 8, 21, 4, 7), shift: () => 0},
  {at: Date.UTC(2026, 8, 24, 12, 7), shift: () => 599_000},
  {at: Date.UTC(2026, 8, 26, 18, 7)},
];

/** When the catalogue test measures a card, as `Live` does, up to `until`: its history, then on its machines' cadence, each with the time to the next. */
function times(set: DemoSet, card: Card, until: number): {t: number; next: number}[] {
  const found = historyTimes(set, card).map(({t, step}) => ({t, next: step}));
  const machines = card.machines.map(name => machineOf(set, name));
  for (let t = 0; t <= until; t += MIN) {
    // A second machine measuring at the same minute brings nothing new.
    const machine = machines.find(m => t % cadence(card, m, t) === 0 && awake(m, t) && delivered(card, t));
    if (!machine) continue;
    let next = t + MIN;
    while (next % cadence(card, machine, next)) next += MIN;
    found.push({t, next: next - t});
  }
  return found;
}

/**
 * The catalogue test reads where weekly windows lead on one hub at one start, the minute of
 * the hour kept. Here every card with such codes goes through the hub's own forecasts on
 * a store of its own, measured and read as the catalogue test does (at the same points,
 * so the forecasts' memory is the same), at three other starts: a code that holds only by
 * the hour of the day the test happened to start on, or by its cards' hour of forecasts, fails here.
 */
test("where the catalogue's weekly windows lead holds at other hours of the day, whatever the hour of the forecasts", {timeout: 240_000}, () => {
  const set = SETS.find(s => s.id === 'all')!;
  const scene = SCENES.find(s => s.id === set.scene)!;
  const read = points(set);
  const foreseen = cards(set).flatMap(card => {
    const checks = card.expect.filter(check => 'forecast' in check && card.windows.some(w => w(0).id === check.forecast && w(0).kind === 'weekly') && CODES.some(code => code in check));
    return checks.length ? [{card, checks: checks.map(check => ({check, span: spanOf(card, check)}))}] : [];
  });
  assert.ok(foreseen.length >= 10, 'the catalogue claims where many weekly windows lead');

  const wrong: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-demo-starts-'));
  try {
    for (const {at: start, shift} of STARTS) {
      for (const {card, checks} of foreseen) {
        const until = Math.max(...checks.map(({span}) => span.to));
        const store = new Store(path.join(dir, `${start}-${card.id}.sqlite`), start - 60 * DAY);
        const forecasts = new Forecasts(store, {shift});
        const machine = machineInfo(machineOf(set, card.machines[0]));
        const batch = (t: number, next: number) =>
          parseBatch({version: 1, agent: 'quotum-demo/1', machine, sentAt: new Date(start + t).toISOString(), snapshots: [snapshot(card, start, t, next)], failures: []}).snapshots[0];
        const first = batch(0, MIN);
        const source = store.source(card.provider, subscriptionKey(first, 'demo'), start - 60 * DAY);
        const measured = times(set, card, until);
        let i = 0;
        store.db.exec('BEGIN');
        for (const at of read.filter(at => at <= until)) {
          for (; i < measured.length && measured[i].t <= at; i++) store.record(source, toMeasurement(batch(measured[i].t, measured[i].next)));
          const now = start + at;
          const {value} = forecasts.of(source, now);
          forecasts.save();
          const state = store.state(source);
          const context = {windows: state.windows as Win[], freeResets: state.resets?.available ?? 0, announced: announcedOf(resetsOf(scene, start, now), card.provider, state.successAt)};
          for (const {check, span} of checks) {
            if (at !== span.from && at !== span.to && at !== (span.from + span.to) / 2) continue;
            const id = (check as {forecast: string}).forecast;
            const live = state.windows.find(w => w.id === id) as Win;
            const codes: Record<string, unknown> = forecastCodes(live, state.successAt, now, (value[id] ?? null) as SeriesForecast | null, context);
            const claimed = Object.entries(check).filter(([key]) => CODES.includes(key));
            const seen = Object.fromEntries(claimed.map(([key]) => [key, codes[key]]));
            if (JSON.stringify(seen) !== JSON.stringify(Object.fromEntries(claimed))) {
              wrong.push(`${card.id} ${id} from ${new Date(start).toISOString()} + ${at / MIN}m: claims ${JSON.stringify(Object.fromEntries(claimed))}, shows ${JSON.stringify(seen)}`);
            }
          }
        }
        store.db.exec('COMMIT');
        store.close();
      }
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
  assert.deepEqual(wrong, []);
});
