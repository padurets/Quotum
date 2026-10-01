import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../../server/config.js';
import {KEPT_MS} from '../../ui/lib/periods.js';

test('the page steps back no further than the hub keeps history', () => {
  assert.equal(KEPT_MS, config.retention.sampleDays * 86_400_000);
});
