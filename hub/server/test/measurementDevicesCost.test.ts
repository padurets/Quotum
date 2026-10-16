import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deviceControl} from './fixtures/measurement-devices.js';

test('steady contacts on the fixed 100-device / 200-source fleet scale with their touched accounts',()=>{
  const cohorts=[1,10,100].map(contacts=>deviceControl(contacts,true));
  const one=cohorts[0];
  for(const sample of cohorts) {
    assert.equal(sample.reads,one.reads*sample.contacts);
    assert.equal(sample.rows,one.rows*sample.contacts);
    assert.equal(sample.writes,one.writes*sample.contacts);
    assert.equal(sample.sourceTouches,2*sample.contacts);
    assert.equal(sample.userTouches,0,'steady contacts never cause a whole-user projection');
    const relevant=sample.plans!.filter(plan=>/\b(devices|sources|device_measurement_policies|source_measurement_preferences)\b/.test(plan.sql));
    assert.ok(relevant.length);
    for(const plan of relevant)assert.ok(plan.details.every(detail=>!/SCAN (devices|sources|device_measurement_policies|source_measurement_preferences)\b/.test(detail)),JSON.stringify(plan));
  }
});
