import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIMIT = 1024 * 1024;
const forbidden = /cookie|authorization|password|secret|credential|commandLine|expression|scriptSource|environment|stdout|stderr|stack/i;
const labels = new Set(['status', 'stage', 'mode', 'method', 'scenario', 'phase', 'kind', 'event', 'name', 'period', 'initiator', 'segment', 'version', 'executable', 'platform', 'failure', 'reason', 'context', 'node', 'region', 'coding', 'type', 'state', 'birth', 'signal', 'spawnCode', 'native', 'cleanup', 'collection', 'livenessStatus', 'page']);

/** Diagnostic payloads are numeric evidence and synthetic identifiers, never arbitrary text. */
export function safeEvidence(value: unknown, key = '', depth = 0): unknown {
  if (depth > 24) return '[depth limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (!labels.has(key) && !/^(id|.*Id|.*Hash|sha|tree|run|attempt|fixture)$/.test(key)) return '[text omitted]';
    if (value.length > 240 || /https?:\/\/|wss?:\/\/|(?:^|\s)(?:\/[\w.-]+){2,}|[A-Z]:\\|(?:token|cookie|secret|password)\s*[:=]/i.test(value)) return '[text omitted]';
    return value;
  }
  if (Array.isArray(value)) {
    const entries = value.slice(0, 10_000).map(item => safeEvidence(item, key, depth + 1));
    return value.length > 10_000 ? {entries, omittedEntries: value.length - 10_000} : entries;
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !forbidden.test(name)).slice(0, 10_000)
    .map(([name, field]) => [name.length <= 160 && !/https?:|\\|\/home\//.test(name) ? name : '[key omitted]', safeEvidence(field, name, depth + 1)]));
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
  private readonly identity = {sha: git('HEAD'), tree: git('HEAD^{tree}'), dirty: dirty(), run: process.env.GITHUB_RUN_ID?.replace(/\D/g, ''), attempt: process.env.GITHUB_RUN_ATTEMPT?.replace(/\D/g, '')};
  private phase = 'startup';
  private status = 'running';
  private completedPhase?: string;

  constructor(directory = process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR) {
    if (directory) {
      this.directory = path.join(directory, this.id);
      try {mkdirSync(this.directory, {recursive: true, mode: 0o700});} catch {this.errors.push('directory unavailable');}
    }
    this.manifest();
  }

  begin(phase: string) {if (phase === 'cleanup') this.completedPhase = this.phase; this.phase = phase; this.manifest();}
  save(name: string, value: unknown) {
    if (!this.directory) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {this.errors.push('invalid evidence name'); this.manifest(); return;}
    try {
      let text = JSON.stringify(safeEvidence(value));
      const originalBytes = Buffer.byteLength(text), truncated = originalBytes > LIMIT;
      if (truncated) text = JSON.stringify({status: 'insufficient-evidence', reason: 'summary limit', originalBytes});
      const file = name + '.json';
      this.write(file, text);
      const prior = this.files.findIndex(item => item.name === file);
      if (prior !== -1) this.files.splice(prior, 1);
      this.files.push({name: file, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), truncated});
    } catch {this.errors.push('evidence write failed');}
    this.manifest();
  }
  finish(status: 'passed' | 'failed' | 'cancelled' | 'diagnostic', cleanup: unknown) {
    this.status = status; this.save('cleanup', cleanup); this.manifest();
  }
  private write(name: string, value: string) {
    writeFileSync(path.join(this.directory!, name + '.tmp'), value, {mode: 0o600});
    renameSync(path.join(this.directory!, name + '.tmp'), path.join(this.directory!, name));
  }
  private manifest() {
    if (!this.directory) return;
    try {this.write('manifest.json', JSON.stringify({schemaVersion: 1, id: this.id, identity: this.identity, environment: this.environment,
      phase: this.phase, completedPhase: this.completedPhase, status: this.status, elapsedMs: Math.round(performance.now() - this.started), files: this.files, errors: this.errors}));}
    catch {if (!this.errors.includes('manifest write failed')) this.errors.push('manifest write failed');}
  }
}
