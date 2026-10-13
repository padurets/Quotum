import test from 'node:test';
import assert from 'node:assert/strict';
import {Cdp, type Browser} from '../cdp.js';
import {RunOwner} from '../runOwner.js';
import {timeIdle, traceIdle} from '../idleTiming.js';
import {traceSanitizer} from '../traceEvents.js';
import {traceInterval} from '../panningDiagnostic.js';
import {ScriptBinding} from '../scriptBinding.js';
import {createHash} from 'node:crypto';
import {safeEvidence} from '../evidence.js';

const counters = (at: number) => ({Timestamp: at, ScriptDuration: at / 10, TaskDuration: at / 5, ThreadTime: at / 4,
  DevToolsCommandDuration: at / 20, V8CompileDuration: 0, LayoutDuration: 0, RecalcStyleDuration: 0});
function fixture() {
  const sent: string[] = [], files = new Map<string, unknown>();
  let closed = 0, reads = 0;
  const thread = {send: async (method: string, params: object) => {
    sent.push(method);
    if (method === 'Performance.enable') assert.deepEqual(params, {timeDomain: 'threadTicks'});
    if (method === 'Performance.getMetrics') return {metrics: Object.entries(counters(reads++ ? 4 : 1)).map(([name, value]) => ({name, value}))};
  }, close: () => {closed++;}} as unknown as Cdp;
  const primary = {endpoint: 'ws://private-canary.invalid/target', send: () => {throw new Error('Primary counters changed');}} as unknown as Cdp;
  const owner = new RunOwner(), browser = {owned: true, owner} as Browser;
  const connect = async (endpoint: string) => {assert.equal(endpoint, primary.endpoint); return thread;};
  const evidence = {save: (name: string, value: unknown) => {files.set(name, value);}};
  const value = {before: counters(2), after: counters(3), originalFailure: true};
  return {thread, primary, browser, connect, evidence, files, sent, value, closed: () => closed};
}

test('thread counters bracket the same original result without changing its elapsed session', async () => {
  const f = fixture(); let calls = 0;
  const value = await timeIdle(f.primary, f.browser, async () => {calls++;return f.value;}, f.evidence, f.connect);
  assert.equal(value, f.value); assert.equal(calls, 1); assert.equal(f.closed(), 1);
  assert.deepEqual(f.sent, ['Performance.enable', 'Performance.getMetrics', 'Performance.getMetrics', 'Performance.disable']);
  const report = f.files.get('idle-timing') as {status: string; thread: {before: unknown; after: unknown}};
  assert.equal(report.status, 'complete'); assert.deepEqual(report.thread, {before: counters(1), after: counters(4)});
  assert.doesNotMatch(JSON.stringify(safeEvidence(report)), /private-canary|ws:/);
});

test('unsupported thread clocks retain the original run and cannot become complete evidence', async () => {
  const f = fixture(); const error = new Error('thread clock unsupported');
  f.thread.send = (async method => {f.sent.push(method); if (method === 'Performance.enable') throw error;}) as Cdp['send'];
  let calls = 0;
  const value = await timeIdle(f.primary, f.browser, async () => {calls++;return f.value;}, f.evidence, f.connect);
  assert.equal(value, f.value); assert.equal(calls, 1); assert.equal(f.closed(), 1);
  assert.deepEqual(f.sent, ['Performance.enable', 'Performance.disable']);
  assert.equal((f.files.get('idle-timing') as {status: string}).status, 'insufficient-evidence');
});

test('missing, reversed and nonbracketing counters never support a thread-time comparison', async () => {
  for (const bad of [{Timestamp: 2.5}, {ThreadTime: NaN}, {ScriptDuration: -1}]) {
    const f = fixture(), send = f.thread.send.bind(f.thread); let reads = 0;
    f.thread.send = (async (method, params, signal) => {
      const reply = await send(method, params, signal);
      if (method !== 'Performance.getMetrics' || reads++ !== 1) return reply;
      return {metrics: Object.entries({...counters(4), ...bad}).map(([name, value]) => ({name, value}))};
    }) as Cdp['send'];
    await timeIdle(f.primary, f.browser, async () => f.value, f.evidence, f.connect);
    assert.equal((f.files.get('idle-timing') as {status: string}).status, 'insufficient-evidence'); assert.equal(f.closed(), 1);
  }
});

test('original failures survive failed diagnostic cleanup and the secondary socket closes', async () => {
  const f = fixture(), original = new Error('Original idle failed'), send = f.thread.send.bind(f.thread);
  f.thread.send = (async (method, params, signal) => {if (method === 'Performance.disable') throw new Error('cleanup failed');return send(method, params, signal);}) as Cdp['send'];
  await assert.rejects(timeIdle(f.primary, f.browser, async () => {throw original;}, f.evidence, f.connect), error => error === original);
  assert.equal(f.closed(), 1); assert.deepEqual(f.browser.owner!.failures, ['Idle thread clock cleanup unconfirmed']);
  const report = f.files.get('idle-timing') as {cleanup: string; measurement: unknown; status: string};
  assert.equal(report.cleanup, 'incomplete'); assert.equal(report.measurement, null); assert.equal(report.status, 'insufficient-evidence');
});


function tracingFixture() {
  const f = fixture(), listeners = new Map<string, (value: unknown) => void>(), starts: object[] = [];
  let browserCloses = 0;
  const primary = {endpoint: f.primary.endpoint,
    on: (name: string, callback: (value: unknown) => void) => listeners.set(name, callback),
    off: (name: string) => listeners.delete(name),
    send: async (method: string, params: object) => {
      if (method === 'Tracing.start') starts.push(params);
      if (method === 'Tracing.end') listeners.get('Tracing.tracingComplete')?.({});
      return {metrics: [{name: 'Timestamp', value: 42}]};
    },
    evaluate: async () => ({now: 7, after: 7, timeOrigin: 35}),
  } as unknown as Cdp;
  const browser = {...f.browser, close: async () => {browserCloses++;}};
  return {...f, primary, browser, listeners, starts, browserCloses: () => browserCloses};
}

const timerEvent = (name = 'TimerInstall', data: object = {}) => ({name, ph: 'I', ts: 100, pid: 3, tid: 4,
  args: {data: {timerId: 7, timeout: 250, singleShot: true,
    stackTrace: [{scriptId: '8', lineNumber: 9, columnNumber: 245638, functionName: 'private-canary', url: 'https://private-canary.invalid'}], ...data}}});

test('timer fields and finite source frames are opt-in and never export private frame text', async () => {
  const plain = traceSanitizer(), timers = traceSanitizer(true);
  assert.equal(plain(timerEvent()), undefined);
  assert.equal(plain(timerEvent('TimerRemove')), undefined);
  assert.equal(plain(timerEvent('TimerFire'))?.timer, undefined);
  const f = tracingFixture();
  await traceInterval(f.primary, f.browser, async () => {
    f.listeners.get('Tracing.dataCollected')?.({value: ['TimerInstall', 'TimerRemove', 'TimerFire'].map(name => timerEvent(name))});
  }, {...f.evidence, saveTrace: f.evidence.save}, true);
  assert.deepEqual(f.starts, [{categories: 'cc,devtools.timeline,disabled-by-default-devtools.timeline.stack', transferMode: 'ReportEvents'}]);
  const report = safeEvidence(f.files.get('trace')) as {events: {timer: {id: number; timeout?: number; ownerFrames: {frames: object[]}}}[]; timerEvidence: {status: string; install: number; remove: number; fire: number}};
  assert.deepEqual(report.events.map(e => e.timer.id), [7, 7, 7]);
  assert.equal(report.events[0].timer.timeout, 250);
  assert.equal(report.events[1].timer.timeout, undefined);
  assert.deepEqual(report.events[0].timer.ownerFrames.frames, [{scriptId: 8, lineNumber: 9, columnNumber: 245638}]);
  assert.deepEqual([report.timerEvidence.install, report.timerEvidence.remove, report.timerEvidence.fire], [1, 1, 1]);
  assert.equal(report.timerEvidence.status, 'captured');
  assert.doesNotMatch(JSON.stringify(report), /private-canary|functionName|https:|\"url\"|stackTrace/);
  assert.ok(timers(timerEvent())?.timer);
});

test('missing, malformed and bounded-out timer source frames remain explicit unknown evidence', () => {
  const sanitize = traceSanitizer(true);
  for (const stackTrace of [undefined, []]) {
    const value = sanitize(timerEvent('TimerInstall', {stackTrace}))!.timer!;
    assert.equal(value.ownerFrames.status, 'unavailable');
    assert.deepEqual(value.ownerFrames.frames, []);
  }
  for (const stackTrace of [null, {}, [{scriptId: '08', lineNumber: 9, columnNumber: 3}], [{scriptId: '8', lineNumber: -1, columnNumber: 3}], [{scriptId: '8', lineNumber: 9}], [{scriptId: '0', lineNumber: 0, columnNumber: 0}]]) {
    const value = sanitize(timerEvent('TimerInstall', {stackTrace}))!.timer!;
    assert.equal(value.ownerFrames.status, 'insufficient-evidence');
    assert.equal(value.ownerFrames.invalid, 1);
    assert.deepEqual(value.ownerFrames.frames, []);
  }
  const frames = Array.from({length: 33}, () => ({scriptId: '8', lineNumber: 0, columnNumber: 0}));
  const value = sanitize(timerEvent('TimerInstall', {stackTrace: frames}))!.timer!;
  assert.equal(value.ownerFrames.status, 'insufficient-evidence');
  assert.equal(value.ownerFrames.frames.length, 32);
  assert.equal(value.ownerFrames.omitted, 1);
  assert.deepEqual(value.ownerFrames.frames[0], {scriptId: 8, lineNumber: 0, columnNumber: 0});
  assert.equal(sanitize(timerEvent('TimerInstall', {timerId: 'private-canary', timeout: -1, singleShot: 'private-canary'}))!.timer!.invalid, 3);
});

test('empty and invalid timer collections cannot claim a captured timer interval', async () => {
  for (const events of [[], [timerEvent('TimerInstall', {stackTrace: undefined})], [{...timerEvent(), ph: 'private-canary'}]]) {
    const f = tracingFixture();
    await traceInterval(f.primary, f.browser, async () => {f.listeners.get('Tracing.dataCollected')?.({value: events});}, {...f.evidence, saveTrace: f.evidence.save}, true);
    const report = f.files.get('trace') as {status: string; timerEvidence: {status: string; install: number; invalid: number; missingInstallOwners: number}};
    assert.equal(report.status, 'complete');
    assert.equal(report.timerEvidence.status, 'insufficient-evidence');
    if (events.length) assert.equal(report.timerEvidence.install, 1);
    assert.doesNotMatch(JSON.stringify(safeEvidence(report)), /private-canary/);
  }
});

test('exact idle subtraction fields are qualified independently of generic thread counters', async () => {
  for (const extra of [{}, {reading: {instrumentMs: 0}, actualSeconds: 1}, {reading: {instrumentMs: 0.125}, actualSeconds: 2}, {reading: {instrumentMs: -1}, actualSeconds: 1}]) {
    const f = fixture(), value = {...f.value, ...extra};
    await timeIdle(f.primary, f.browser, async () => value, f.evidence, f.connect);
    const report = f.files.get('idle-timing') as {measurement: {status: string; instrumentMs: number | null; actualSeconds: number | null}};
    assert.equal(report.measurement.status, 'reading' in extra && extra.reading!.instrumentMs === 0 ? 'complete' : 'insufficient-evidence');
    if (!('reading' in extra)) {assert.equal(report.measurement.instrumentMs, null); assert.equal(report.measurement.actualSeconds, null);}
    else assert.equal(report.measurement.instrumentMs, extra.reading!.instrumentMs);
  }
});

for (const failure of ['returned', 'thrown']) test(`timer trace cleanup retains the original ${failure} idle failure`, async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = tracingFixture(), send = f.primary.send.bind(f.primary), original = new Error('original idle failed');
  let stopping = () => {}, calls = 0;
  const reached = new Promise<void>(resolve => {stopping = resolve;});
  f.primary.send = (async (method, params, signal) => {
    if (method === 'Tracing.end') {stopping(); return {};}
    return send(method, params, signal);
  }) as Cdp['send'];
  const problems = [{reason: 'original traffic failure'}, {reason: 'original phase failure'}, {reason: 'original idle failure'}];
  const outcome = assert.rejects(traceIdle(f.primary, f.browser, async () => {
    calls++;
    if (failure === 'thrown') throw original;
    f.evidence.save('idle-timing-result', {problems});
    return {...f.value, reading: {instrumentMs: 0.125}, actualSeconds: 1};
  }, f.evidence, f.connect), error => failure === 'thrown' ? error === original : error instanceof Error && error.message === 'diagnostic trace drain failed at events');
  await reached; await new Promise<void>(resolve => queueMicrotask(resolve));
  t.mock.timers.tick(5000); await outcome;
  assert.equal(calls, 1); assert.equal(f.closed(), 1); assert.equal(f.browserCloses(), 1); assert.equal(f.listeners.size, 0);
  if (failure === 'returned') assert.deepEqual(f.files.get('idle-timing-result'), {problems});
  const report = f.files.get('idle-timing-trace') as {cleanup: string; timerEvidence: {status: string}};
  assert.equal(report.cleanup, 'incomplete'); assert.equal(report.timerEvidence.status, 'insufficient-evidence');
});

test('source-binding cleanup failure retains the already saved original idle result', async () => {
  const f = tracingFixture(), send = f.primary.send.bind(f.primary), body = 'abc', hash = createHash('sha256').update(body).digest('hex');
  const url = 'https://private-canary.invalid/assets/index-fixture.js';
  const binding = new ScriptBinding(f.primary, {status: 'available', name: 'index-fixture.js', bytes: 3, sha256: hash}, f.evidence.save);
  f.primary.send = (async (method, params, signal) => {
    if (method === 'Network.getResponseBody') return {body, base64Encoded: false};
    if (method === 'Debugger.enable') {f.listeners.get('Debugger.scriptParsed')?.({scriptId: '8', url, hash}); return {};}
    if (method === 'Debugger.disable') throw new Error('cleanup failed');
    return send(method, params, signal);
  }) as Cdp['send'];
  f.listeners.get('Network.responseReceived')?.({requestId: 'fixture', type: 'Script', response: {url}});
  const problems = [{reason: 'original traffic failure'}, {reason: 'original phase failure'}, {reason: 'original idle failure'}];
  await traceIdle(f.primary, f.browser, async () => {f.evidence.save('idle-timing-result', {problems}); return f.value;}, f.evidence, f.connect);
  await assert.rejects(binding.afterFamily([1]), /cleanup unconfirmed/);
  assert.deepEqual(f.files.get('idle-timing-result'), {problems});
  binding.close();
});


test('idle timer browser version is bounded, outside the original reading and exports only four qualified fields', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const mode of ['available', 'missing', 'rejected', 'timeout']) {
    const f = tracingFixture(), send = f.primary.send.bind(f.primary);
    let originalRead = false, versionRequests = 0, waiting = () => {};
    const reached = new Promise<void>(resolve => {waiting = resolve;});
    f.primary.send = (async (method, params, signal) => {
      if (method !== 'Browser.getVersion') return send(method, params, signal);
      assert.ok(originalRead); versionRequests++; waiting();
      if (mode === 'available') return {product: 'Chrome/154.0.7883.1', revision: '@' + 'a'.repeat(40), jsVersion: '14.4.199.5', protocolVersion: '1.3', userAgent: 'private-canary', url: 'https://private-canary.invalid'};
      if (mode === 'missing') return {product: 'private-canary', revision: 'private-canary', jsVersion: 'private-canary', protocolVersion: 'private-canary'};
      if (mode === 'rejected') throw new Error('private-canary');
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
    }) as Cdp['send'];
    const pending = traceIdle(f.primary, f.browser, async () => {originalRead = true; f.evidence.save('idle-timing-result', {problems: [{reason: 'original idle failure'}]}); return f.value;}, f.evidence, f.connect);
    await reached; await new Promise<void>(resolve => queueMicrotask(resolve));
    if (mode === 'timeout') t.mock.timers.tick(2000);
    assert.equal(await pending, f.value); assert.equal(versionRequests, 1);
    const receipt = safeEvidence(f.files.get('idle-timing-browser-version')) as {status: string; chromium: {version: string | null; sha: string | null}; v8: {version: string | null}; protocol: {version: string | null}};
    assert.equal(receipt.status, mode === 'available' ? 'complete' : 'insufficient-evidence');
    if (mode === 'available') {assert.equal(receipt.chromium.version, 'Chrome/154.0.7883.1'); assert.equal(receipt.chromium.sha, 'a'.repeat(40)); assert.equal(receipt.v8.version, '14.4.199.5'); assert.equal(receipt.protocol.version, '1.3');}
    assert.doesNotMatch(JSON.stringify(receipt), /private-canary|userAgent|https:|url/);
    assert.deepEqual(f.files.get('idle-timing-result'), {problems: [{reason: 'original idle failure'}]});
  }
});
