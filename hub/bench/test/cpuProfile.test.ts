import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {numericAllocations, numericProfile, profileInterval, profilePanning, profileWindow} from '../cpuProfile.js';
import type {Cdp, Browser} from '../cdp.js';
import {safeEvidence} from '../evidence.js';

const frame = {functionName: 'private-canary', scriptId: 'private-canary', url: 'https://private-canary/assets/index-public.js', lineNumber: 12, columnNumber: 34};
const recorded = () => ({startTime: 1_000_000, endTime: 1_003_000, nodes: [{id: 1, children: [2], callFrame: {...frame, functionName: '(root)', url: ''}}, {id: 2, hitCount: 3, callFrame: frame}], samples: [2, 2, 2], timeDeltas: [1000, 1000, 1000]});
const allocation = (id: number, selfSize = 0, children: unknown[] = []): unknown => ({id, selfSize, children, callFrame: {...frame, scriptId: id === 1 ? '0' : '13'}});

test('allocation evidence preserves unknown ancestry and self sizes without private text or sample times', () => {
  const value = numericAllocations({head: allocation(1, 0, [allocation(7, 32768, [allocation(99, 65536)])]), samples: [{nodeId: 99, ordinal: 3, private: 'private-canary'}]});
  assert.equal(value.status, 'complete'); assert.ok(Array.isArray(value.nodes));
  assert.deepEqual(value.nodes.map(node => [node.id, node.parent, node.rendererScriptId, node.selfSize]), [[1, null, null, 0], [2, 1, 13, 32768], [3, 2, 13, 65536]]);
  assert.equal(value.selfSizeLowerBound, 98304); assert.equal(value.totalKnown, true);
  assert.doesNotMatch(JSON.stringify(safeEvidence(value)), /private-canary|https:|functionName|url|ordinal|nodeId/);
});

test('malformed, conflicting and over-limit allocation trees cannot be complete evidence', () => {
  for (const head of [null, allocation(1, -1), allocation(1, 0, [allocation(1)]), {...allocation(1) as object, children: 'private-canary'}]) {
    assert.equal(numericAllocations({head}).status, 'insufficient-evidence');
  }
  const malformed = numericAllocations({head: allocation(1, 0, Array(10_001).fill(null))});
  assert.equal(malformed.status, 'insufficient-evidence'); assert.ok('omittedAtLeast' in malformed);
  assert.equal(malformed.omittedAtLeast, 2); assert.equal(malformed.totalKnown, false);
  const overflow = numericAllocations({head: allocation(1, 0, Array.from({length: 10_001}, (_, i) => allocation(i + 2, 32768)))});
  assert.equal(overflow.status, 'insufficient-evidence');
  assert.ok(typeof overflow.nodes === 'number' || overflow.nodes.length <= 10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(safeEvidence(overflow))) <= 1024 * 1024);
});
function fixture() {
  const sent: {method: string; params: object}[] = [], files = new Map<string, unknown>();
  let stamp = 10_000, closed = 0;
  const cdp = {on: () => {}, off: () => {}, at: () => {},
    send: async (method: string, params: object) => {sent.push({method, params}); return method === 'Profiler.stop' ? {profile: recorded()} : method === 'HeapProfiler.stopSampling' ? {profile: {head: allocation(1, 0, [allocation(2, 32768)])}} : method === 'Performance.getMetrics' ? {metrics: [{name: 'Timestamp', value: stamp++ / 1000}]} : {};},
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

test('allocation sampling drains after the original CPU profile within its existing interval', async () => {
  const f = fixture();
  assert.equal(await profileInterval(f.cdp, f.browser, async () => {
    await f.cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', deltaX: 12}); return 17;
  }, f.evidence, 1000, true), 17);
  const methods = f.sent.map(row => row.method);
  assert.ok(methods.indexOf('HeapProfiler.enable') > methods.indexOf('Profiler.start'));
  assert.ok(methods.indexOf('Input.dispatchMouseEvent') > methods.indexOf('HeapProfiler.startSampling'));
  assert.ok(methods.indexOf('HeapProfiler.stopSampling') > methods.indexOf('Profiler.disable'));
  assert.ok(methods.indexOf('HeapProfiler.disable') > methods.indexOf('HeapProfiler.stopSampling'));
  assert.deepEqual(f.sent.find(row => row.method === 'HeapProfiler.startSampling')?.params, {samplingInterval: 32768, stackDepth: 128, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true});
  const value = f.files.get('allocations') as {status: string; collection: string; profile: {status: string}};
  assert.equal(value.status, 'complete'); assert.equal(value.profile.status, 'complete');
  assert.match(value.collection, /unqualified/);
  assert.equal((f.files.get('profile') as {status: string}).status, 'complete');
  assert.equal(f.closed, 0);
});

test('the final allocation receipt cannot turn a near-limit profile into a truncated positive', async () => {
  const children = Array.from({length: 9999}, (_, i) => ({id: i + 2, selfSize: 32768, children: [],
    callFrame: {...frame, scriptId: '9007199254740991', lineNumber: Number.MAX_SAFE_INTEGER, columnNumber: Number.MAX_SAFE_INTEGER}}));
  let low = 0, high = children.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2), value = numericAllocations({head: allocation(1, 0, children.slice(0, middle))});
    if (Array.isArray(value.nodes)) low = middle; else high = middle - 1;
  }
  const profile = {head: allocation(1, 0, children.slice(0, low))};
  assert.equal(numericAllocations(profile).status, 'complete');
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => method === 'HeapProfiler.stopSampling' ? {profile} : send(method, params, signal)) as Cdp['send'];
  await profileInterval(f.cdp, f.browser, async () => 17, f.evidence, 1000, true);
  const receipt = f.files.get('allocations') as {status: string; profile: {reason: string}};
  assert.equal(receipt.status, 'insufficient-evidence'); assert.equal(receipt.profile.reason, 'allocation receipt byte limit');
  assert.ok(Buffer.byteLength(JSON.stringify(safeEvidence(receipt))) < 1024 * 1024);
});

test('an unsupported allocation sampler continues only after confirmed disable', async () => {
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    if (method === 'HeapProfiler.startSampling') throw Error('private-canary');
    return send(method, params, signal);
  }) as Cdp['send'];
  assert.equal(await profileInterval(f.cdp, f.browser, async () => 17, f.evidence, 1000, true), 17);
  const value = f.files.get('allocations') as {status: string; active: boolean; disabled: boolean};
  assert.equal(value.status, 'unavailable'); assert.equal(value.active, false); assert.equal(value.disabled, true);
  assert.equal(f.sent.filter(row => row.method === 'HeapProfiler.disable').length, 1);
  assert.equal(f.closed, 0); assert.doesNotMatch(JSON.stringify(safeEvidence(value)), /private-canary/);
});

for (const direct of [false, true]) test(`a lost runtime attestation with ${direct ? 'direct' : 'adopted'} command promises cannot abort original scenarios after both profilers stop`, async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  let reached = () => {};
  const attesting = new Promise<void>(resolve => {reached = resolve;});
  const command = (method: string, params: object, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (method !== 'Browser.getVersion') return send(method, params, signal);
    reached(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
  };
  f.cdp.send = (direct ? command : async (method: string, params: object, signal?: AbortSignal) => command(method, params, signal)) as Cdp['send'];
  const outcome = profileInterval(f.cdp, f.browser, async () => 17, f.evidence, 1000, true);
  const checked = assert.doesNotReject(outcome);
  await attesting; t.mock.timers.tick(5000); await checked;
  assert.equal(await outcome, 17); assert.equal(f.closed, 0);
  assert.equal((f.files.get('profile') as {status: string}).status, 'complete');
  assert.equal((f.files.get('allocations') as {status: string}).status, 'complete');
});

test('a wholly unavailable heap domain cannot claim disable or send a sampling start', async () => {
  const f = fixture(), send = f.cdp.send.bind(f.cdp), methods: string[] = [];
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    methods.push(method);
    if (method.startsWith('HeapProfiler.')) throw Error('private-canary');
    return send(method, params, signal);
  }) as Cdp['send'];
  assert.equal(await profileInterval(f.cdp, f.browser, async () => 17, f.evidence, 1000, true), 17);
  const value = f.files.get('allocations') as {status: string; active: boolean; disabled: boolean};
  assert.equal(value.status, 'unavailable'); assert.equal(value.active, false); assert.equal(value.disabled, false);
  assert.equal(methods.filter(method => method === 'HeapProfiler.startSampling').length, 0);
  assert.equal(methods.filter(method => method === 'HeapProfiler.stopSampling').length, 0);
  assert.equal(f.closed, 0);
});

for (const failed of [false, true]) test(`lost allocation stop retains the original CPU profile and ${failed ? 'scenario error' : 'cleanup failure'}`, async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), send = f.cdp.send.bind(f.cdp), error = new Error('original scenario failure');
  let reached = () => {};
  const stopping = new Promise<void>(resolve => {reached = resolve;});
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (method !== 'HeapProfiler.stopSampling') return send(method, params, signal);
    reached(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
  }) as Cdp['send'];
  const outcome = assert.rejects(profileInterval(f.cdp, f.browser, async () => {if (failed) throw error; return 17;}, f.evidence, 1000, true), value => failed ? value === error : value instanceof Error && /allocation-stop/.test(value.message));
  await stopping; t.mock.timers.tick(5000); await outcome;
  assert.equal(f.closed, 1);
  const cpu = f.files.get('profile') as {status: string; profile: {status: string}};
  assert.equal(cpu.status, 'insufficient-evidence'); assert.equal(cpu.profile.status, 'complete');
  assert.equal((f.files.get('allocations') as {status: string}).status, 'insufficient-evidence');
});

test('a lost allocation start never runs the scenario and drains the possibly active sampler', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  let reached = () => {};
  const starting = new Promise<void>(resolve => {reached = resolve;});
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (method !== 'HeapProfiler.startSampling') return send(method, params, signal);
    reached(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
  }) as Cdp['send'];
  const outcome = assert.rejects(profileInterval(f.cdp, f.browser, async () => {assert.fail('an unconfirmed sampler cannot run input');}, f.evidence, 1000, true), /deadline/);
  await starting; t.mock.timers.tick(5000); await outcome;
  assert.equal(f.sent.filter(row => row.method === 'HeapProfiler.stopSampling').length, 1);
  assert.equal(f.sent.filter(row => row.method === 'HeapProfiler.disable').length, 1);
  assert.equal(f.closed, 0);
});

test('a lost allocation disable closes only the owned browser and retains the captured profiles', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  let reached = () => {};
  const disabling = new Promise<void>(resolve => {reached = resolve;});
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (method !== 'HeapProfiler.disable') return send(method, params, signal);
    reached(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
  }) as Cdp['send'];
  const outcome = assert.rejects(profileInterval(f.cdp, f.browser, async () => 17, f.evidence, 1000, true), /allocation-stop/);
  await disabling; t.mock.timers.tick(5000); await outcome;
  assert.equal(f.closed, 1);
  const value = f.files.get('allocations') as {status: string; disabled: boolean; stopped: boolean; profile: {status: string}};
  assert.equal(value.status, 'insufficient-evidence'); assert.equal(value.disabled, false); assert.equal(value.stopped, true); assert.equal(value.profile.status, 'complete');
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
  assert.equal(f.sent.filter(value => value.method.startsWith('HeapProfiler.')).length, 0);
  assert.equal(f.sent.filter(value => value.method === 'Profiler.stop').length, 6);
  assert.deepEqual(f.sent.filter(value => value.method === 'Input.dispatchMouseEvent').map(value => value.params), Array(6).fill({type: 'mouseWheel', deltaX: 12}));
  for (let i = 1; i <= 6; i++) assert.equal((f.files.get(`cpu-${i}-profile`) as {status: string}).status, 'complete');
});

test('only the successfully installed original budget/24h sampler selects allocations and freezes its failure before drain', async () => {
  const f = fixture(), evaluate = f.cdp.evaluate.bind(f.cdp), send = f.cdp.send.bind(f.cdp);
  const report = {initiator: 'budget' as const, period: '24h', series: 12, budgetSeries: 12, fundsSeries: 12, charts: 4, rate: 4,
    frames: Array(10_000).fill(51), latency: Array(10_000).fill(20), inputs: 10_000, updated: 10_000, chartUpdates: [40, 40, 40, 40], synchronized: true,
    peakFlights: 1, maxTiles: 8, duplicateReads: 0, pushesDuring: 0, pushesAfter: 3, expectedPushes: 3, forbiddenMutations: 0, coldReads: 1, undimmed: true, sizeStable: true,
    timeline: {status: 'complete', count: 100_000, omitted: 0, entries: Array(100_000).fill({private: 'private-canary'})}};
  f.cdp.evaluate = (async (expression: string, signal?: AbortSignal) => expression.startsWith('(() => {\n        const p=window.__quotumPan;p.cleanup();') ? report : evaluate(expression, signal)) as Cdp['evaluate'];
  f.cdp.send = (async (method: string, params: object, signal?: AbortSignal) => {
    if (method === 'HeapProfiler.stopSampling') assert.match(JSON.stringify(f.files.get('cpu-3-original-result')), /moving-frame p99/);
    return send(method, params, signal);
  }) as Cdp['send'];
  await profilePanning(f.cdp, f.browser, f.evidence, async cdp => {
    for (const initiator of ['quota', 'budget', 'funds']) for (const period of ['24h', '30d']) {
      await cdp.evaluate(`(() => {\n        const initiator="${initiator}",period="${period}";const probe=window.__quotumPan={};probe.raf=schedule(tick);})()`);
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', deltaX: 12});
      if (initiator === 'budget' && period === '24h') await cdp.evaluate('(() => {\n        const p=window.__quotumPan;p.cleanup();return {};})()');
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    }
    return {reports: [], problems: []};
  });
  assert.equal(f.sent.filter(row => row.method === 'Profiler.start').length, 6);
  assert.equal(f.sent.filter(row => row.method === 'HeapProfiler.startSampling').length, 1);
  assert.equal(f.sent.filter(row => row.method === 'HeapProfiler.stopSampling').length, 1);
  assert.equal((f.files.get('cpu-3-allocations') as {status: string}).status, 'complete');
  assert.deepEqual([...f.files.keys()].filter(name => /^cpu-\d+-allocations$/.test(name)), ['cpu-3-allocations']);
  assert.equal(f.sent.filter(row => row.method === 'Input.dispatchMouseEvent').length, 6);
  const original = JSON.stringify(safeEvidence(f.files.get('cpu-3-original-result')));
  assert.ok(Buffer.byteLength(original) < 4096); assert.doesNotMatch(original, /private-canary|timeline|entries/);
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


test('two-millisecond sampling retains the full CI idle interval within the original profile cap', async () => {
  const f = fixture(), send = f.cdp.send.bind(f.cdp);
  const profile = {...recorded(), startTime: 10_000, endTime: 120_010_000, samples: Array<number>(60_000).fill(2), timeDeltas: Array<number>(60_000).fill(2000)};
  f.cdp.send = (async (method: string, params: object) => method === 'Profiler.stop' ? {profile} : send(method, params)) as Cdp['send'];
  assert.equal(await profileInterval(f.cdp, f.browser, async () => 17, f.evidence, 2000), 17);
  assert.deepEqual(f.sent.find(row => row.method === 'Profiler.setSamplingInterval')?.params, {interval: 2000});
  const report = f.files.get('profile') as {samplingInterval: number; profile: ReturnType<typeof numericProfile>};
  assert.equal(report.samplingInterval, 2000);
  assert.equal(report.profile.status, 'complete');
  assert.ok('samples' in report.profile);
  assert.equal(report.profile.samples.length, 60_000);
  const overflow = numericProfile({...profile, samples: Array<number>(120_000).fill(2), timeDeltas: Array<number>(120_000).fill(1000)});
  assert.equal(overflow.status, 'insufficient-evidence');
  assert.ok('omittedSamples' in overflow);
  assert.equal(overflow.omittedSamples, 20_000);
});
