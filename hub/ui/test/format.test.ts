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

test('a time is said in the time zone the system is in now, however long the page has been open', () => {
  const zone = process.env.TZ;
  const at = Date.UTC(2026, 8, 25, 20, 30);
  try {
    setLocale('en');
    process.env.TZ = 'America/New_York';
    assert.equal(stamp(at), '25 September 16:30');
    // Moved while the page was open: said anew in the zone it is in.
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(stamp(at), '26 September 05:30');
    // One as far from UTC in winter, but not in summer.
    process.env.TZ = 'Atlantic/Reykjavik';
    assert.equal(stamp(at), '25 September 20:30');
    process.env.TZ = 'Europe/London';
    assert.equal(stamp(at), '25 September 21:30');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
