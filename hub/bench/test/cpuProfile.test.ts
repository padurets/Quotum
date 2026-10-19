import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numericProfile, profileWindow} from '../cpuProfile.js';
import {safeEvidence} from '../evidence.js';

const frame = {functionName: 'private-canary', scriptId: 'private-canary', url: 'https://private-canary/assets/index-public.js', lineNumber: 12, columnNumber: 34};

const recorded = () => ({startTime: 1_000_000, endTime: 1_003_000, nodes: [{id: 1, children: [2], callFrame: {...frame, functionName: '(root)', url: ''}}, {id: 2, hitCount: 3, callFrame: frame}], samples: [2, 2, 2], timeDeltas: [1000, 1000, 1000]});

test('CPU evidence keeps sample positions and graph identity without private call-frame text', () => {
  const result = numericProfile(recorded());
  assert.equal(result.status, 'complete');
  assert.doesNotMatch(JSON.stringify(safeEvidence(result)), /private-canary|https:|functionName|url/);
  assert.ok('nodes' in result);
  assert.deepEqual(result.nodes.map(node => [node.id, node.line, node.column, node.sourceRole]), [[1, 12, 34, 0], [2, 12, 34, 1]]);
  assert.deepEqual(result.nodes[0].children, [2]);
  assert.deepEqual(result.samples, [2, 2, 2]); assert.deepEqual(result.timeDeltas, [1000, 1000, 1000]);
  assert.equal(result.nodes[0].scriptId, result.nodes[1].scriptId);
});

test('missing, malformed and dangling CPU samples cannot be complete evidence', () => {
  const values = [
    {...recorded(), timeDeltas: [1000]}, {...recorded(), samples: undefined},
    {...recorded(), samples: [999, 2, 2]}, {...recorded(), timeDeltas: [NaN, 1000, 1000]},
    {...recorded(), nodes: [recorded().nodes[0]]}, {...recorded(), nodes: [recorded().nodes[0], recorded().nodes[0]]},
    {...recorded(), startTime: NaN},
  ];
  for (const value of values) assert.equal(numericProfile(value).status, 'insufficient-evidence');
});

test('renderer script IDs remain distinct from local ordinals and invalid IDs stay unavailable', () => {
  for (const [scriptId, expected] of [['13', 13], ['9007199254740991', Number.MAX_SAFE_INTEGER], ['0', null], ['013', null], ['-1', null], ['1.5', null], ['9007199254740992', null], ['private-canary', null]] as const) {
    const value = recorded();
    value.nodes[0].callFrame.scriptId = '0';
    value.nodes[1].callFrame = {...frame, scriptId};
    const result = numericProfile(value);
    assert.equal(result.status, 'complete'); assert.ok('nodes' in result);
    assert.equal(result.nodes[1].scriptId, scriptId === '0' ? 1 : 2);
    assert.equal(result.nodes[1].rendererScriptId, expected);
    assert.equal(result.nodes[0].rendererScriptId, null);
    assert.doesNotMatch(JSON.stringify(safeEvidence(result)), /private-canary|https:/);
  }
});

test('signed V8 sample deltas keep their original order and positions', () => {
  // An actual CPU4 interval returned -2 us between adjacent sampled timestamps.
  const result = numericProfile({...recorded(), timeDeltas: [1000, -2, 1000]});
  assert.equal(result.status, 'complete'); assert.ok('timeDeltas' in result);
  assert.deepEqual(result.timeDeltas, [1000, -2, 1000]); assert.equal(result.reversedDeltas, 1);
  assert.deepEqual(result.samples, [2, 2, 2]);
});

test('a full CPU sample prefix is bounded and reports every omission', () => {
  const result = numericProfile({...recorded(), samples: Array(100_001).fill(2), timeDeltas: Array(100_002).fill(1000), nodes: [{...recorded().nodes[0], children: Array(100_003).fill(2)}, recorded().nodes[1]]});
  assert.equal(result.status, 'insufficient-evidence'); assert.ok('samples' in result);
  assert.equal(result.samples.length, 100_000); assert.equal(result.timeDeltas.length, 100_000);
  assert.equal(result.omittedSamples, 1); assert.equal(result.omittedDeltas, 2); assert.equal(result.omittedChildren, 3);
});

test('CPU sampling membership retains clock uncertainty and rejects contradictory calibrations', () => {
  const profile = numericProfile(recorded());
  const clocks = [{stage: 'start', before: 1000, page: 100, after: 1001, valid: true}, {stage: 'end', before: 1100, page: 200, after: 1101, valid: true}];
  const window = profileWindow(profile, clocks, 100, 102);
  assert.equal(window.status, 'observed'); assert.ok('certainSamples' in window);
  assert.equal(window.certainSamples, 2); assert.equal(window.possibleSamples, 3);
  assert.equal(window.certainFunctionSamples, 2); assert.equal(window.possibleFunctionSamples, 3);
  assert.equal(profileWindow(profile, [{...clocks[0]}, {...clocks[1], before: 1200, after: 1201}], 100, 102).status, 'insufficient-evidence');
  assert.equal(profileWindow(profile, [], 100, 102).status, 'insufficient-evidence');
});
