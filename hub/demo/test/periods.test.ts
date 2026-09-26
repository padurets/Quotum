import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../../server/config.js';
import {KEPT_MS, PERIODS} from '../../ui/lib/periods.js';

// Here rather than beside either: the hub's tests do not read the page, nor the page's the hub.
test('the page offers the periods the hub reads, as long as the hub takes them', () => {
  assert.deepEqual(
    PERIODS.map(period => [period.id, period.ms]),
    Object.entries(config.history.ranges),
  );
});

test('the page steps back no further than the hub keeps history', () => {
  assert.equal(KEPT_MS, config.retention.sampleDays * 86_400_000);
});
