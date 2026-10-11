import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {numericProfile, profileInterval, profilePanning, profileWindow} from '../cpuProfile.js';
import type {Cdp, Browser} from '../cdp.js';
import {safeEvidence} from '../evidence.js';

const frame = {functionName: 'private-canary', scriptId: 'private-canary', url: 'https://private-canary/assets/index-public.js', lineNumber: 12, columnNumber: 34};
const recorded = () => ({startTime: 1_000_000, endTime: 1_003_000, nodes: [{id: 1, children: [2], callFrame: {...frame, functionName: '(root)', url: ''}}, {id: 2, hitCount: 3, callFrame: frame}], samples: [2, 2, 2], timeDeltas: [1000, 1000, 1000]});
function fixture() {
  const sent: {method: string; params: object}[] = [], files = new Map<string, unknown>();
  let stamp = 10_000, closed = 0;
  const cdp = {on: () => {}, off: () => {}, at: () => {},
    send: async (method: string, params: object) => {sent.push({method, params}); return method === 'Profiler.stop' ? {profile: recorded()} : method === 'Performance.getMetrics' ? {metrics: [{name: 'Timestamp', value: stamp++ / 1000}]} : {};},
    evaluate: async () => stamp - 5000,
  } as unknown as Cdp;
  const browser: Browser = {owned: true, endpoint: 'fixture', close: async () => {closed++;}};
  return {cdp, browser, sent, files, get closed() {return closed;}, evidence: {save: (name: string, value: unknown) => files.set(name, value), saveTrace: (name: string, value: unknown) => files.set(name, value)}};
}

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

test('CPU source binding follows each original family after the profiler is disabled', async () => {
  const f = fixture(), listeners = new Map<string, Set<(value: unknown) => void>>();
  const emit = (name: string, value: unknown) => {for (const listener of listeners.get(name) ?? []) listener(value);};
  f.cdp.on = ((name: string, listener: (value: unknown) => void) => {let set = listeners.get(name); if (!set) listeners.set(name, set = new Set()); set.add(listener);}) as Cdp['on'];
  f.cdp.off = ((name: string, listener: (value: unknown) => void) => {const set = listeners.get(name); set?.delete(listener); if (!set?.size) listeners.delete(name);}) as Cdp['off'];
  const body = '/* private-canary */ globalThis.control=1;', hash = createHash('sha256').update(body).digest('hex');
  const url = 'http://private-canary.invalid/assets/index-control.js', send = f.cdp.send.bind(f.cdp);
  f.cdp.send = (async (name: string, params: object, signal?: AbortSignal) => {
    const value = await send(name, params, signal);
    if (name === 'Network.getResponseBody') return {body, base64Encoded: false};
    if (name === 'Debugger.enable') emit('Debugger.scriptParsed', {url, hash, scriptId: '13'});
    return value;
  }) as Cdp['send'];
  await profilePanning(f.cdp, f.browser, f.evidence, async cdp => {
    for (const family of [1, 2, 3]) {
      emit('Network.responseReceived', {type: 'Script', requestId: 'private-canary', response: {url}});
      for (let period = 0; period < 2; period++) {
        await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
        await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', deltaX: 12});
        await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
        assert.equal(f.sent.filter(v => v.method === 'Debugger.enable').length, family - 1);
      }
      await cdp.evaluate(`document.getElementById('quotum-pan-layout')?.remove()`);
      const methods = f.sent.map(v => v.method);
      assert.ok(methods.lastIndexOf('Debugger.enable') > methods.lastIndexOf('Profiler.disable'));
      const binding = f.files.get(`cpu-source-family-${family}`) as {status: string; intervals: number[]; owners: unknown[]; debuggerDisabled: boolean};
      assert.equal(binding.status, 'complete'); assert.equal(binding.debuggerDisabled, true);
      assert.deepEqual(binding.intervals, [family * 2 - 1, family * 2]);
      assert.deepEqual(binding.owners, [{scriptId: 13, parsedHash: hash, receivedAssetHashMatches: true}]);
      assert.doesNotMatch(JSON.stringify(safeEvidence(binding)), /private-canary|requestId|url/);
    }
    return {reports: [], problems: []};
  }, {status: 'available', name: 'index-control.js', bytes: Buffer.byteLength(body), sha256: hash});
  assert.equal(listeners.size, 0);
  assert.equal(f.sent.filter(v => v.method === 'Profiler.stop').length, 6);
  assert.deepEqual(f.sent.filter(v => v.method === 'Input.dispatchMouseEvent').map(v => v.params), Array(6).fill({type: 'mouseWheel', deltaX: 12}));
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

test('an original CPU interval records both clock brackets and stops before returning', async () => {
  const f = fixture();
  assert.equal(await profileInterval(f.cdp, f.browser, async () => 17, f.evidence), 17);
  assert.deepEqual(f.sent.map(value => value.method), ['Profiler.enable', 'Profiler.setSamplingInterval', 'Performance.getMetrics', 'Performance.getMetrics', 'Profiler.start', 'Performance.getMetrics', 'Performance.getMetrics', 'Profiler.stop', 'Profiler.disable']);
  assert.deepEqual(f.sent[1].params, {interval: 1000});
  const result = f.files.get('profile') as {status: string; clocks: {before: number; page: number; after: number}[]; cleanup: string};
  assert.equal(result.status, 'complete'); assert.equal(result.cleanup, 'complete'); assert.equal(result.clocks.length, 2);
  assert.deepEqual(result.clocks.map(clock => [clock.before, clock.page, clock.after]), [[10_000, 5001, 10_001], [10_002, 5003, 10_003]]);
  assert.equal(f.closed, 0);
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

test('an attached browser receives no profiler command', async () => {
  const f = fixture();
  await assert.rejects(profileInterval(f.cdp, {...f.browser, owned: false}, async () => 17, f.evidence), /owned synthetic/);
  assert.equal(f.sent.length, 0); assert.equal(f.files.size, 0);
});

for (const failed of [false, true]) test(`lost CPU stop closes only the owned browser and preserves ${failed ? 'the scenario error' : 'the cleanup error'}`, async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), send = f.cdp.send.bind(f.cdp), error = new Error('original scenario failure');
  let reached = () => {};
  const stopping = new Promise<void>(resolve => {reached = resolve;});
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    if (method !== 'Profiler.stop') return send(method, params, signal);
    reached(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
  }) as Cdp['send'];
  const outcome = assert.rejects(profileInterval(f.cdp, f.browser, async () => {if (failed) throw error; return 17;}, f.evidence), value => failed ? value === error : value instanceof Error && value.message === 'CPU profile cleanup failed at stop-command');
  await stopping; t.mock.timers.tick(5000); await outcome;
  assert.equal(f.closed, 1);
  const report = f.files.get('profile') as {status: string; cleanup: string};
  assert.equal(report.status, 'insufficient-evidence'); assert.equal(report.cleanup, 'incomplete');
});

test('a lost profiler start is still stopped without running the scenario', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  let reached = () => {};
  const starting = new Promise<void>(resolve => {reached = resolve;});
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    if (method !== 'Profiler.start') return send(method, params, signal);
    reached(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
  }) as Cdp['send'];
  const outcome = assert.rejects(profileInterval(f.cdp, f.browser, async () => {assert.fail('a lost start cannot run the scenario');}, f.evidence), /deadline/);
  await starting; t.mock.timers.tick(5000); await outcome;
  assert.equal(f.sent.at(-2)?.method, 'Profiler.stop'); assert.equal(f.sent.at(-1)?.method, 'Profiler.disable');
});

test('every original panning scenario owns a distinct CPU profile and passes its input unchanged', async () => {
  const f = fixture();
  const result = await profilePanning(f.cdp, f.browser, f.evidence, async cdp => {
    for (let i = 0; i < 6; i++) {
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', deltaX: 12});
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    }
    return {reports: [], problems: []};
  });
  assert.equal(result.problems.length, 0); assert.equal(f.sent.filter(value => value.method === 'Profiler.start').length, 6);
  assert.equal(f.sent.filter(value => value.method === 'Profiler.stop').length, 6);
  assert.deepEqual(f.sent.filter(value => value.method === 'Input.dispatchMouseEvent').map(value => value.params), Array(6).fill({type: 'mouseWheel', deltaX: 12}));
  for (let i = 1; i <= 6; i++) assert.equal((f.files.get(`cpu-${i}-profile`) as {status: string}).status, 'complete');
});

test('cleanup of a later failing native scenario cannot overwrite its original error', async () => {
  const f = fixture(), send = f.cdp.send.bind(f.cdp), error = new Error('original input failure');
  let stopped = 0;
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    if (method === 'Profiler.stop' && ++stopped === 2) throw new Error('profile stop failed');
    return send(method, params, signal);
  }) as Cdp['send'];
  await assert.rejects(profilePanning(f.cdp, f.browser, f.evidence, async cdp => {
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    throw error;
  }), value => value === error);
  assert.equal(stopped, 2); assert.equal(f.closed, 1);
  assert.equal((f.files.get('cpu-2-profile') as {status: string}).status, 'insufficient-evidence');
});
