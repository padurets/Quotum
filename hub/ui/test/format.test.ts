import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setLocale} from '../i18n';
import {stamp} from '../lib/format';

// Athens and Cairo are as far from UTC today (30 September 2026) and in winter, but their
// clocks change on other days, so a time in spring reads otherwise in each.
const spring = Date.UTC(2026, 3, 10, 21, 30);

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
