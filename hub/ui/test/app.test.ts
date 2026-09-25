import {test} from 'node:test';
import assert from 'node:assert/strict';
import {asksToTakeOver, failedTitle, intervalChoices, onboardingText, settingsSections, takeOverText, takeOverTitle, type AgentState} from '../lib/app';

test('a provider is measured every 1 to 60 minutes; a value set by hand in the file is kept among them', () => {
  assert.deepEqual(intervalChoices(120), [1, 2, 5, 10, 15, 30, 60]);
  assert.deepEqual(intervalChoices(180), [1, 2, 3, 5, 10, 15, 30, 60]);
  assert.deepEqual(intervalChoices(7200), [1, 2, 5, 10, 15, 30, 60, 120]);
});

test('the question about taking over names who measures, where it delivers and what becomes of it', () => {
  // A `quotum` that makes way wrote run.info: it names its hub, or says it has none.
  assert.deepEqual(takeOverText({pid: 42, hub: 'https://q.example', yields: true}), {who: 'takeover.holderPid', hub: 'takeover.hubKnown', after: 'takeover.yields'});
  assert.deepEqual(takeOverText({pid: 42, yields: true}), {who: 'takeover.holderPid', hub: null, after: 'takeover.yields'});
  // An older one: its hub is known only from the settings, and it may have been given another.
  assert.deepEqual(takeOverText({pid: 42, hub: 'https://q.example', yields: false}), {who: 'takeover.holderPid', hub: 'takeover.hubMaybe', after: 'takeover.stops'});
  assert.deepEqual(takeOverText({yields: false}), {who: 'takeover.holder', hub: 'takeover.hubUnknown', after: 'takeover.stops'});
});

test('the question stays while quotum holds the machine, and says so when taking over failed', () => {
  const held: AgentState = {state: 'held', holder: {yields: true}};
  assert.ok(asksToTakeOver(held));
  assert.equal(takeOverTitle(held), 'takeover.title');
  assert.equal(takeOverTitle({...held, error: '`quotum` (pid 42) still measures this machine'}), 'takeover.failedTitle');
  for (const state of ['starting', 'taking_over', 'measuring', 'idle'] as const) assert.ok(!asksToTakeOver({state}), state);
  assert.ok(!asksToTakeOver(undefined), 'in a browser');
});

test('an empty board promises numbers only while the agent measures', () => {
  assert.equal(onboardingText(undefined), 'local.onboardingMeasuring', 'in a browser: the app measures');
  assert.equal(onboardingText({state: 'starting'}), 'local.onboardingMeasuring');
  assert.equal(onboardingText({state: 'measuring'}), 'local.onboardingMeasuring');
  assert.equal(onboardingText({state: 'idle'}), 'local.onboardingIdle');
  assert.equal(onboardingText({state: 'held', holder: {yields: false}}), 'local.onboardingWaiting');
  assert.equal(onboardingText({state: 'failed', cause: 'panic', error: 'x'}), 'local.onboardingWaiting');
});

test('the trouble of the agent is titled by its cause', () => {
  assert.deepEqual((['config', 'lock', 'panic'] as const).map(failedTitle), ['failed.config', 'failed.lock', 'failed.panic']);
});

test('the settings of the app are only in its window, an account only on a server', () => {
  assert.deepEqual(settingsSections(false, false), ['account', 'browser']);
  assert.deepEqual(settingsSections(false, true), ['account', 'browser'], 'a server shown in the app’s window stays a server');
  assert.deepEqual(settingsSections(true, true), ['measuring', 'app', 'browser']);
  assert.deepEqual(settingsSections(true, false), ['browser'], 'the app’s hub in a browser: nothing of the app');
});
