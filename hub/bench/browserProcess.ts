import type {ChildProcess} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';

type Identity = {pid: number; parent: number; group: number; session: number; birth: string; state: string};
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function identity(pid: number): Promise<Identity | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields.length > 19 ? {pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), birth: fields[19]} : null;
}

/** Only numeric identities are read. No command lines, process-name matching, or foreign signals. */
async function processes(): Promise<Identity[]> {
  const entries = await readdir('/proc');
  const result: Identity[] = [];
  // Limit concurrent reads on a shared machine.
  for (let from = 0; from < entries.length; from += 64) {
    const batch = await Promise.all(entries.slice(from, from + 64).filter(value => /^\d+$/.test(value)).map(value => identity(Number(value))));
    result.push(...batch.filter((value): value is Identity => value !== null));
  }
  return result;
}

export type ProcessCleanup = {status: 'closed' | 'residual'; term: boolean; kill: boolean; reaped: boolean; pipesClosed: boolean; elapsedMs: number; reason?: string};

/** A detached group is signalled only while an observed member still anchors its identity. */
export function browserProcess(child: ChildProcess, group: boolean) {
  const known = new Map<number, string>();
  let exited = false, pipesClosed = false, released = false;
  child.once('exit', () => {exited = true;});
  child.once('close', () => {pipesClosed = true;});
  const live = () => !exited && child.exitCode === null && child.signalCode === null;
  const observe = async () => {
    if (!child.pid || !group || process.platform !== 'linux') return [];
    const all=await processes();
    const current = all.filter(value=>value.group===child.pid&&value.session===child.pid);
    const anchored = current.some(value => (value.pid === child.pid && live()) || known.get(value.pid) === value.birth);
    if (anchored && !released) for (const value of current) known.set(value.pid, value.birth);
    if (!current.length && !live()) released = true;
    // Escaping the group never grants signal authority, but cannot count as a clean exit.
    const owned=new Set(all.filter(value=>known.get(value.pid)===value.birth).map(value=>value.pid));
    for(let depth=0;depth<16;depth++) {
      const descendants=all.filter(value=>owned.has(value.parent)&&!owned.has(value.pid));
      if(!descendants.length)break;
      for(const value of descendants){known.set(value.pid,value.birth);owned.add(value.pid);}
    }
    return all.filter(value=>owned.has(value.pid));
  };
  let closing: Promise<ProcessCleanup> | undefined;
  return {observe, close: () => closing ??= (async () => {
    const started = performance.now();
    const result: ProcessCleanup = {status: 'residual', term: false, kill: false, reaped: false, pipesClosed: false, elapsedMs: 0};
    try {
      while (performance.now() - started < 7_000) {
        const current = await observe();
        const workers = current.filter(value => value.state !== 'Z' && value.state !== 'X');
        let portableGroupExists = false;
        if (group && process.platform !== 'linux' && child.pid && !released) {
          try {process.kill(-child.pid, 0); portableGroupExists = true;}
          catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') released = true; else throw error;}
        }
        if ((!child.pid || !live()) && !workers.length && !portableGroupExists && pipesClosed) {result.status = 'closed'; break;}
        const canSignal = group && process.platform === 'linux'
          ? !released && workers.some(value => value.group===child.pid&&value.session===child.pid&&known.get(value.pid) === value.birth)
          : live();
        if (canSignal && (!result.term || (!result.kill && performance.now() - started >= 5_000))) {
          const signal = result.term ? 'SIGKILL' : 'SIGTERM';
          try {
            if (group) process.kill(-child.pid!, signal); else child.kill(signal);
            if (signal === 'SIGTERM') result.term = true; else result.kill = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {result.reason = 'signal failed'; break;}
            released = true;
          }
        }
        await wait(25);
      }
      if (result.status !== 'closed') result.reason ??= 'owned exit, group identity or pipe closure unconfirmed';
    } catch {result.reason = 'process identity unavailable';}
    finally {
      result.reaped = !child.pid || !live(); result.pipesClosed = pipesClosed;
      result.elapsedMs = Math.round(performance.now() - started);
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    return result;
  })()};
}
