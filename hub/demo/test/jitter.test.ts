import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Forecasts} from '../../server/forecasts.js';
import type {Win} from '../../server/domain/quota.js';
import {Store} from '../../server/store/store.js';
import {outlook, outlookText} from '../../ui/lib/forecast.js';
import type {SeriesForecast} from '../../ui/lib/types.js';
import {DAY, HOUR, MIN, SECOND, WEEK} from '../model.js';

/** A week that begins on a whole hour, and again every week. */
const T0 = Date.UTC(2026, 8, 7, 10);
/** Measured every two minutes from half a minute in; the first week only builds a history. */
const STEP = 2 * MIN;
const SCORED = {from: T0 + WEEK, to: T0 + 3 * WEEK};

/** What the cell shows: its words (with how soon it runs out, or what is left), its tone and its burst mark. */
function face(live: Win, measuredAt: number, now: number, ahead: SeriesForecast | null) {
  const context = {windows: [live], freeResets: 0, announced: null};
  const said = outlook(live, measuredAt, now, ahead, context);
  const {text, burst} = outlookText(said, live, ahead, context, null);
  return [text, said.tone, burst].join('|');
}

/**
 * How often a day the cell of a weekly window spent evenly at `rate` points an hour,
 * reported in whole percents, changes what it shows when the hub works its forecast out
 * again: its forecast is asked for after every measurement and when it said it may
 * change, and the cell is read every ten minutes, old and new forecast at the same moment.
 */
function changesADay(dir: string, rate: number): number {
  const store = new Store(path.join(dir, `${rate}.sqlite`), T0 - DAY);
  const source = store.source('codex', `jitter-${rate}`, T0 - DAY);
  const forecasts = new Forecasts(store);
  const windowAt = (t: number): Win => {
    const cycle = Math.floor((t - T0) / WEEK);
    const used = Math.floor(Math.min(100, (rate * (t - T0 - cycle * WEEK)) / HOUR));
    return {id: 'weekly', kind: 'weekly', label: null, used, remaining: 100 - used, resetAt: T0 + (cycle + 1) * WEEK, minutes: 7 * 24 * 60};
  };
  let changesAt: number | null = null;
  const ask = (now: number): SeriesForecast | null => {
    const {value, changesAt: next} = forecasts.of(source, now);
    forecasts.save();
    changesAt = next;
    return (value.weekly ?? null) as SeriesForecast | null;
  };

  let changes = 0;
  let current: SeriesForecast | null = null;
  let shown: SeriesForecast | null = null;
  let sample = T0 + 30 * SECOND;
  store.db.exec('BEGIN');
  for (let read = T0 + 10 * MIN; read < SCORED.to; read += 10 * MIN) {
    // Measurements and the moments the forecast said it may change, in their order, up to the read.
    while (Math.min(sample, changesAt ?? Infinity) <= read) {
      if (changesAt !== null && changesAt < sample) {
        current = ask(changesAt);
        continue;
      }
      store.record(source, {observedAt: sample, plan: 'plus', windows: [windowAt(sample)], staleAfterMs: STEP + STEP / 5 + MIN, resets: null});
      current = ask(sample + 3 * SECOND);
      sample += STEP;
    }
    current = ask(read);
    const live = store.state(source).windows[0];
    const measuredAt = store.state(source).successAt!;
    if (read >= SCORED.from && shown && current && shown !== current && shown.resetAt === current.resetAt && live.remaining > 0) {
      if (face(live, measuredAt, read, shown) !== face(live, measuredAt, read, current)) changes++;
    }
    shown = current;
  }
  store.db.exec('COMMIT');
  store.close();
  return changes / ((SCORED.to - SCORED.from) / DAY);
}

/**
 * At a steady pace near where the cell turns from "just enough" to "runs out", and from
 * "just enough" to what is left, whole percents make each forecast move a little; the
 * verdict's dead zones and bands keep the cell from following it every hour. Over two
 * weeks, at most once a day on average.
 */
test("a weekly window's cell changes at most once a day on average at a steady pace near its thresholds", {timeout: 240_000}, t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-jitter-'));
  try {
    for (const rate of [0.625, 0.45]) {
      const found = changesADay(dir, rate);
      t.diagnostic(`${rate} points an hour: ${found.toFixed(2)} changes a day`);
      assert.ok(found <= 1, `${rate} points an hour: ${found.toFixed(2)} changes a day`);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
