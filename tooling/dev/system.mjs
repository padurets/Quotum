import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Hooks must address their target, even when called with another tree's Git context.
export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_') || key === 'GIT_SSH_COMMAND'));
}
export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {env: cleanEnv(), encoding: 'utf8'}).trim();
}
export function context(root) {
  const actual = git(root, 'rev-parse', '--show-toplevel');
  if (actual !== root) throw new Error('The target must be a worktree root.');
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const shared = path.join(common, 'quotum-dev');
  const id = hash(root).slice(0, 24);
  const local = path.join(root, '.quotum-dev');
  for (const dir of [local, shared]) if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) throw new Error(`Unrecognized runtime directory: ${dir}`);
  return {root, common, shared, id, record: path.join(shared, 'trees', `${id}.json`), local};
}
export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Unreadable state: ${file}`); }
}
export function atomic(file, text) {
  mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const entry = lstatSync(file, {throwIfNoEntry: false});
  if (entry && !entry.isFile()) throw new Error(`Expected a regular file: ${file}`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, {mode: entry ? entry.mode & 0o777 : 0o600, flag: 'wx'});
    renameSync(tmp, file);
  } finally { rmSync(tmp, {force: true}); }
}
export const saveJson = (file, value) => atomic(file, `${JSON.stringify(value, null, 2)}\n`);

/** Kernel locks release on crashes; supervisors inherit no lock descriptor. */
export async function locked(file, action) {
  mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const holder = spawn('flock', ['--exclusive', '--timeout', '3600', file, process.execPath, '-e',
    'process.send("locked"); process.on("disconnect",()=>process.exit()); process.on("message",()=>process.exit());'],
  {stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: cleanEnv()});
  const exited = new Promise(resolve => holder.once('exit', resolve));
  await new Promise((resolve, reject) => {
    holder.once('message', resolve);
    holder.once('error', reject);
    holder.once('exit', () => reject(new Error(`Could not acquire lock: ${file}`)));
  });
  try { return await action(); }
  finally { holder.send('release'); await exited; }
}

/** PID alone cannot authorize signals: include boot, start time and process group. */
export function processOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (parts[0] === 'Z') return null;
    return {pid: Number(pid), group: Number(parts[2]), session: Number(parts[3]), start: parts[19],
      boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()};
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
export function sameProcess(identity) {
  if (!identity) return false;
  return sameIdentity(processOf(identity.pid), identity);
}
export function sameIdentity(observed, recorded) {
  return !!observed && !!recorded && ['pid', 'group', 'session', 'start', 'boot'].every(key => observed[key] === recorded[key]);
}
export function groupMembers(group) {
  return readdirSync('/proc').filter(id => /^\d+$/.test(id)).map(processOf).filter(p => p?.group === group && p.session === group);
}
export function ownedMembers(state) {
  if (!state?.supervisor) return [];
  const leader = processOf(state.supervisor.pid);
  if (leader && !sameIdentity(leader, state.supervisor)) throw new Error('Recorded PID now belongs to another process; refusing to signal it.');
  const members = groupMembers(state.supervisor.pid);
  // A live group cannot be reused; if its leader vanished, every member must have
  // inherited our instance marker. This also recovers a crash before readiness.
  for (const member of members) {
    if (member.boot !== state.supervisor.boot || BigInt(member.start) < BigInt(state.supervisor.start)) throw new Error('Foreign process group.');
    if (sameIdentity(member, state.supervisor) || sameIdentity(member, state.hub)) continue;
    let env;
    try { env = readFileSync(`/proc/${member.pid}/environ`, 'utf8').split('\0'); }
    catch (error) {
      // A process may exit between stat and environ (including EACCES during exit).
      if (!sameProcess(member)) continue;
      throw Object.assign(new Error('Cannot verify a surviving process in the recorded group; cleanup blocked.'), {code: 'OWNERSHIP_UNAVAILABLE'});
    }
    if (!env.includes(`DEV_INSTANCE_ID=${state.instance}`)) throw new Error('Unverified process in the recorded group; cleanup blocked.');
  }
  return members.filter(sameProcess);
}

/** Reading reservations never grants signal permission or blocks unrelated trees. */
export function hasRuntimeReservation(state) {
  if (!state?.supervisor) return false;
  const leader = processOf(state.supervisor.pid);
  if (leader && !sameIdentity(leader, state.supervisor)) return false;
  const members = groupMembers(state.supervisor.pid);
  if (!members.some(member => member.boot === state.supervisor.boot && BigInt(member.start) >= BigInt(state.supervisor.start))) return false;
  try { return ownedMembers(state).length > 0; }
  catch {
    // Inconclusive live ownership keeps this number reserved, without preventing
    // allocation of other numbers. stop() still refuses unverified signals.
    return true;
  }
}

/** Exiting processes can stop exposing environ before stat reports their exit. */
export async function waitOwnedMembers(state, until) {
  for (;;) {
    try { return ownedMembers(state); }
    catch (error) {
      if (error.code !== 'OWNERSHIP_UNAVAILABLE' || Date.now() >= until) throw error;
      await sleep(50);
    }
  }
}

export function listenerOwned(pid, port) {
  try {
    const inodes = new Set(readdirSync(`/proc/${pid}/fd`).map(fd => {
      try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ''; }
    }));
    for (const table of ['tcp', 'tcp6']) {
      const rows = readFileSync(`/proc/${pid}/net/${table}`, 'utf8').trim().split('\n').slice(1);
      if (rows.some(row => {
        const fields = row.trim().split(/\s+/);
        return fields[3] === '0A' && parseInt(fields[1].split(':')[1], 16) === port && inodes.has(`socket:[${fields[9]}]`);
      })) return true;
    }
    return false;
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
}
