import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../../server/config.js';
import {PERIODS} from '../../ui/lib/periods.js';

// Here rather than beside either: the hub's tests do not read the page, nor the page's the hub.
test('the page offers the periods the hub reads, as long as the hub takes them', () => {
  assert.deepEqual(
    PERIODS.map(period => [period.id, period.ms]),
    Object.entries(config.history.ranges),
  );
});
