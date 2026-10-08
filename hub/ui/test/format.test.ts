import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setLocale} from '../i18n';
import {recentActivity, recentActivityChangesAt, stamp} from '../lib/format';
import {PageClock} from '../lib/clock';

// Athens and Cairo are as far from UTC today (30 September 2026) and in winter, but their
// clocks change on other days, so a time in spring reads otherwise in each.
const spring = Date.UTC(2026, 3, 10, 21, 30);

test('last activity uses relative minutes and hours, calendar yesterday, then its exact date in both languages', t => {
  travelling(t, moveTo => {
    moveTo('UTC');
    const now = new Date(2026, 9, 8, 12).getTime();
    for (const [locale, expected] of [
      ['en', ['now', '5m ago', '2h ago', 'yesterday', '6 October 23:00']],
      ['ru', ['сейчас', '5 мин назад', '2 ч назад', 'вчера', '6 октября 23:00']],
    ] as const) {
      setLocale(locale);
      const times = [now - 59_999, now - 5 * 60_000, now - 2 * 3_600_000, new Date(2026, 9, 7, 23).getTime(), new Date(2026, 9, 6, 23).getTime()];
      assert.deepEqual(times.map(time => recentActivity(time, now)), expected);
      assert.equal(recentActivityChangesAt(times[4], now), null);
    }
  });
});

test('last activity crosses local midnight and both clock changes without assuming a 24-hour day', t => {
  travelling(t, moveTo => {
    moveTo('Europe/Berlin');
    for (const [month, date, hours] of [[2, 29, 23], [9, 25, 25]]) {
      const at = new Date(2026, month, date - 1, 23, 55).getTime();
      const midnight = new Date(2026, month, date).getTime();
      const next = new Date(2026, month, date + 1).getTime();
      assert.equal((next - midnight) / 3_600_000, hours);
      assert.equal(recentActivity(at, midnight - 1), '4m ago');
      assert.equal(recentActivityChangesAt(at, midnight - 1), midnight);
      assert.equal(recentActivity(at, midnight), 'yesterday');
      assert.equal(recentActivityChangesAt(at, midnight), next);
      assert.equal(recentActivity(at, next - 1), 'yesterday');
      assert.equal(recentActivity(at, next), stamp(at));
      assert.equal(recentActivityChangesAt(at, next), null);
    }
    const at = Date.UTC(2026, 9, 7, 23, 55), now = Date.UTC(2026, 9, 8, 0, 5);
    moveTo('UTC');assert.equal(recentActivity(at, now), 'yesterday');
    moveTo('America/New_York');assert.equal(recentActivity(at, now), '10m ago');
  });
});

test('a skipped midnight does not shift yesterday or the next clock wake into another hour', t => {
  travelling(t, moveTo => {
    for (const [zone, month, date] of [['America/Santiago', 8, 6], ['America/Havana', 2, 8], ['Africa/Cairo', 3, 24]] as const) {
      moveTo(zone);
      const morning = new Date(2026, month, date - 1, 0, 30).getTime();
      const at = new Date(2026, month, date - 1, 12).getTime();
      const next = new Date(2026, month, date + 1).getTime();
      let now = new Date(2026, month, date, 23, 59).getTime(), wakes = 0;
      assert.equal(new Date(2026, month, date).getHours(), 1, zone);
      assert.equal(recentActivity(morning, now), 'yesterday', zone);
      const clock = new PageClock({now: () => now, setTimeout: () => 0, clearTimeout: () => {}, visible: () => true});
      const watch = clock.watch();
      let label = recentActivity(at, now);
      const stop = clock.subscribe(watch, () => {wakes++; label = recentActivity(at, clock.hubNow());});
      clock.due(watch, recentActivityChangesAt(at, now), now);
      assert.equal(watch.due, next, zone);
      now = next - 1; clock.wakeDue(); assert.equal(wakes, 0);
      now = next; clock.wakeDue(); assert.equal(wakes, 1, zone);
      assert.equal(label, stamp(at)); assert.equal(recentActivityChangesAt(at, now), null);
      stop();
    }
  });
});

/** Every test here says times in the zones it moves to, whichever the machine is in. */
function travelling(t: TestContext, check: (moveTo: (zone: string) => void) => void) {
  const zone = process.env.TZ;
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 8, 30)});
  try {
    setLocale('en');
    check(name => (process.env.TZ = name));
  } finally {
    setLocale('en');
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
}

test('timestamps use day, month and a 24-hour local clock, including midnight', t => {
  travelling(t, moveTo => {
    moveTo('UTC');
    const date = new Date(2026, 8, 26, 0, 5).getTime();
    assert.equal(stamp(date), '26 September 00:05');
    setLocale('ru');
    assert.equal(stamp(date), '26 сентября 00:05');
  });
});

test('a time is said in the time zone the system is in: at once where the clocks read otherwise, a second later at the soonest where they read the same', t => {
  const at = Date.UTC(2026, 8, 25, 20, 30);
  travelling(t, moveTo => {
    moveTo('America/New_York');
    assert.equal(stamp(at), '25 September 16:30');
    // Moved while the page was open: said anew in the zone it is in.
    moveTo('Asia/Tokyo');
    assert.equal(stamp(at), '26 September 05:30');
    moveTo('Europe/Athens');
    assert.equal(stamp(spring), '11 April 00:30');
    moveTo('Africa/Cairo');
    assert.equal(stamp(spring), '11 April 00:30', 'the clocks read the same now: the zone is not named again yet');
    t.mock.timers.tick(999);
    assert.equal(stamp(spring), '11 April 00:30', 'nor within the second');
    t.mock.timers.tick(1);
    assert.equal(stamp(spring), '10 April 23:30');
    moveTo('Europe/Athens');
    t.mock.timers.setTime(Date.UTC(2026, 8, 29, 23));
    assert.equal(stamp(spring), '11 April 00:30', 'the clock set back: named again at once');
  });
});

test('a time said in another language in a zone not named yet is said there, and kept apart from the zone before', t => {
  // Other tests of the process say times in the machine's zone, in either language, and the
  // formatters they make are kept: this starts in one they say none in, Athens or Helsinki,
  // whose clocks read the same on both days.
  const home = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const from = home === 'Europe/Athens' ? 'Europe/Helsinki' : 'Europe/Athens';
  travelling(t, moveTo => {
    moveTo(from);
    assert.equal(stamp(spring), '11 April 00:30');
    moveTo('Africa/Cairo');
    setLocale('ru');
    assert.equal(stamp(spring), '10 апреля 23:30', 'made in Cairo');
    setLocale('en');
    assert.equal(stamp(spring), '10 April 23:30', 'the zone it was made in named anew');
    moveTo(from);
    t.mock.timers.tick(1000);
    setLocale('ru');
    assert.equal(stamp(spring), '11 апреля 00:30', 'back: not the one made in Cairo');
  });
});
