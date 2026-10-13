import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processIdentity, type ProcessIdentity} from '../browserProcess.js';
import {safeEvidence} from '../evidence.js';
import {StartupWaits, type ProcReader, type ProcReading} from '../startupWait.js';

type Anchor = Pick<ProcessIdentity, 'pid' | 'parent' | 'group' | 'session' | 'birth'>;
type CounterFile = 'io' | 'schedstat' | 'wchan';
const available = (text: string): ProcReading => ({status: 'available', text});
const io = 'rchar: 0\nwchar: 2\nread_bytes: 3\nwrite_bytes: 4\ncancelled_write_bytes: 5\n';
const counters = {io, schedstat: '6 7 8\n', wchan: 'folio_wait_bit_common'};
const flush = async () => {await new Promise<void>(resolve => setImmediate(resolve));};
function stat(change: Partial<Anchor> = {}) {
  const value = {pid: 101, parent: 99, group: 101, session: 101, birth: '123', ...change};
  const fields = Array.from({length: 50}, () => '0'); fields[0] = 'D';
  fields[1] = String(value.parent); fields[2] = String(value.group); fields[3] = String(value.session); fields[19] = value.birth;
  return `${value.pid} (private path ) secret-canary) ${fields.join(' ')}`;
}
const root = processIdentity(101, stat())!;
function fixture(options: {before?: string; after?: string; counters?: Partial<Record<CounterFile, ProcReading>>} = {}) {
  const calls: string[] = []; let stats = 0;
  const read: ProcReader = async (pid, file) => {
    assert.equal(pid, root.pid); calls.push(file);
    return file === 'stat' ? available(++stats === 1 ? options.before ?? stat() : options.after ?? stat())
      : options.counters?.[file] ?? available(counters[file]);
  };
  return {calls, ledger: new StartupWaits(root.pid, root.parent, true, read, () => 1)};
}
async function capture(options: Parameters<typeof fixture>[0] = {}, supplied = root) {
  const f = fixture(options); f.ledger.sample(supplied, 0); await flush(); return {...f, report: f.ledger.freeze()};
}
function deferred() {
  let resolve!: (reading: ProcReading) => void;
  const promise = new Promise<ProcReading>(done => {resolve = done;});
  return {promise, resolve};
}

test('startup waits require the same owned identity before and after reading counters', async () => {
  const good = await capture(), row = good.report.samples[0];
  assert.deepEqual(good.calls, ['stat', 'io', 'schedstat', 'wchan', 'stat']); assert.equal(good.report.status, 'observed');
  assert.deepEqual(row.io?.values, {rchar: 0, wchar: 2, read_bytes: 3, write_bytes: 4, cancelled_write_bytes: 5});
  assert.deepEqual(row.schedule?.values, {runtime: 6, waiting: 7, slices: 8}); assert.deepEqual(row.wait, {status: 'available', category: 1});
  const safe = safeEvidence(good.report);
  assert.doesNotMatch(JSON.stringify(safe), /private path|secret-canary|folio_wait|\/proc\//);
  assert.equal((safe as typeof good.report).samples[0].identity?.birth, '123');
  for (const changed of [{pid: 102}, {parent: 100}, {group: 102}, {session: 102}, {birth: '0'}]) {
    const f = await capture({}, {...root, ...changed}); assert.equal(f.calls.length, 0); assert.equal(f.report.samples[0].status, 'unknown');
  }
  for (const changed of [{pid: 102}, {parent: 100}, {group: 102}, {session: 102}, {birth: '124'}]) {
    const before = await capture({before: stat(changed)}); assert.deepEqual(before.calls, ['stat']); assert.equal(before.report.samples[0].io, null);
    const after = await capture({after: stat(changed)}); assert.equal(after.calls.length, 5); assert.equal(after.report.samples[0].io, null);
    assert.equal(after.report.samples[0].schedule, null); assert.equal(after.report.samples[0].wait, null); assert.equal(after.report.samples[0].status, 'unknown');
  }
  const f = fixture(); f.ledger.sample(root, 0); await flush(); f.ledger.sample({...root, birth: '124'}, 500); await flush();
  const report = f.ledger.freeze(); assert.equal(f.calls.length, 5); assert.equal(report.samples[1].identity?.birth, '123'); assert.equal(report.samples[1].io, null);
});

test('unavailable, malformed, duplicate and unsafe counters remain unknown', async () => {
  const cases: {file: 'io' | 'schedstat'; reading: ProcReading; reason: string}[] = [
    {file: 'io', reading: available(io.replace('rchar: 0\n', '')), reason: 'missing'},
    {file: 'io', reading: available(io + 'rchar: 0\n'), reason: 'duplicate'},
    {file: 'io', reading: available(io.replace('rchar: 0', 'rchar: -1')), reason: 'malformed'},
    {file: 'io', reading: available(io.replace('rchar: 0', 'rchar: 9007199254740992')), reason: 'overflow'},
    {file: 'schedstat', reading: available('1 2'), reason: 'malformed'},
    {file: 'schedstat', reading: available('1 9007199254740992 3'), reason: 'overflow'},
    {file: 'schedstat', reading: {status: 'unknown', reason: 'missing'}, reason: 'missing'},
  ];
  for (const value of cases) {
    const f = await capture({counters: {[value.file]: value.reading}}), row = f.report.samples[0];
    const result = value.file === 'io' ? row.io : row.schedule;
    assert.ok(result?.status === 'unknown'); assert.equal(result.reason, value.reason); assert.equal(result.values, null); assert.equal(row.status, 'unknown');
  }
  for (const [text, reason] of [['0', 'zero'], ['privateKernelCanary', 'unmapped'], ['bad/name', 'malformed']]) {
    const f = await capture({counters: {wchan: available(text)}});
    assert.deepEqual(f.report.samples[0].wait, {status: 'unknown', category: 0, reason});
    assert.doesNotMatch(JSON.stringify(f.report), /privateKernelCanary|bad\/name/);
  }
});

test('a rejected parallel read cannot release the collector while another read is pending', async () => {
  const schedule = deferred(), wait = deferred(), calls: string[] = [];
  const read: ProcReader = async (_pid, file) => {
    calls.push(file);
    if (file === 'io') throw new Error('private read failure');
    if (file === 'schedstat') return schedule.promise;
    if (file === 'wchan') return wait.promise;
    return available(stat());
  };
  const ledger = new StartupWaits(root.pid, root.parent, true, read, () => 1);
  ledger.sample(root, 0); await flush(); assert.deepEqual(calls, ['stat', 'io', 'schedstat', 'wchan']);
  ledger.sample(root, 500); schedule.resolve(available(counters.schedstat)); await flush();
  ledger.sample(root, 1000); assert.equal(calls.length, 4);
  wait.resolve(available(counters.wchan)); await flush(); assert.equal(calls.length, 5);
  ledger.sample(root, 1500); await flush(); assert.equal(calls.length, 10);
  const report = ledger.freeze(); assert.equal(report.pendingAtTerminal, false); assert.equal(report.skippedPending, 2); assert.equal(report.samples.length, 2);
  for (const row of report.samples) {assert.ok(row.io?.status === 'unknown'); assert.equal(row.io.reason, 'unavailable');}
  assert.doesNotMatch(JSON.stringify(report), /private read failure/);
});

test('freezing a blocked collector returns unknown immediately and prevents late credits', async () => {
  const pending = deferred(), calls: string[] = []; let signal: AbortSignal | undefined;
  const read: ProcReader = async (_pid, file, supplied) => {calls.push(file); signal = supplied; return pending.promise;};
  const ledger = new StartupWaits(root.pid, root.parent, true, read, () => 1);
  ledger.sample(root, 0); ledger.sample(root, 500);
  const frozen = ledger.freeze(), saved = JSON.stringify(frozen);
  assert.equal(frozen.pendingAtTerminal, true); assert.equal(frozen.skippedPending, 1); assert.equal(signal?.aborted, true);
  assert.equal(frozen.samples[0].status, 'unknown'); assert.equal(frozen.samples[0].reason, 'pending-at-terminal');
  pending.resolve(available(stat())); await flush(); ledger.sample(root, 1000);
  assert.deepEqual(calls, ['stat']); assert.equal(ledger.freeze(), frozen); assert.equal(JSON.stringify(frozen), saved);
});

test('startup waits retain at most 48 samples and explicitly count omitted checkpoints', async () => {
  const f = fixture();
  for (let i = 0; i < 48; i++) {f.ledger.sample(root, i * 500); await flush();}
  f.ledger.sample(root, 24_000);
  const report = f.ledger.freeze(); assert.equal(report.samples.length, 48); assert.equal(report.omitted, 1); assert.equal(f.calls.length, 240);
  assert.ok(report.samples.every(row => row.status === 'observed')); assert.equal(report.status, 'incomplete');
});
