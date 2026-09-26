import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cellLabel} from '../components/Chart';
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
