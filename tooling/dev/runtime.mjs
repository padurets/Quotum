import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, openSync, closeSync, cpSync, readFileSync, readdirSync, renameSync, rmSync, lstatSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {externalUrl} from './access.mjs';
import {assertConfig, configKeys, portFree, savedConfig, validateState} from './config.mjs';
import {cleanEnv, git, hash, listenerOwned, locked, ownedMembers, processOf, readJson, sameProcess, saveJson, sleep, waitOwnedMembers} from './system.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function isolatedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(cleanEnv(env)).filter(([key]) => !/^(QUOTUM_|DEV_|PUBLIC_DOMAIN$|CODER_|NODE_OPTIONS$|NODE_PATH$)/.test(key)));
}
export function fileHash(dir) {
  if (!existsSync(dir)) return null;
  const items = [];
  const walk = base => {
    for (const name of readdirSync(base).sort()) {
      const file = path.join(base, name);
      if (lstatSync(file).isDirectory()) walk(file);
      else items.push(`${path.relative(dir, file)}\0${hash(readFileSync(file))}`);
    }
  };
  walk(dir);
  return hash(items.join('\n'));
}
function sourceFiles(ctx) {
  return [...new Set(git(ctx.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'hub', 'tooling/dev').split('\0').filter(Boolean))].sort();
}
function sourceHash(root, files) {
  return hash([process.version, ...files.map(file => `${file}\0${existsSync(path.join(root, file)) ? hash(readFileSync(path.join(root, file))) : 'deleted'}`)].join('\n'));
}
export function sourceBuild(ctx) {
  return sourceHash(ctx.root, sourceFiles(ctx));
}
export function desired(c, port) {
  return {...Object.fromEntries(configKeys.filter(key => c[key] !== undefined).map(key => [key, c[key]])), QUOTUM_PORT: String(port)};
}
export async function run(command, args, cwd, env = isolatedEnv()) {
  const child = spawn(command, args, {cwd, env, stdio: 'inherit'});
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code}).`)));
  });
}
export async function build(ctx) {
  return locked(path.join(ctx.shared, 'heavy.lock'), async () => {
    const hub = path.join(ctx.root, 'hub');
    const files = sourceFiles(ctx);
    const inputs = sourceHash(ctx.root, files);
    const prior = readJson(path.join(ctx.local, 'build.json'));
    const deps = hash(`${process.version}|${readFileSync(path.join(hub, 'package-lock.json'))}`);
    if (prior?.deps !== deps || !existsSync(path.join(hub, 'node_modules/tsx/dist/loader.mjs'))) await run('npm', ['ci'], hub);
    if (prior?.inputs !== inputs || !fileHash(path.join(hub, 'dist')) || prior.output !== fileHash(path.join(hub, 'dist'))) {
      console.log('Building current worktree code.');
      await run('npm', ['run', 'build'], hub);
    }
    if (sourceBuild(ctx) !== inputs) throw new Error('Source changed during the build; run make dev again.');
    const output = fileHash(path.join(hub, 'dist'));
    const snapshot = path.join(ctx.local, 'builds', `${inputs}-${output}`);
    const snapshotHub = path.join(snapshot, 'hub');
    if (!existsSync(snapshot)) {
      const tmp = `${snapshot}.${randomUUID()}.tmp`;
      mkdirSync(tmp, {recursive: true, mode: 0o700});
      try {
        // The demo imports source modules too. Freeze those and the supervisor,
        // not just the built server, before accepting this build's identity.
        for (const file of files) {
          const original = path.join(ctx.root, file);
          if (!existsSync(original)) continue;
          const dest = path.join(tmp, file);
          mkdirSync(path.dirname(dest), {recursive: true, mode: 0o700});
          cpSync(original, dest, {dereference: true});
        }
        mkdirSync(path.join(tmp, 'hub'), {recursive: true, mode: 0o700});
        cpSync(path.join(hub, 'dist'), path.join(tmp, 'hub/dist'), {recursive: true});
        cpSync(path.join(hub, 'package.json'), path.join(tmp, 'hub/package.json'));
        symlinkSync(path.join(hub, 'node_modules'), path.join(tmp, 'hub/node_modules'));
        if (sourceHash(tmp, files) !== inputs || sourceBuild(ctx) !== inputs) throw new Error('Source changed while freezing the build; run make dev again.');
        saveJson(path.join(tmp, 'source.json'), {version: 1, files, inputs});
        renameSync(tmp, snapshot);
      } finally { rmSync(tmp, {recursive: true, force: true}); }
    }
    const manifest = readJson(path.join(snapshot, 'source.json'));
    if (manifest?.version !== 1 || sourceHash(snapshot, manifest.files) !== inputs || fileHash(path.join(snapshotHub, 'dist')) !== output) throw new Error('Managed build snapshot is inconsistent; inspect .quotum-dev/builds.');
    const controller = path.join(snapshot, 'tooling/dev/serve.mjs');
    const result = {inputs, deps, output, root: snapshot, hub: snapshotHub, ...(existsSync(controller) ? {controller} : {}), commit: git(ctx.root, 'rev-parse', 'HEAD')};
    saveJson(path.join(ctx.local, 'build.json'), result);
    return result;
  });
}

export async function healthy(state) {
  if (state.status !== 'ready' || !sameProcess(state.supervisor) || !sameProcess(state.hub) || !listenerOwned(state.hub.pid, state.port)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health`, {signal: AbortSignal.timeout(1500), redirect: 'error'});
    return res.ok && sameProcess(state.hub);
  } catch { return false; }
}
function dataDirectory(ctx, state) {
  if (!state?.data) return null;
  const expected = path.join(ctx.local, state.mode === 'hub' ? 'hub-data' : `demo-${state.instance}`);
  if (state.data !== expected) throw new Error('Unrecognized data path; cleanup blocked.');
  if (!existsSync(expected)) return null;
  const marker = readJson(path.join(expected, 'owner.json'));
  if (lstatSync(expected).isSymbolicLink() || marker?.root !== ctx.root || marker?.kind !== state.mode) throw new Error('Unverified data directory; cleanup blocked.');
  if (state.mode === 'demo' && marker.instance !== state.instance) throw new Error('Mismatched data owner; cleanup blocked.');
  return expected;
}
export function removeData(ctx, state, final = false) {
  const dir = dataDirectory(ctx, state);
  if (dir && (state.mode === 'demo' || final)) rmSync(dir, {recursive: true});
}
function signal(target, kind) {
  try { process.kill(target, kind); return true; }
  catch (error) {
    // A verified target can exit before the syscall. The caller rechecks the group
    // before any further signal or cleanup; other failures still block it.
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
export async function stop(ctx, final = false) {
  const state = readJson(ctx.record);
  validateState(ctx, state);
  if (!state) return;
  // Older managed supervisors may still remove their supplied directory themselves.
  // Refuse an unowned path before asking any supervisor to stop, then check again.
  dataDirectory(ctx, state);
  let until = Date.now() + 8000;
  let members = await waitOwnedMembers(state, until);
  if (members.length) {
    console.log(`Stopping owned instance ${state.instance}.`);
    // SIGTERM the supervisor first, so Demo stops its own requests before the hub.
    if (sameProcess(state.supervisor)) {
      if (!signal(state.supervisor.pid, 'SIGTERM') && (await waitOwnedMembers(state, until)).length) signal(-state.supervisor.pid, 'SIGTERM');
    } else signal(-state.supervisor.pid, 'SIGTERM');
    until = Date.now() + 8000;
    while (Date.now() < until) {
      members = await waitOwnedMembers(state, until);
      if (!members.length) break;
      await sleep(100);
    }
    members = await waitOwnedMembers(state, until);
    if (members.length) {
      signal(-state.supervisor.pid, 'SIGKILL');
      until = Date.now() + 3000;
      while (Date.now() < until) {
        members = await waitOwnedMembers(state, until);
        if (!members.length) break;
        await sleep(50);
      }
    }
    if ((await waitOwnedMembers(state, until)).length) throw new Error('Owned process group did not stop; reservation retained.');
  }
  removeData(ctx, state, final);
  if (final) rmSync(ctx.record);
  else saveJson(ctx.record, {...state, status: 'stopped', supervisor: null, hub: null, access: {status: 'backend stopped; publication retained'}});
}

export async function start(ctx, c, port, built) {
  if (!(await portFree(port))) throw Object.assign(new Error(`Port ${port} has a foreign listener; no process was adopted or killed.`), {code: 'PORT_BUSY'});
  assertConfig(ctx.root, savedConfig(c), port);
  const instance = randomUUID();
  const mode = c.DEV_MODE;
  const data = path.join(ctx.local, mode === 'hub' ? 'hub-data' : `demo-${instance}`);
  const marker = readJson(path.join(data, 'owner.json'));
  if (existsSync(data) && (lstatSync(data).isSymbolicLink() || marker?.root !== ctx.root || marker?.kind !== mode)) throw new Error('Existing data is not owned by this controller.');
  mkdirSync(data, {recursive: true, mode: 0o700});
  saveJson(path.join(data, 'owner.json'), {root: ctx.root, kind: mode, instance});
  const log = path.join(ctx.local, 'stand.log');
  if (existsSync(log) && !lstatSync(log).isFile()) throw new Error('Unrecognized stand log; refusing to overwrite it.');
  const url = externalUrl(c, port);
  const state = {version: 1, root: ctx.root, instance, port, mode, config: desired(c, port), preparedConfig: savedConfig(c), build: built,
    data, log, status: 'starting', startedAt: new Date().toISOString(), access: {status: c.DEV_ACCESS === 'none' ? 'local' : 'not published yet'}};
  saveJson(ctx.record, state);
  const env = {...isolatedEnv(), DEV_INSTANCE_ID: instance, QUOTUM_PORT: String(port), QUOTUM_BIND: '127.0.0.1',
    QUOTUM_ALLOWED_HOSTS: [...new Set(['localhost', '127.0.0.1', ...(c.QUOTUM_ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean), ...(url ? [new URL(url).hostname] : [])])].join(','),
    QUOTUM_RESETS: 'off'};
  for (const key of ['QUOTUM_PUBLIC_URL', 'QUOTUM_TRUST_PROXY', 'QUOTUM_FRAME_ANCESTORS']) if (c[key]) env[key] = c[key];
  if (url) { env.QUOTUM_PUBLIC_URL = url; env.QUOTUM_TRUST_PROXY = 'true'; }
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [built.controller ?? path.join(here, 'serve.mjs'), ctx.root, ctx.record, instance], {cwd: ctx.root, env, detached: true, stdio: ['ignore', fd, fd, 'ipc']});
  closeSync(fd);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Readiness timed out; inspect ${log}.`)), 60000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => {
        clearTimeout(timeout);
        const journal = readJson(ctx.record);
        reject(Object.assign(new Error(`Stand exited before readiness; inspect ${log}.`), {code: journal?.instance === instance ? journal.failureCode : undefined}));
      });
      child.on('message', message => {
        if (message.event === 'ready') { clearTimeout(timeout); resolve(); }
        if (message.event === 'failed') { clearTimeout(timeout); reject(Object.assign(new Error(`Stand could not start; inspect ${log}.`), {code: message.code})); }
      });
    });
    if (!(await healthy(readJson(ctx.record)))) throw new Error('Readiness identity/listener check failed.');
    assertConfig(ctx.root, savedConfig(c), port);
  } catch (error) {
    // The supervisor writes its identity before opening a listener, even if our caller dies.
    await sleep(100);
    await stop(ctx);
    throw error;
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
  return readJson(ctx.record);
}
