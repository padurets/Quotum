import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setLocale} from '../i18n';
import {stamp} from '../lib/format';

test('timestamps use day, month and a 24-hour local clock, including midnight', () => {
  const date = new Date(2026, 8, 26, 0, 5).getTime();
  setLocale('en');
  assert.equal(stamp(date), '26 September 00:05');
  setLocale('ru');
  assert.equal(stamp(date), '26 сентября 00:05');
  setLocale('en');
});

test('a time is said in the time zone the system is in, named again a second later at the soonest', t => {
  const zone = process.env.TZ;
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 8, 30)});
  const at = Date.UTC(2026, 8, 25, 20, 30);
  const spring = Date.UTC(2026, 3, 10, 21, 30);
  const moveTo = (name: string) => {
    process.env.TZ = name;
    t.mock.timers.tick(1000);
  };
  try {
    setLocale('en');
    moveTo('America/New_York');
    assert.equal(stamp(at), '25 September 16:30');
    // Moved while the page was open: said anew in the zone it is in.
    moveTo('Asia/Tokyo');
    assert.equal(stamp(at), '26 September 05:30');
    // As far from UTC as the other in winter and in summer, its clocks changed on other days.
    moveTo('Europe/Athens');
    assert.equal(stamp(spring), '11 April 00:30');
    moveTo('Africa/Cairo');
    assert.equal(stamp(spring), '10 April 23:30');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
