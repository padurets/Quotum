import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SCENARIO_IDS, suitesFor, type BenchScope, type CoverageSummary} from './coverage.js';
import {providerOf} from '../server/domain/providers.js';

export type BenchPhase = 'startup' | 'preparation' | 'fixture' | 'browser' | 'history-traffic' | 'dashboard-setup' | 'warmup' | 'idle-alignment' | 'idle' | 'measurements' | 'work' | 'observed-work' | 'private-work' | 'frequency' | 'conditioning' | 'panning' | 'credits' | 'money' | 'fixed-activity' | 'measurement-details' | 'coverage' | 'cleanup' | 'history-suffix' | 'caption-control';
const LIMIT = 1024 * 1024;
const forbidden = /cookie|authorization|password|secret|credential|commandLine|expression|scriptSource|environment|stdout|stderr|stack/i;
const labels = new Set(['status', 'stage', 'mode', 'method', 'scenario', 'phase', 'kind', 'event', 'name', 'period', 'initiator', 'segment', 'version', 'executable', 'platform', 'failure', 'reason', 'context', 'node', 'region', 'coding', 'type', 'state', 'birth', 'signal', 'spawnCode', 'native', 'cleanup', 'collection', 'livenessStatus', 'page', 'scheduler', 'byteVerdict', 'stagingDisposition', 'mechanism', 'metricsStatus']);
const requestLabels = new Map([
  ['inputSegment', new Set(['wheel', 'drag', 'return'])],
  ['scope', new Set(['quota', 'budget', 'funds', 'all', 'dashboard', 'history', 'updates', 'panning'])],
  ['outcome', new Set(['running', 'passed', 'failed', 'cancelled', 'incomplete'])],
  ['classification', new Set(['budget', 'fixture', 'runtime', 'cancelled', 'cleanup', 'coverage'])],
  ['cells', new Set(['skip', 'read'])],
  ['evidence', new Set(['skip', 'cursor', 'baseline'])],
  ['endpoint', new Set(['history', 'period', 'period/sessions'])],
  ['errorCode', new Set(['history_limit', 'too_large', 'other', 'unavailable'])],
  ['operation', new Set(['calendar-projection', 'values', 'restore', 'adoption', 'retirement'])],
  ['surface', new Set(['card', 'topbar', 'agents-panel', 'forecast', 'budget-table', 'activity-totals'])],
  ['tag', new Set(['DIV', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BUTTON', 'INPUT', 'LABEL', 'UL', 'LI', 'P', 'SMALL', 'NAV', 'FOOTER', 'DL', 'DT', 'DD', 'TIME', 'svg', 'path', 'g', 'line', 'text', 'tspan', 'rect', 'clipPath'])],
  ['attribute', new Set(['class', 'style', 'title', 'aria-label', 'aria-busy', 'aria-hidden', 'data-time', 'data-table-metric', 'data-pan-end', 'd', 'transform', 'hidden', 'inert', 'disabled'])],
]);

/** Diagnostic payloads are numeric evidence and synthetic identifiers, never arbitrary text. */
export function safeEvidence(value: unknown, key = '', depth = 0, entryLimit = 10_000): unknown {
  if (depth > 24) return '[depth limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (['sampleFromNs','sampleToNs','terminationAttemptNs'].includes(key)) return /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n ? value : '[text omitted]';
    if (['scenarioId', 'expected', 'missing', 'duplicates', 'incomplete'].includes(key)) return SCENARIO_IDS.has(value) ? value : '[text omitted]';
    // Request classifications survive without admitting resource names or cursor text.
    if (requestLabels.get(key)?.has(value)) return value;
    // Measurements use the same synthetic source IDs as their card regions.
    if (key === 'source' && /^[a-z][a-z0-9-]{0,31}:[a-f0-9]{12}$/.test(value) && providerOf(value.split(':')[0])) return value;
    if (!labels.has(key) && !/^(id|.*Id|.*Hash|sha|tree|run|attempt|fixture)$/.test(key)) return '[text omitted]';
    if (value.length > 240 || /https?:\/\/|wss?:\/\/|(?:^|\s)(?:\/[\w.-]+){2,}|[A-Z]:\\|(?:token|cookie|secret|password)\s*[:=]/i.test(value)) return '[text omitted]';
    return value;
  }
  if (Array.isArray(value)) {
    const entries = value.slice(0, entryLimit).map(item => safeEvidence(item, key, depth + 1, entryLimit));
    return value.length > entryLimit ? {entries, omittedEntries: value.length - entryLimit} : entries;
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !forbidden.test(name)).slice(0, 10_000)
    .map(([name, field]) => [name.length <= 160 && !/https?:|\\|\/home\//.test(name) ? name : '[key omitted]', safeEvidence(field, name, depth + 1, entryLimit)]));
}

function git(value: string): string | null {
  try {return execFileSync('git', ['rev-parse', value], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']}).trim();}
  catch {return null;}
}
function dirty(): boolean | null {
  try {return !!execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']}).trim();}
  catch {return null;}
}
const read = (file: string) => {try {return readFileSync(file, 'utf8').trim();} catch {return null;}};

/** Profile positions refer to the compiled client, whose bytes can differ on one Git SHA. */
export function clientIdentity(directory = path.join(import.meta.dirname, '../dist/client/assets')) {
  try {
    const names = readdirSync(directory).filter(name => /^index-[\w-]+\.js$/.test(name));
    if (names.length !== 1) return {status: 'unavailable' as const};
    const data = readFileSync(path.join(directory, names[0]));
    return {status: 'available' as const, name: names[0], bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')};
  } catch {return {status: 'unavailable' as const};}
}

/** Each phase survives later failures. Files are atomically replaced inside a unique run directory. */
export class Evidence {
  readonly id = randomUUID();
  private readonly directory?: string;
  private readonly started = performance.now();
  private readonly files: {name: string; bytes: number; sha256: string; truncated: boolean}[] = [];
  private readonly errors: string[] = [];
  private readonly environment = {
    node: process.version, platform: process.platform, release: os.release(), architecture: process.arch,
    cpu: os.cpus()[0]?.model, cpuMax: read('/sys/fs/cgroup/cpu.max'), memoryMax: read('/sys/fs/cgroup/memory.max'),
    image: process.env.ImageOS?.replace(/[^a-zA-Z0-9.-]/g, ''), imageVersion: process.env.ImageVersion?.replace(/[^a-zA-Z0-9.-]/g, ''),
  };
  private readonly identity = {sha: git('HEAD'), tree: git('HEAD^{tree}'), dirty: dirty(), client: clientIdentity(), run: process.env.GITHUB_RUN_ID?.replace(/\D/g, ''), attempt: process.env.GITHUB_RUN_ATTEMPT?.replace(/\D/g, '')};
  private readonly journal: {phase: BenchPhase; startMs: number | null; endMs?: number; durationMs?: number; outcome: 'running' | 'passed' | 'failed' | 'cancelled' | 'incomplete' | 'unreached'; classification?: 'budget' | 'fixture' | 'runtime' | 'cancelled' | 'cleanup' | 'coverage'; artifactIds: string[]}[] = [];
  private primaryFailure?: {phase: string; classification: string};
  private coverageRetained = true;
  private phase = 'startup';
  private status = 'running';
  private completedPhase?: string;

  constructor(directory = process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR) {
    if (directory) {
      this.directory = path.join(directory, this.id);
      try {mkdirSync(this.directory, {recursive: true, mode: 0o700});} catch {this.errors.push('directory unavailable');}
    }
    this.begin('startup');
  }

  plan(scope: BenchScope) {
    const suites=suitesFor(scope);
    const phases: BenchPhase[] = ['preparation','fixture','browser',...(suites.includes('history')?['history-traffic' as const]:[]),
      ...(suites.includes('updates')||suites.includes('panning')?['dashboard-setup'] as const:[]),
      ...(scope==='panning'?['conditioning'] as const:[]),
      ...(suites.includes('updates')||suites.includes('panning')?['warmup'] as const:[]),
      ...(suites.includes('updates')?['idle-alignment','idle','measurements','work','observed-work','private-work','frequency'] as const:[]),
      ...(suites.includes('panning')?(scope==='panning'?['panning'] as const:['conditioning','panning'] as const):[]),
      ...(suites.includes('updates')?['credits','money','fixed-activity','measurement-details'] as const:[]),'coverage','cleanup'];
    this.journal.push(...phases.map(phase => ({phase, startMs: null, outcome: 'unreached' as const, artifactIds: []})));this.manifest();
  }
  begin(phase: BenchPhase) {
    if (phase === 'cleanup') this.completedPhase = this.phase;
    if (this.journal.some(row => row.startMs !== null && row.endMs === undefined)) this.end('incomplete');
    this.phase = phase;
    const current = this.journal.find(row => row.phase === phase && row.outcome === 'unreached');
    if (current) Object.assign(current, {startMs: this.elapsed(), outcome: 'running'});
    else this.journal.push({phase, startMs: this.elapsed(), outcome: 'running', artifactIds: []});
    this.manifest();
  }
  end(outcome: 'passed' | 'failed' | 'cancelled' | 'incomplete' = 'passed', classification?: 'budget' | 'fixture' | 'runtime' | 'cancelled' | 'cleanup' | 'coverage') {
    const current = this.journal.find(row => row.startMs !== null && row.endMs === undefined);
    if (current) {
      if (current.outcome === 'failed' || current.outcome === 'cancelled') {outcome = current.outcome;classification = current.classification;}
      const endMs = this.elapsed();Object.assign(current, {endMs, durationMs: endMs - current.startMs!, outcome, ...(classification ? {classification} : {})});
      if ((outcome === 'failed' || outcome === 'cancelled') && !this.primaryFailure) this.primaryFailure = {phase: current.phase, classification: classification ?? 'runtime'};
    }
    this.manifest();
    if (current?.endMs !== undefined) console.error(`bench: phase ${current.phase} ${current.outcome} ${current.durationMs} ms`);
  }
  fail(classification: 'budget' | 'coverage') {
    const current = this.journal.find(row => row.startMs !== null && row.endMs === undefined);
    if (current) {current.outcome = 'failed';current.classification ??= classification;this.primaryFailure ??= {phase: current.phase, classification};this.manifest();}
  }
  checked(problems: readonly unknown[]) {this.end(problems.length ? 'failed' : 'passed', problems.length ? 'budget' : undefined);}
  private elapsed() {return Math.round(performance.now() - this.started);}
  saveCoverage(value: CoverageSummary): boolean {
    const text = JSON.stringify(value);
    if (JSON.stringify(safeEvidence(value)) !== text) this.coverageRetained = false;
    if (this.directory) {
      this.saveBounded('coverage', value, LIMIT, 10_000);
      try {
        const file = this.files.find(file => file.name === 'coverage.json');
        if (!file || file.truncated || readFileSync(path.join(this.directory, 'coverage.json'), 'utf8') !== text) this.coverageRetained = false;
      } catch {this.coverageRetained = false;}
    }
    this.manifest();
    return this.coverageRetained && (!this.directory || !this.errors.length);
  }
  save(name: string, value: unknown) {this.saveBounded(name, value, LIMIT, 10_000);}
  saveTrace(name: string, value: unknown) {this.saveBounded(name, value, 32 * LIMIT, 100_000);}
  private saveBounded(name: string, value: unknown, limit: number, entries: number) {
    if (!this.directory) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {this.errors.push('invalid evidence name'); this.manifest(); return;}
    try {
      let text = JSON.stringify(safeEvidence(value, '', 0, entries));
      const originalBytes = Buffer.byteLength(text), truncated = originalBytes > limit;
      if (truncated) text = JSON.stringify({status: 'insufficient-evidence', reason: 'summary limit', originalBytes});
      const file = name + '.json';
      this.write(file, text);
      const prior = this.files.findIndex(item => item.name === file);
      if (prior !== -1) this.files.splice(prior, 1);
      const current = this.journal.find(row => row.phase === this.phase);
      if (current && !current.artifactIds.includes(file)) current.artifactIds.push(file);
      this.files.push({name: file, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), truncated});
    } catch {this.errors.push('evidence write failed');}
    this.manifest();
  }
  finish(status: 'passed' | 'failed' | 'cancelled' | 'diagnostic', cleanup: unknown) {
    this.status = status; this.save('cleanup', cleanup); this.manifest();
    return !this.directory || !this.errors.length && this.coverageRetained;
  }
  private write(name: string, value: string) {
    writeFileSync(path.join(this.directory!, name + '.tmp'), value, {mode: 0o600});
    renameSync(path.join(this.directory!, name + '.tmp'), path.join(this.directory!, name));
  }
  private manifest() {
    if (!this.directory) return;
    try {this.write('manifest.json', JSON.stringify({schemaVersion: 1, id: this.id, identity: this.identity, environment: this.environment,
      phase: this.phase, completedPhase: this.completedPhase, status: this.status, journal: this.journal, primaryFailure: this.primaryFailure, coverageRetained: this.coverageRetained, elapsedMs: Math.round(performance.now() - this.started), files: this.files, errors: this.errors}));}
    catch {if (!this.errors.includes('manifest write failed')) this.errors.push('manifest write failed');}
  }
}
