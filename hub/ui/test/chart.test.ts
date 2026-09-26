import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cellLabel, liftOf, slideOf} from '../components/Chart';
import {setLocale} from '../i18n';
import {preferring} from './browser';

test('a chart cell across midnight names both its days; one ending at midnight, its own', () => {
  // Local times, as the tooltip shows them; cells laid on UTC may cross midnight here. A zone
  // off UTC by hours and a quarter tells a local day from a UTC one, which UTC itself cannot.
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Kathmandu';
  try {
    const at = (hour: number) => new Date(2026, 8, 25, hour).getTime();
    const hours = (n: number) => n * 3_600_000;
    setLocale('en');
    preferring(['en-GB'], () => {
      assert.equal(cellLabel(at(20), hours(2)), '25 September 20:00–22:00');
      assert.equal(cellLabel(at(23), hours(2)), '25 September 23:00 – 26 September 01:00');
      assert.equal(cellLabel(at(22), hours(2)), '25 September 22:00–00:00', 'ending at midnight');
      assert.equal(cellLabel(at(23), 0), '25 September 23:00', 'a moment, not a cell');
    });
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('a step through time slides the chart in from the side it came from; the clock moving on or another period does not', () => {
  const hour = 3_600_000;
  const now = 1_800_000_000_000;
  const live = {from: now - 24 * hour, end: now};
  const back = {from: now - 36 * hour, end: now - 12 * hour, to: now - 12 * hour};
  assert.equal(slideOf(live, back, 1000), -500, 'back: half the width, the earlier half coming in from the left');
  assert.equal(slideOf({from: back.from, end: back.end}, {...live, to: now + 4 * hour}, 1000), (12 / 28) * 1000, 'forward to a period with its future');
  assert.equal(slideOf(live, {from: now - 24 * hour + 60_000, end: now + 60_000, to: now + 60_000}, 1000), 0, 'a live period a minute on');
  const hourLive = {from: now - hour, end: now + 5 * 60_000};
  assert.equal(slideOf(hourLive, {from: now - 1.5 * hour, end: now - 0.5 * hour, to: now - 0.5 * hour}, 1000), -500, 'an hour whose end was the hub’s clock, minutes ahead of the page');
  assert.equal(slideOf(live, {from: now - 7 * 24 * hour, end: now, to: now}, 1000), 0, 'another period');
});

test('a tooltip under a narrow chart rises as far as keeps it in the window, never under the bars, and the same once found again', () => {
  // Under the plot at 400, 350 tall, in a window 800 tall under bars ending at 60.
  assert.equal(liftOf(400, 350, 800, 60), 0, 'it fits');
  assert.equal(liftOf(500, 350, 800, 60), 58, 'its bottom kept 8 above the window’s');
  assert.equal(liftOf(300, 700, 800, 60), 208, 'taller: higher, still under the bars');
  assert.equal(liftOf(300, 800, 800, 60), 232, 'too tall to fit: no higher than 8 under the bars');
  // Read from the chart, not from where it was drawn: finding it again gives the same.
  assert.equal(liftOf(500, 350, 800, 60), liftOf(500, 350, 800, 60));
});
