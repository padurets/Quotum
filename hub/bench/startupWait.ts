import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {processIdentity, type ProcessIdentity} from './browserProcess.js';

const LIMIT = 4096;
const IO = ['rchar', 'wchar', 'read_bytes', 'write_bytes', 'cancelled_write_bytes'] as const;
type ProcFile = 'stat' | 'io' | 'schedstat' | 'wchan';
type Unknown = 'missing' | 'denied' | 'unavailable' | 'oversize' | 'malformed' | 'overflow' | 'duplicate' | 'zero' | 'unmapped';
export type ProcReading = {status: 'available'; text: string} | {status: 'unknown'; reason: Unknown};
export type ProcReader = (pid: number, file: ProcFile, signal: AbortSignal) => Promise<ProcReading>;
type CounterReading<T> = {status: 'available'; values: T} | {status: 'unknown'; reason: Unknown; values: null};
type WaitReading = {status: 'available' | 'unknown'; category: number; reason?: Unknown};
type Anchor = Pick<ProcessIdentity, 'pid' | 'parent' | 'group' | 'session' | 'birth'>;
type Sample = {id: number; elapsedMs: number | null; fromMs: number | null; toMs: number | null;
  status: 'pending' | 'observed' | 'unknown'; reason?: string; identity: Anchor | null;
  before: ProcessIdentity | null; after: ProcessIdentity | null;
  io: CounterReading<Record<typeof IO[number], number>> | null;
  schedule: CounterReading<{runtime: number; waiting: number; slices: number}> | null; wait: WaitReading | null};

// Categories describe exact observed symbol families, not the cause or duration of a wait.
const WAIT = new Map([
  ...['folio_wait_bit_common', 'folio_wait_locked', 'wait_on_page_bit_common', '__lock_page'].map(name => [name, 1] as const),
  ...['io_schedule', 'io_schedule_timeout', 'wait_on_buffer'].map(name => [name, 2] as const),
  ...['futex_wait', 'futex_wait_queue', 'futex_wait_queue_me'].map(name => [name, 3] as const),
  ...['ep_poll', 'do_epoll_wait', 'poll_schedule_timeout'].map(name => [name, 4] as const),
  ...['hrtimer_nanosleep', 'do_nanosleep'].map(name => [name, 5] as const),
  ...['do_wait', 'wait_for_completion', 'wait_for_completion_killable'].map(name => [name, 6] as const),
]);

/** Fixed owned-PID paths, bounded buffers, and no raw contents in exported evidence. */
async function readProc(pid: number, file: ProcFile, signal: AbortSignal): Promise<ProcReading> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reading: ProcReading = {status: 'unknown', reason: 'unavailable'};
  try {
    signal.throwIfAborted();
    handle = await open(`/proc/${pid}/${file}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    signal.throwIfAborted();
    const buffer = Buffer.alloc(LIMIT + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    reading = bytesRead > LIMIT ? {status: 'unknown', reason: 'oversize'} : {status: 'available', text: buffer.subarray(0, bytesRead).toString()};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    reading = {status: 'unknown', reason: code === 'ENOENT' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable'};
  } finally {try {await handle?.close();} catch {reading = {status: 'unknown', reason: 'unavailable'};}}
  return reading;
}

function integer(text: string): number | 'malformed' | 'overflow' {
  if (!/^\d+$/.test(text)) return 'malformed';
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 'overflow';
}
function ioCounters(reading: ProcReading): CounterReading<Record<typeof IO[number], number>> {
  if (reading.status === 'unknown') return {status: 'unknown', reason: reading.reason, values: null};
  const values = {} as Record<typeof IO[number], number>;
  for (const name of IO) {
    const rows = reading.text.split('\n').filter(line => line.startsWith(name + ':'));
    if (rows.length !== 1) return {status: 'unknown', reason: rows.length ? 'duplicate' : 'missing', values: null};
    const text = new RegExp('^' + name + ':\\s+(\\d+)\\s*$').exec(rows[0]);
    const value = text ? integer(text[1]) : 'malformed';
    if (typeof value !== 'number') return {status: 'unknown', reason: value, values: null};
    values[name] = value;
  }
  return {status: 'available', values};
}
function scheduleCounters(reading: ProcReading): CounterReading<{runtime: number; waiting: number; slices: number}> {
  if (reading.status === 'unknown') return {status: 'unknown', reason: reading.reason, values: null};
  const fields = reading.text.trim().split(/\s+/);
  if (fields.length !== 3) return {status: 'unknown', reason: 'malformed', values: null};
  const values = fields.map(integer), bad = values.find(value => typeof value !== 'number');
  if (bad) return {status: 'unknown', reason: bad, values: null};
  return {status: 'available', values: {runtime: values[0] as number, waiting: values[1] as number, slices: values[2] as number}};
}
function waitCategory(reading: ProcReading): WaitReading {
  if (reading.status === 'unknown') return {status: 'unknown', reason: reading.reason, category: 0};
  const text = reading.text.trim();
  if (text === '0') return {status: 'unknown', reason: 'zero', category: 0};
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/.test(text)) return {status: 'unknown', reason: 'malformed', category: 0};
  const category = WAIT.get(text);
  return category === undefined ? {status: 'unknown', reason: 'unmapped', category: 0} : {status: 'available', category};
}
const same = (a: Anchor, b: Anchor) => a.pid === b.pid && a.birth === b.birth && a.parent === b.parent && a.group === b.group && a.session === b.session;
function identity(reading: ProcReading, expected: Anchor) {
  if (reading.status !== 'available' || !reading.text.startsWith(expected.pid + ' (')) return null;
  const found = processIdentity(expected.pid, reading.text);
  return found && same(found, expected) ? found : null;
}

/** One pending collector on the launcher's existing root checkpoints; never awaited by readiness. */
export class StartupWaits {
  private readonly samples: Sample[] = [];
  private anchor?: Anchor;
  private pending?: {controller: AbortController; row: Sample};
  private omitted = 0;
  private skippedPending = 0;
  private sealed = false;
  private frozen?: ReturnType<StartupWaits['report']>;

  constructor(private readonly pid: number | undefined, private readonly parent: number, private readonly supported: boolean,
    private readonly read: ProcReader = readProc, private readonly now = () => performance.now()) {}

  sample(root: ProcessIdentity, elapsedMs: number): void {
    if (this.sealed) return;
    if (this.pending) {this.skippedPending++; return;}
    if (this.samples.length === 48) {this.omitted++; return;}
    const valid = this.supported && Number.isSafeInteger(this.pid) && this.pid! > 0
      && [root.pid, root.parent, root.group, root.session].every(value => Number.isSafeInteger(value) && value > 0)
      && root.pid === this.pid && root.parent === this.parent && root.group === this.pid && root.session === this.pid
      && /^[1-9]\d{0,19}$/.test(root.birth) && Number.isFinite(elapsedMs) && elapsedMs >= 0;
    const captured = valid ? {pid: root.pid, parent: root.parent, group: root.group, session: root.session, birth: root.birth} : null;
    if (!this.anchor && captured) this.anchor = captured;
    const row: Sample = {id: this.samples.length + 1, elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
      fromMs: this.stamp(), toMs: null, status: 'unknown', identity: this.anchor ?? null,
      before: null, after: null, io: null, schedule: null, wait: null};
    this.samples.push(row);
    if (!captured || !this.anchor || !same(captured, this.anchor)) {row.reason = 'identity-unavailable-or-changed'; row.toMs = this.stamp(); return;}
    row.status = 'pending';
    const pending = {controller: new AbortController(), row};
    this.pending = pending;
    void this.collect(row, captured, pending.controller.signal).finally(() => {if (this.pending === pending) this.pending = undefined;});
  }
  freeze() {
    if (this.frozen) return this.frozen;
    this.sealed = true;
    if (this.pending) {
      this.pending.row.status = 'unknown'; this.pending.row.reason = 'pending-at-terminal';
      this.pending.controller.abort();
    }
    this.frozen = structuredClone(this.report());
    return this.frozen;
  }
  private stamp(): number | null {
    try {const value = this.now(); return Number.isFinite(value) && value >= 0 ? value : null;} catch {return null;}
  }
  private report() {
    return {status: !this.supported || !this.anchor || this.omitted || this.skippedPending || this.samples.some(row => row.status !== 'observed') ? 'incomplete' : 'observed',
      kind: 'Owned root process samples; symbol categories and raw counters do not prove a wait cause.',
      sampleLimit: 48, readByteLimit: LIMIT, omitted: this.omitted, skippedPending: this.skippedPending, pendingAtTerminal: !!this.pending,
      tickUnitsQualified: false, schedulerUnitsQualified: false, kernelSymbolsRevisionBound: false,
      observerOverheadQualified: false, causeProven: false, samples: this.samples};
  }
  private async collect(row: Sample, expected: Anchor, signal: AbortSignal) {
    const read = async (file: ProcFile): Promise<ProcReading> => {
      try {return await this.read(expected.pid, file, signal);} catch {return {status: 'unknown', reason: 'unavailable'};}
    };
    try {
      const before = identity(await read('stat'), expected);
      if (this.sealed || signal.aborted) return;
      if (!before) {row.status = 'unknown'; row.reason = 'identity-before-unavailable-or-changed'; row.toMs = this.stamp(); return;}
      const [io, schedule, wait] = await Promise.all([read('io'), read('schedstat'), read('wchan')]);
      if (this.sealed || signal.aborted) return;
      const after = identity(await read('stat'), expected);
      if (this.sealed || signal.aborted) return;
      if (!after) {row.status = 'unknown'; row.reason = 'identity-after-unavailable-or-changed'; row.toMs = this.stamp(); return;}
      row.before = before; row.after = after; row.io = ioCounters(io); row.schedule = scheduleCounters(schedule); row.wait = waitCategory(wait);
      row.toMs = this.stamp();
      row.status = row.io.status === 'available' && row.schedule.status === 'available' && row.wait.status === 'available'
        && row.fromMs !== null && row.toMs !== null && row.toMs >= row.fromMs ? 'observed' : 'unknown';
      if (row.status === 'unknown') row.reason = 'counter-or-clock-unavailable';
    } catch {
      if (!this.sealed) {row.status = 'unknown'; row.reason = 'read-unavailable'; row.toMs = this.stamp();}
    }
  }
}
