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
