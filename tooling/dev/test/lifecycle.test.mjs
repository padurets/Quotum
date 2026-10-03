import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import fs, {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Pool, coderPool, externalUrl} from '../access.mjs';
import {allocate, config, parseEnv, portFree, updateEnv} from '../config.mjs';
import {command, dirtyGuard, info} from '../cli.mjs';
import {build, fileHash, healthy, isolatedEnv, sourceBuild, start, stop} from '../runtime.mjs';
import {context, git, hash, ownedMembers, processOf, readJson, saveJson, sleep, waitOwnedMembers} from '../system.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'quotum-dev-test-'));
  const root = path.join(base, 'primary');
  mkdirSync(path.join(root, 'hub/demo'), {recursive: true});
  writeFileSync(path.join(root, '.gitignore'), '.env\n.quotum-dev/\nnode_modules/\n');
  writeFileSync(path.join(root, 'hub/demo/catalogue.ts'), "export const SETS = [{id: 'all'}, {id: 'showcase'}];\n");
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Test fixture');
  t.after(async () => {
    for (const name of ['primary', 'A', 'B', 'other']) {
      const tree = path.join(base, name);
      if (existsSync(tree) && statSync(tree).isDirectory()) {
        try { await stop(context(tree)); } catch {}
      }
    }
    rmSync(base, {recursive: true, force: true});
  });
  return {base, root, ctx: context(root)};
}
async function freeBase() {
  // The ephemeral probe is test scaffolding; managed allocations themselves ascend.
  const s = createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  for (let port = p; port < 65000; port++) if (await portFree(port) && await portFree(port + 1) && await portFree(port + 2)) return port;
  return freeBase();
}
async function listener(port) {
  const server = createServer();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {server, close: () => new Promise(resolve => server.close(resolve))};
}
function subprocess(root, action, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, action, root], {env: {...isolatedEnv(), ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let text = '';
    child.stdout.on('data', b => text += b);
    child.stderr.on('data', b => text += b);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(text) : reject(new Error(text)));
  });
}
function standIn(ctx) {
  mkdirSync(path.join(ctx.root, 'hub/dist/server'), {recursive: true});
  writeFileSync(path.join(ctx.root, 'hub/package.json'), '{"type":"module"}');
  writeFileSync(path.join(ctx.root, 'hub/dist/server/index.js'), `import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.QUOTUM_DATA_DIR+'/fixture-db', 'persistent fixture');
const server=createServer((req,res)=>res.end('ok'));
server.listen(Number(process.env.QUOTUM_PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
  git(ctx.root, 'add', 'hub');
  git(ctx.root, 'commit', '-m', 'Stand-in hub');
}
function preparedBuild(ctx) {
  mkdirSync(path.join(ctx.root, 'hub/node_modules/tsx/dist'), {recursive: true});
  writeFileSync(path.join(ctx.root, 'hub/node_modules/tsx/dist/loader.mjs'), '');
  writeFileSync(path.join(ctx.root, 'hub/package-lock.json'), '{}');
  const built = {inputs: sourceBuild(ctx), deps: hash(`${process.version}|${readFileSync(path.join(ctx.root, 'hub/package-lock.json'))}`), output: fileHash(path.join(ctx.root, 'hub/dist')), commit: git(ctx.root, 'rev-parse', 'HEAD')};
  saveJson(path.join(ctx.local, 'build.json'), built);
}
async function hubStand(t) {
  const {ctx} = fixture(t);
  standIn(ctx);
  const c = {...config(ctx.root, {}), DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())};
  const port = await allocate(ctx, c, null);
  const state = await start(ctx, c, port, {inputs: 'fixture-build', commit: 'fixture', output: 'fixture'});
  t.after(async () => { if (existsSync(ctx.root)) await stop(ctx); });
  return {ctx, c, port, state};
}

test('dotenv keeps unknown settings and literal shell text; malformed input is not rewritten', t => {
  const {ctx} = fixture(t);
  const text = '# personal settings\nUSER_SETTING="literal $(false) `false`" # keep\nDEV_SET=showcase\n';
  writeFileSync(path.join(ctx.root, '.env'), text);
  updateEnv(ctx.root, {QUOTUM_PORT: '12345'});
  assert.equal(readFileSync(path.join(ctx.root, '.env'), 'utf8').slice(0, text.length), text);
  assert.equal(parseEnv(readFileSync(path.join(ctx.root, '.env'), 'utf8')).USER_SETTING, 'literal $(false) `false`');
  assert.equal(config(ctx.root, {}).DEV_SET, 'showcase');
  writeFileSync(path.join(ctx.root, '.env'), 'QUOTUM_PORT=invalid\n');
  assert.throws(() => config(ctx.root, {}), /QUOTUM_PORT/);
  assert.equal(readFileSync(path.join(ctx.root, '.env'), 'utf8'), 'QUOTUM_PORT=invalid\n');
  assert.throws(() => parseEnv('A=1\nA=2'), /Duplicate/);
  assert.throws(() => parseEnv('not an assignment'), /Invalid/);
  assert.throws(() => config(ctx.root, {SLOT_CPUS: 'not a number'}), /SLOT_CPUS/);
  writeFileSync(path.join(ctx.root, '.env'), 'DEV_ACCESS=coder\n');
  assert.throws(() => config(ctx.root, {}), /Coder access needs PUBLIC_DOMAIN/);
});

test('atomic dotenv refuses symlinks and preserves the target', t => {
  const {ctx, base} = fixture(t);
  const other = path.join(base, 'other');
  writeFileSync(other, 'USER=keep\n');
  symlinkSync(other, path.join(ctx.root, '.env'));
  assert.throws(() => updateEnv(ctx.root, {QUOTUM_PORT: '12345'}), /regular file/);
  assert.equal(readFileSync(other, 'utf8'), 'USER=keep\n');
});

test('a dangling dotenv symlink is preserved and never materialized implicitly', t => {
  const {ctx, base} = fixture(t);
  const missing = path.join(base, 'missing-settings');
  const file = path.join(ctx.root, '.env');
  symlinkSync(missing, file);
  assert.throws(() => updateEnv(ctx.root, {QUOTUM_PORT: '12345'}), /regular file/);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(readlinkSync(file), missing);
  assert.equal(existsSync(missing), false);
});

test('a fully populated dotenv symlink is rejected even when preparation needs no rewrite', async t => {
  const {ctx, base} = fixture(t);
  const target = path.join(base, 'settings');
  const values = {...config(ctx.root, {}), QUOTUM_PORT: String(await freeBase())};
  writeFileSync(target, Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}\n`).join(''));
  symlinkSync(target, path.join(ctx.root, '.env'));
  const original = readFileSync(target, 'utf8');
  await assert.rejects(subprocess(ctx.root, 'prepare'), /regular file/);
  assert.equal(readJson(path.join(ctx.local, 'lease.json')), null);
  assert.equal(lstatSync(path.join(ctx.root, '.env')).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), original);
});

test('an env-supplied stable port is persisted, and a stale initial marker cannot change it', async t => {
  const {ctx} = fixture(t);
  standIn(ctx);
  const port = await freeBase();
  const c = config(ctx.root, {QUOTUM_PORT: String(port), DEV_MODE: 'hub'});
  assert.equal(await allocate(ctx, c, null), port);
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(port));
  assert.equal(readJson(path.join(ctx.local, 'lease.json')).initial, false);
  saveJson(path.join(ctx.local, 'lease.json'), {version: 1, port: port + 1, initial: true});
  preparedBuild(ctx);
  const foreign = await listener(port);
  t.after(foreign.close);
  await assert.rejects(subprocess(ctx.root, 'dev'), /foreign listener/);
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(port));
  assert.equal(readJson(path.join(ctx.local, 'lease.json')).initial, false);
});

test('allocation crash after dotenv rename retains its initial intent and bind recovery', async t => {
  const {ctx, base} = fixture(t);
  standIn(ctx);
  const port = await freeBase();
  const probe = path.join(base, 'crash.mjs');
  writeFileSync(probe, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync;
fs.renameSync=(a,b)=>{rename(a,b);if(b.endsWith('/.env'))process.kill(process.pid,'SIGKILL')};
syncBuiltinESMExports();
const {context}=await import(${JSON.stringify(new URL('../system.mjs', import.meta.url).href)});
const {config,allocate}=await import(${JSON.stringify(new URL('../config.mjs', import.meta.url).href)});
const root=process.argv[2];
await allocate(context(root),config(root,{DEV_MODE:'hub',DEV_PORT_START:process.argv[3]}),null);
`);
  assert.throws(() => execFileSync(process.execPath, [probe, ctx.root, String(port)], {stdio: 'ignore'}), error => error.signal === 'SIGKILL');
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(port));
  assert.deepEqual(readJson(path.join(ctx.local, 'lease.json')), {version: 1, port, initial: true});
  await subprocess(ctx.root, 'prepare');
  assert.equal(readJson(path.join(ctx.local, 'lease.json')).initial, true);
  preparedBuild(ctx);
  const foreign = await listener(port);
  t.after(foreign.close);
  await subprocess(ctx.root, 'dev');
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(port + 1));
});

test('a port added after the config snapshot is retained before any new claim', async t => {
  const {ctx} = fixture(t);
  const base = await freeBase();
  const stale = config(ctx.root, {DEV_PORT_START: String(base)});
  updateEnv(ctx.root, {QUOTUM_PORT: String(base + 2)});
  await assert.rejects(allocate(ctx, stale, null), /configuration changed/);
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(base + 2));
  assert.equal(readJson(path.join(ctx.local, 'lease.json')), null);
});

test('removing a saved port after the snapshot is respected rather than silently restored', async t => {
  const {ctx} = fixture(t);
  const file = path.join(ctx.root, '.env');
  writeFileSync(file, `QUOTUM_PORT=${await freeBase()}\n`);
  const c = config(ctx.root, {});
  writeFileSync(file, 'USER_SETTING=keep\n');
  await assert.rejects(allocate(ctx, c, null), /configuration changed/);
  assert.equal(readFileSync(file, 'utf8'), 'USER_SETTING=keep\n');
  assert.equal(readJson(path.join(ctx.local, 'lease.json')), null);
});

test('managed settings changed during access eligibility cannot be saved from stale intent', async t => {
  const {ctx} = fixture(t);
  const c = config(ctx.root, {DEV_PORT_START: String(await freeBase())});
  const access = {snapshot: async () => [], eligible: async () => { updateEnv(ctx.root, {DEV_SET: 'activity'}); return true; }};
  await assert.rejects(allocate(ctx, c, access), /configuration changed/);
  assert.equal(config(ctx.root, {}).DEV_SET, 'activity');
  assert.equal(readJson(path.join(ctx.local, 'lease.json')), null);
});

test('a manual port edit during build is not overwritten by initial bind recovery', async t => {
  const {ctx} = fixture(t);
  const base = await freeBase();
  const c = config(ctx.root, {DEV_PORT_START: String(base)});
  assert.equal(await allocate(ctx, c, null), base);
  updateEnv(ctx.root, {QUOTUM_PORT: String(base + 2)});
  await assert.rejects(allocate(ctx, c, null, base + 1), /configuration changed/);
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(base + 2));
  assert.deepEqual(readJson(path.join(ctx.local, 'lease.json')), {version: 1, port: base, initial: true});
});

test('another tree\'s stale recycled-PID journal cannot block allocation or authorize signals', async t => {
  const {ctx, base} = fixture(t);
  const stale = {version: 1, root: path.join(base, 'gone'), instance: '00000000-0000-4000-8000-000000000000',
    supervisor: {...processOf(process.pid), start: '0'}, port: await freeBase()};
  const record = path.join(ctx.shared, 'trees/stale.json');
  saveJson(record, stale);
  const port = await allocate(ctx, {...config(ctx.root, {}), DEV_PORT_START: String(stale.port)}, null);
  assert.equal(port, stale.port);
  await assert.rejects(stop({...ctx, root: stale.root, record, local: path.join(stale.root, '.quotum-dev')}), /another process/);
  assert.equal(processOf(process.pid).pid, process.pid);
});

test('ascending allocator retains stopped leases, excludes listeners, and reuses removed-tree holes', async t => {
  const {ctx, base} = fixture(t);
  const first = await freeBase();
  const occupied = await listener(first);
  t.after(occupied.close);
  const a = path.join(base, 'A');
  const b = path.join(base, 'B');
  git(ctx.root, 'worktree', 'add', '-b', 'a', a);
  git(ctx.root, 'worktree', 'add', '-b', 'b', b);
  const c = root => config(root, {DEV_PORT_START: String(first)});
  assert.equal(await allocate(context(a), c(a), null), first + 1);
  assert.equal(await allocate(context(b), c(b), null), first + 2);
  assert.equal(await allocate(context(a), config(a, {DEV_PORT_START: '50000'}), null), first + 1);
  git(ctx.root, 'worktree', 'remove', a);
  assert.equal(await allocate(ctx, c(ctx.root), null), first + 1);
});

test('concurrent tree preparation and two preparations of one tree do not collide', async t => {
  const {ctx, base} = fixture(t);
  const first = await freeBase();
  const a = path.join(base, 'A');
  const b = path.join(base, 'B');
  git(ctx.root, 'worktree', 'add', '-b', 'a', a);
  git(ctx.root, 'worktree', 'add', '-b', 'b', b);
  await Promise.all([subprocess(a, 'prepare', {DEV_PORT_START: String(first)}), subprocess(b, 'prepare', {DEV_PORT_START: String(first)})]);
  assert.deepEqual([parseEnv(readFileSync(path.join(a, '.env'), 'utf8')).QUOTUM_PORT, parseEnv(readFileSync(path.join(b, '.env'), 'utf8')).QUOTUM_PORT].map(Number).sort((a,b) => a-b), [first, first + 1]);
  const saved = config(a, {}).QUOTUM_PORT;
  await Promise.all([subprocess(a, 'prepare'), subprocess(a, 'prepare')]);
  assert.equal(config(a, {}).QUOTUM_PORT, saved);
});

test('foreign listener is neither adopted nor killed, even when it answers health', async t => {
  const {ctx} = fixture(t);
  standIn(ctx);
  const port = await freeBase();
  const other = await listener(port);
  t.after(other.close);
  await assert.rejects(start(ctx, {...config(ctx.root, {}), DEV_MODE: 'hub'}, port, {}), /foreign listener/);
  assert.equal(readJson(ctx.record), null);
  assert.equal(await portFree(port), false);
});

test('ready ownership, hub credential omission, dirty down and persistent-data fate', async t => {
  const {ctx, state} = await hubStand(t);
  assert.equal(await healthy(state), true);
  assert.equal((await info(ctx)).status, 'ready');
  assert.equal('syntheticFixtureDefaults' in await info(ctx), false);
  writeFileSync(path.join(ctx.root, '.hidden-work'), 'keep');
  git(ctx.root, 'config', 'status.showUntrackedFiles', 'no');
  assert.throws(() => dirtyGuard(ctx), /untracked work/);
  await assert.rejects(command('pre-remove', ctx.root), /before teardown/);
  assert.equal(await healthy(readJson(ctx.record)), true);
  await stop(ctx);
  assert.equal(existsSync(path.join(state.data, 'fixture-db')), true);
  assert.equal(readFileSync(path.join(ctx.root, '.hidden-work'), 'utf8'), 'keep');
  assert.equal((await info(ctx)).status, 'stopped');
  await stop(ctx, true);
  assert.equal(existsSync(state.data), false);
});

test('an unowned replacement data directory is preserved before any supervisor signal', async t => {
  const {ctx, state} = await hubStand(t);
  const marker = path.join(state.data, 'owner.json');
  const owned = readFileSync(marker, 'utf8');
  rmSync(marker);
  const sentinel = path.join(state.data, 'foreign-sentinel');
  writeFileSync(sentinel, 'keep');
  try {
    await assert.rejects(stop(ctx), /Unverified data directory/);
    assert.equal(await healthy(state), true);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally { writeFileSync(marker, owned); }
  await stop(ctx);
});

test('two simultaneous dev starts create one instance, and unchanged dev reuses it', async t => {
  const {ctx} = fixture(t);
  standIn(ctx);
  const c = {...config(ctx.root, {}), DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())};
  updateEnv(ctx.root, Object.fromEntries(Object.entries(c).filter(([, value]) => value !== undefined)));
  await allocate(ctx, config(ctx.root, {}), null);
  // A prepared, dependency-free stand-in build keeps this test offline.
  preparedBuild(ctx);
  await Promise.all([subprocess(ctx.root, 'dev'), subprocess(ctx.root, 'dev')]);
  const instance = readJson(ctx.record).instance;
  assert.equal(await healthy(readJson(ctx.record)), true);
  await subprocess(ctx.root, 'dev');
  assert.equal(readJson(ctx.record).instance, instance);
  const c2 = config(ctx.root, {});
  assert.equal(await allocate(ctx, c2, null), Number(c2.QUOTUM_PORT));
});

test('a stolen initial probe retries ascending, but an established busy port stays unchanged', async t => {
  const {ctx} = fixture(t);
  standIn(ctx);
  const c = {...config(ctx.root, {}), DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())};
  updateEnv(ctx.root, Object.fromEntries(Object.entries(c).filter(([, value]) => value !== undefined)));
  const first = await allocate(ctx, config(ctx.root, {}), null);
  preparedBuild(ctx);
  const stolen = await listener(first);
  t.after(stolen.close);
  await subprocess(ctx.root, 'dev');
  const saved = Number(config(ctx.root, {}).QUOTUM_PORT);
  assert.equal(saved, first + 1);
  assert.equal(await portFree(first), false);
  assert.equal(await healthy(readJson(ctx.record)), true);
  await stop(ctx);
  const occupied = await listener(saved);
  t.after(occupied.close);
  await assert.rejects(subprocess(ctx.root, 'dev'), /foreign listener/);
  assert.equal(Number(config(ctx.root, {}).QUOTUM_PORT), saved);
  assert.equal(await portFree(saved), false);
});

test('a bind race after the final probe keeps the foreign listener and reports PORT_BUSY', async t => {
  const {ctx} = fixture(t);
  standIn(ctx);
  const c = {...config(ctx.root, {}), DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())};
  const port = await allocate(ctx, c, null);
  writeFileSync(path.join(ctx.root, 'hub/dist/server/index.js'), `import {createServer} from 'node:http';
import {existsSync,writeFileSync} from 'node:fs';
writeFileSync(process.env.QUOTUM_DATA_DIR+'/before-bind','ready');
const wait=setInterval(()=>{
 if(!existsSync(process.env.QUOTUM_DATA_DIR+'/allow-bind')) return;
 clearInterval(wait);
 const server=createServer();
 server.on('error',()=>{console.log(JSON.stringify({event:'error',code:'port_in_use'}));process.exit(1)});
 server.listen(Number(process.env.QUOTUM_PORT),'127.0.0.1');
},10);
`);
  const starting = start(ctx, c, port, {inputs: 'bind-race', output: 'fixture'});
  const outcome = assert.rejects(starting, error => error.code === 'PORT_BUSY');
  for (let i = 0; i < 1000 && !existsSync(path.join(ctx.local, 'hub-data/before-bind')); i++) await sleep(10);
  assert.equal(existsSync(path.join(ctx.local, 'hub-data/before-bind')), true);
  const foreign = await listener(port);
  t.after(foreign.close);
  writeFileSync(path.join(ctx.local, 'hub-data/allow-bind'), 'bind');
  await outcome;
  assert.equal(await portFree(port), false);
  assert.equal(readJson(path.join(ctx.local, 'lease.json')).initial, true);
});

test('a configuration edit while the hub is seeding prevents ready and preserves the original lease', async t => {
  const {ctx} = fixture(t);
  standIn(ctx);
  const c = config(ctx.root, {DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())});
  const port = await allocate(ctx, c, null);
  writeFileSync(path.join(ctx.root, 'hub/dist/server/index.js'), `import {createServer} from 'node:http';
import {existsSync,writeFileSync} from 'node:fs';
writeFileSync(process.env.QUOTUM_DATA_DIR+'/before-bind','waiting');
const timer=setInterval(()=>{if(existsSync(process.env.QUOTUM_DATA_DIR+'/allow-bind')){clearInterval(timer);createServer((req,res)=>res.end('ok')).listen(Number(process.env.QUOTUM_PORT),'127.0.0.1');}},10);
`);
  const outcome = assert.rejects(start(ctx, c, port, {inputs: 'config-race', output: 'fixture'}), /could not start/);
  const data = path.join(ctx.local, 'hub-data');
  for (let i = 0; i < 1000 && !existsSync(path.join(data, 'before-bind')); i++) await sleep(10);
  assert.equal(existsSync(path.join(data, 'before-bind')), true);
  updateEnv(ctx.root, {QUOTUM_PORT: String(port + 1)});
  writeFileSync(path.join(data, 'allow-bind'), 'continue');
  await outcome;
  assert.equal(readJson(ctx.record).status, 'stopped');
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(port + 1));
  assert.deepEqual(readJson(path.join(ctx.local, 'lease.json')), {version: 1, port, initial: true});
  assert.equal(await portFree(port), true);
  assert.match(readFileSync(path.join(ctx.local, 'stand.log'), 'utf8'), /configuration changed/);
});

test('a successful build freezes served files; a later failed build leaves the ready stand usable', async t => {
  const {ctx, base} = fixture(t);
  standIn(ctx);
  writeFileSync(path.join(ctx.root, 'hub/package-lock.json'), '{}');
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const npm = path.join(bin, 'npm');
  writeFileSync(npm, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='ci') {fs.mkdirSync('node_modules/tsx/dist',{recursive:true}); fs.writeFileSync('node_modules/tsx/dist/loader.mjs','');}
if(process.argv[3]==='build' && fs.existsSync('fail-build')) process.exit(1);
`);
  chmodSync(npm, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    const built = await build(ctx);
    assert.notEqual(built.hub, path.join(ctx.root, 'hub'));
    const c = {...config(ctx.root, {}), DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())};
    const port = await allocate(ctx, c, null);
    const state = await start(ctx, c, port, built);
    const original = readFileSync(path.join(built.hub, 'dist/server/index.js'), 'utf8');
    writeFileSync(path.join(ctx.root, 'hub/dist/server/index.js'), 'throw new Error("broken build")');
    writeFileSync(path.join(ctx.root, 'hub/fail-build'), 'fail');
    await assert.rejects(build(ctx), /npm failed/);
    assert.equal(readFileSync(path.join(built.hub, 'dist/server/index.js'), 'utf8'), original);
    assert.equal(await healthy(state), true);
  } finally { process.env.PATH = priorPath; }
});

for (const previous of [false, true]) test(`a port edit during a successful build preserves current intent${previous ? ' and the earlier live stand' : ''}`, async t => {
  const {ctx, base} = fixture(t);
  standIn(ctx);
  const port = await freeBase();
  const c = config(ctx.root, {DEV_MODE: 'hub', DEV_PORT_START: String(port)});
  await allocate(ctx, c, null);
  const old = previous ? await start(ctx, c, port, {inputs: 'previous', output: 'fixture'}) : null;
  writeFileSync(path.join(ctx.root, 'hub/package-lock.json'), '{}');
  const gate = path.join(base, 'build-entered');
  const release = path.join(base, 'build-release');
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='ci'){fs.mkdirSync('node_modules/tsx/dist',{recursive:true});fs.writeFileSync('node_modules/tsx/dist/loader.mjs','');}
if(process.argv[3]==='build'){fs.writeFileSync(${JSON.stringify(gate)},'waiting');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}},10);}
`);
  chmodSync(path.join(bin, 'npm'), 0o755);
  const outcome = assert.rejects(subprocess(ctx.root, 'dev', {PATH: `${bin}:${process.env.PATH}`}), /configuration changed/);
  for (let i = 0; i < 1000 && !existsSync(gate); i++) await sleep(10);
  try {
    assert.equal(existsSync(gate), true);
    updateEnv(ctx.root, {QUOTUM_PORT: String(port + 1)});
  } finally { writeFileSync(release, 'continue'); }
  await outcome;
  assert.equal(config(ctx.root, {}).QUOTUM_PORT, String(port + 1));
  assert.equal(readJson(path.join(ctx.local, 'lease.json')).port, port);
  if (old) {
    assert.equal(readJson(ctx.record).instance, old.instance);
    assert.equal(await healthy(old), true);
  } else assert.equal(readJson(ctx.record), null);
});

test('demo source and supervisor are frozen before a post-build source edit', async t => {
  const {ctx, base} = fixture(t);
  standIn(ctx);
  writeFileSync(path.join(ctx.root, 'hub/package-lock.json'), '{}');
  const access = path.join(ctx.root, 'hub/demo/access.ts');
  writeFileSync(access, "export const PASSWORD='fixture-original';\n");
  mkdirSync(path.join(ctx.root, 'tooling/dev'), {recursive: true});
  const controller = path.join(ctx.root, 'tooling/dev/serve.mjs');
  writeFileSync(controller, "export const marker='frozen-supervisor';\n");
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env node
const fs=require('node:fs');
fs.mkdirSync('node_modules/tsx/dist',{recursive:true});fs.writeFileSync('node_modules/tsx/dist/loader.mjs','');
`);
  chmodSync(path.join(bin, 'npm'), 0o755);
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior}`;
  let built;
  try { built = await build(ctx); } finally { process.env.PATH = prior; }
  writeFileSync(access, "export const PASSWORD='changed-after-build';\n");
  writeFileSync(controller, "export const marker='changed-supervisor';\n");
  const source = await import(pathToFileURL(path.join(built.hub, 'demo/access.ts')).href);
  const supervisor = await import(pathToFileURL(built.controller).href);
  assert.equal(source.PASSWORD, 'fixture-original');
  assert.equal(supervisor.marker, 'frozen-supervisor');
  assert.notEqual(sourceBuild(ctx), built.inputs);
});

test('orphaned child group is recovered after supervisor death', async t => {
  const {ctx, state, port} = await hubStand(t);
  process.kill(state.supervisor.pid, 'SIGKILL');
  for (let i = 0; i < 50 && processOf(state.supervisor.pid); i++) await sleep(20);
  assert.equal(await portFree(port), false);
  await stop(ctx);
  assert.equal(await portFree(port), true);
});

test('caller death before supervisor registration cannot resurrect a completed down', async t => {
  const {ctx, base} = fixture(t);
  standIn(ctx);
  const port = await freeBase();
  const gate = path.join(base, 'supervisor-held');
  const release = path.join(base, 'supervisor-release');
  const controller = path.join(base, 'gated-serve.mjs');
  writeFileSync(controller, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync;
let held=false;
fs.readFileSync=(file,...args)=>{
 if(!held && file===\`/proc/\${process.pid}/stat\`){
  held=true;fs.writeFileSync(${JSON.stringify(gate)},String(process.pid));
  while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
 return read(file,...args);
};
syncBuiltinESMExports();
await import(${JSON.stringify(new URL('../serve.mjs', import.meta.url).href)});
`);
  const callerFile = path.join(base, 'caller.mjs');
  writeFileSync(callerFile, `import path from 'node:path';
import {context,locked} from ${JSON.stringify(new URL('../system.mjs', import.meta.url).href)};
import {config,allocate} from ${JSON.stringify(new URL('../config.mjs', import.meta.url).href)};
import {start} from ${JSON.stringify(new URL('../runtime.mjs', import.meta.url).href)};
const ctx=context(process.argv[2]);
await locked(path.join(ctx.shared,ctx.id+'.lock'),async()=>{
 const c=config(ctx.root,{DEV_MODE:'hub',DEV_PORT_START:process.argv[3]});
 const port=await allocate(ctx,c,null);
 await start(ctx,c,port,{inputs:'registration-fixture',output:'fixture',controller:process.argv[4]});
});

`);
  const caller = spawn(process.execPath, [callerFile, ctx.root, String(port), controller], {env: isolatedEnv(), stdio: 'ignore'});
  const exited = new Promise(resolve => caller.once('exit', (code, signal) => resolve({code, signal})));
  let supervisor;
  try {
    for (let i = 0; i < 1000 && !existsSync(gate); i++) await sleep(10);
    assert.equal(existsSync(gate), true);
    supervisor = processOf(Number(readFileSync(gate, 'utf8')));
    assert.ok(supervisor);
    const starting = readJson(ctx.record);
    assert.equal(starting.status, 'starting');
    assert.equal(starting.supervisor, undefined);
    caller.kill('SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
    await command('down', ctx.root);
    assert.equal(readJson(ctx.record).status, 'stopped');
    assert.equal(await portFree(port), true);
    writeFileSync(release, 'continue');
    for (let i = 0; i < 1000 && processOf(supervisor.pid); i++) await sleep(10);
    assert.equal(processOf(supervisor.pid), null);
    assert.equal(readJson(ctx.record).instance, starting.instance);
    assert.equal(readJson(ctx.record).status, 'stopped');
    assert.equal(await portFree(port), true);
    assert.equal(readJson(path.join(ctx.local, 'lease.json')).initial, true);
  } finally {
    writeFileSync(release, 'continue');
    if (caller.exitCode === null && caller.signalCode === null) { caller.kill('SIGKILL'); await exited; }
    if (supervisor && processOf(supervisor.pid)?.start === supervisor.start) {
      saveJson(ctx.record, {...readJson(ctx.record), supervisor});
      await stop(ctx);
    }
  }
});

test('caller death after durable registration but before authorization remains recoverable', async t => {
  const {ctx, base} = fixture(t);
  standIn(ctx);
  const port = await freeBase();
  const callerFile = path.join(base, 'registered-caller.mjs');
  writeFileSync(callerFile, `import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const {context,locked}=await import(${JSON.stringify(new URL('../system.mjs', import.meta.url).href)});
const ctx=context(process.argv[2]);
const rename=fs.renameSync;
fs.renameSync=(a,b)=>{rename(a,b);if(b===ctx.record && JSON.parse(fs.readFileSync(b,'utf8')).supervisor)process.kill(process.pid,'SIGKILL')};
syncBuiltinESMExports();
const {config,allocate}=await import(${JSON.stringify(new URL('../config.mjs', import.meta.url).href)});
const {start}=await import(${JSON.stringify(new URL('../runtime.mjs', import.meta.url).href)});
await locked(path.join(ctx.shared,ctx.id+'.lock'),async()=>{
 const c=config(ctx.root,{DEV_MODE:'hub',DEV_PORT_START:process.argv[3]});
 const port=await allocate(ctx,c,null);
 await start(ctx,c,port,{inputs:'registered-fixture',output:'fixture'});
});
`);
  const caller = spawn(process.execPath, [callerFile, ctx.root, String(port)], {env: isolatedEnv(), stdio: 'ignore'});
  const outcome = await new Promise(resolve => caller.once('exit', (code, signal) => resolve({code, signal})));
  assert.equal(outcome.signal, 'SIGKILL');
  const journal = readJson(ctx.record);
  assert.equal(journal.status, 'starting');
  assert.ok(journal.supervisor);
  await command('down', ctx.root);
  assert.equal(readJson(ctx.record).status, 'stopped');
  assert.equal(processOf(journal.supervisor.pid), null);
  assert.equal(await portFree(port), true);
  assert.equal(readJson(path.join(ctx.local, 'lease.json')).initial, true);
});

test('transient environ unreadability is retried without weakening ownership verification', async t => {
  const {ctx, state} = await hubStand(t);
  const starting = {...state, status: 'starting', hub: null};
  saveJson(ctx.record, starting);
  process.kill(state.supervisor.pid, 'SIGKILL');
  for (let i = 0; i < 50 && processOf(state.supervisor.pid); i++) await sleep(20);
  const original = fs.readFileSync;
  let attempts = 0;
  fs.readFileSync = (file, ...args) => {
    if (String(file) === `/proc/${state.hub.pid}/environ` && attempts++ < 3) throw Object.assign(new Error('process exiting'), {code: 'EACCES'});
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => ownedMembers(starting), error => error.code === 'OWNERSHIP_UNAVAILABLE');
    const members = await waitOwnedMembers(starting, Date.now() + 1000);
    assert.equal(members.some(member => member.pid === state.hub.pid), true);
    assert.ok(attempts >= 4);
    await stop(ctx);
    assert.equal(readJson(ctx.record).status, 'stopped');
    assert.equal(await portFree(state.port), true);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('a captured own leader exiting before a second observation completes cleanup', async t => {
  const {ctx, state} = await hubStand(t);
  const originalRead = fs.readFileSync;
  let exited = false;
  fs.readFileSync = (file, ...args) => {
    const value = originalRead(file, ...args);
    if (String(file) === `/proc/${state.supervisor.pid}/stat` && !exited) {
      exited = true;
      process.kill(-state.supervisor.pid, 'SIGKILL');
      const until = Date.now() + 1000;
      while (Date.now() < until) {
        try {
          const stat = originalRead(file, 'utf8');
          if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) break;
        } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    }
    return value;
  };
  syncBuiltinESMExports();
  try {
    await stop(ctx, true);
    assert.equal(exited, true);
    assert.equal(readJson(ctx.record), null);
    assert.equal(existsSync(state.data), false);
    assert.equal(await portFree(state.port), true);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
});

test('stop observes a transient kernel listener after its owned processes exit', async t => {
  const {ctx, state} = await hubStand(t);
  const prototype = Object.getPrototypeOf(createServer()), original = prototype.listen;
  let injected = false, probes = 0;
  prototype.listen = function (...args) {
    if (args[0]?.port === state.port && !processOf(state.supervisor.pid) && !processOf(state.hub.pid)) {
      probes++;
      if (!injected) {
        injected = true;
        process.nextTick(() => this.emit('error', Object.assign(new Error('Socket still closing'), {code: 'EADDRINUSE'})));
        return this;
      }
    }
    return original.apply(this, args);
  };
  try {
    await stop(ctx, true);
    assert.equal(injected, true);
    assert.ok(probes >= 2);
    assert.equal(readJson(ctx.record), null);
    assert.equal(await portFree(state.port), true);
  } finally { prototype.listen = original; }
});

test('ESRCH between verified ownership and signal is rechecked as an exit', async t => {
  const {ctx, state} = await hubStand(t);
  const originalKill = process.kill;
  let raced = false;
  process.kill = (target, kind) => {
    if (target === state.supervisor.pid && kind === 'SIGTERM' && !raced) {
      raced = true;
      originalKill(-state.supervisor.pid, 'SIGKILL');
      throw Object.assign(new Error('verified target exited'), {code: 'ESRCH'});
    }
    return originalKill(target, kind);
  };
  try {
    await stop(ctx, true);
    assert.equal(raced, true);
    assert.equal(readJson(ctx.record), null);
    assert.equal(existsSync(state.data), false);
    assert.equal(await portFree(state.port), true);
  } finally { process.kill = originalKill; }
});

test('PID reuse or an unknown state version cannot authorize a signal', async t => {
  const {ctx} = fixture(t);
  const self = processOf(process.pid);
  const state = {version: 1, root: ctx.root, instance: '00000000-0000-4000-8000-000000000000', supervisor: {...self, start: '0'}, port: 12345};
  saveJson(ctx.record, state);
  await assert.rejects(stop(ctx), /another process/);
  assert.deepEqual(processOf(process.pid), self);
  saveJson(ctx.record, {...state, version: 99});
  await assert.rejects(stop(ctx), /Unsupported/);
});

test('removal dirty guard ignores Git relocation and index overrides', async t => {
  const {ctx, base} = fixture(t);
  const other = path.join(base, 'other');
  git(ctx.root, 'worktree', 'add', '-b', 'other', other);
  writeFileSync(path.join(other, '.hidden-work'), 'keep');
  git(ctx.root, 'config', 'status.showUntrackedFiles', 'no');
  await assert.rejects(subprocess(other, 'pre-remove', {GIT_DIR: path.join(ctx.root, '.git'), GIT_WORK_TREE: ctx.root, GIT_INDEX_FILE: path.join(base, 'wrong-index')}), /before teardown/);
  assert.equal(existsSync(path.join(other, '.hidden-work')), true);
});

test('stable installed hooks safely dispatch legacy trees and retained managed state', async t => {
  const {ctx} = await hubStand(t);
  await command('install-dev', ctx.root);
  const hook = path.join(ctx.shared, 'hook.mjs');
  execFileSync(process.execPath, [hook, 'hook-prepare', ctx.root], {env: isolatedEnv()});
  // No branch-local script exists in the fixture; the installed copy still stops its journal.
  execFileSync(process.execPath, [hook, 'pre-remove', ctx.root], {env: isolatedEnv()});
  assert.equal(readJson(ctx.record), null);
  assert.equal((await info(ctx)).status, 'prepared');
});

function poolFixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-pool-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  let rows = [], posts = 0, lose = false;
  const pool = new Pool({file: path.join(dir, 'pool.json'), agent: 'agent', get: async () => rows, post: async body => {
    posts++; rows = [...rows, body]; if (lose) throw new Error('lost response'); return body;
  }});
  return {pool, get posts() {return posts;}, rows: value => rows = value, lose: () => lose = true};
}

function coderFixture(t) {
  const {ctx, base} = fixture(t);
  const c = {...config(ctx.root, {}), DEV_ACCESS: 'coder', PUBLIC_DOMAIN: 'example.com', CODER_WORKSPACE_ID: 'fixture-workspace',
    CODER_WORKSPACE_NAME: 'workspace', CODER_WORKSPACE_OWNER_NAME: 'owner', CODER_WORKSPACE_AGENT_NAME: 'agent'};
  const env = {CODER_URL: 'https://fixture.invalid', CODER_SESSION_TOKEN: 'synthetic-token', XDG_STATE_HOME: path.join(base, 'access-state')};
  const fetchBefore = globalThis.fetch;
  let shares = [], posts = 0, denied = true, noMetadata = false, lost = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return fetchBefore(url, options);
    assert.equal(options.headers['Coder-Session-Token'], env.CODER_SESSION_TOKEN);
    if (!String(url).endsWith('/port-share')) return noMetadata
      ? Response.json({message: 'denied'}, {status: 401})
      : Response.json({id: c.CODER_WORKSPACE_ID, name: c.CODER_WORKSPACE_NAME, owner_name: c.CODER_WORKSPACE_OWNER_NAME, latest_build: {resources: [{agents: [{name: 'agent'}]}]}});
    if (options.method === 'POST') {
      posts++;
      if (lost) throw new Error('response lost');
      if (denied) return Response.json({message: 'do not dump this provider detail'}, {status: 403});
      const row = {...JSON.parse(options.body), workspace_id: c.CODER_WORKSPACE_ID};
      shares = [row]; return Response.json(row);
    }
    return Response.json({shares});
  };
  t.after(() => { globalThis.fetch = fetchBefore; });
  return {ctx, c, env, get posts() { return posts; }, allow: () => denied = false, denyMetadata: () => noMetadata = true, lose: () => lost = true};
}

test('a definite API rejection permits retry and remains distinct from an unknown outcome', async t => {
  const f = coderFixture(t);
  const pool = await coderPool(f.c, f.env);
  const rejected = await pool.publish(8080);
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.detail, /HTTP 403/);
  assert.equal('8080' in pool.ledger().ports, false);
  assert.equal(JSON.stringify(rejected).includes('provider detail'), false);
  f.allow();
  assert.equal((await pool.publish(8080)).status, 'public');
  assert.equal(f.posts, 2);
  assert.equal((await pool.observe(8080)).status, 'public');
});

test('info retains a sanitized rejection while observing absent publication', async t => {
  const f = coderFixture(t);
  standIn(f.ctx);
  preparedBuild(f.ctx);
  const before = process.env;
  const exitBefore = process.exitCode;
  process.env = {...isolatedEnv(), ...f.env, ...f.c, DEV_MODE: 'hub', DEV_PORT_START: String(await freeBase())};
  try {
    const first = await command('dev', f.ctx.root, true);
    assert.equal(first.access.status, 'rejected');
    assert.equal(first.access.observed, 'absent');
    assert.match(first.access.detail, /HTTP 403/);
    assert.equal(JSON.stringify(first).includes('synthetic-token'), false);
    f.allow();
    const second = await command('dev', f.ctx.root, true);
    assert.equal(second.access.status, 'public');
    assert.equal(second.instance, first.instance);
    assert.equal(f.posts, 2);
  } finally {
    await stop(f.ctx, true);
    process.env = before; process.exitCode = exitBefore;
  }
});

test('unknown lost-response intent remains visible even when GET observes no row', async t => {
  const f = coderFixture(t);
  f.lose();
  const pool = await coderPool(f.c, f.env);
  assert.equal((await pool.publish(8080)).status, 'unconfirmed');
  const observed = await pool.observe(8080);
  assert.equal(observed.status, 'unconfirmed');
  assert.equal(observed.observed, 'absent');
  assert.match(observed.evidence, /unknown/);
  assert.equal((await pool.publish(8080)).status, 'unconfirmed');
  assert.equal(f.posts, 1);
});

test('configured access without its policy authority makes no new claim or backend', async t => {
  const f = coderFixture(t);
  f.denyMetadata();
  const before = process.env;
  process.env = {...isolatedEnv(), ...f.env, ...f.c};
  try {
    await assert.rejects(command('dev', f.ctx.root), /policy cannot be verified/);
    assert.equal(existsSync(path.join(f.ctx.root, '.env')), false);
    assert.equal(readJson(f.ctx.record), null);
    assert.equal(f.posts, 0);
  } finally { process.env = before; }
});
test('publication occurs once when needed, concurrent/repeated reuse sends no POST', async t => {
  const f = poolFixture(t);
  assert.equal(await f.pool.eligible(8080), true);
  assert.equal(f.posts, 0);
  const results = await Promise.all([f.pool.publish(8080), f.pool.publish(8080)]);
  assert.equal(results.every(r => r.status === 'public'), true);
  assert.equal(f.posts, 1);
  assert.equal((await f.pool.observe(8080)).status, 'public');
  assert.equal(f.posts, 1);
});
test('repeated worktree churn reuses the lowest published number instead of growing the pool', async t => {
  const {ctx, base} = fixture(t);
  const f = poolFixture(t);
  const first = await freeBase();
  for (let i = 0; i < 4; i++) {
    const tree = path.join(base, `cycle-${i}`);
    git(ctx.root, 'worktree', 'add', '-b', `cycle-${i}`, tree);
    const port = await allocate(context(tree), config(tree, {DEV_PORT_START: String(first)}), f.pool);
    assert.equal(port, first);
    assert.equal((await f.pool.publish(port)).status, 'public');
    git(ctx.root, 'worktree', 'remove', tree);
  }
  assert.equal(f.posts, 1);
  assert.deepEqual(Object.keys(f.pool.ledger().ports), [String(first)]);
});
test('lost publication response is observed and reused read-only without destructive authority', async t => {
  const f = poolFixture(t); f.lose();
  assert.equal((await f.pool.publish(8080)).status, 'unconfirmed');
  assert.equal(await f.pool.eligible(8080), true);
  assert.equal((await f.pool.publish(8080)).status, 'public');
  assert.match((await f.pool.observe(8080)).evidence, /unconfirmed/);
  assert.equal(f.pool.ledger().ports[8080].phase, 'intent');
  assert.equal(f.posts, 1);
});
test('unknown and different external policies remain untouched; failed GET never creates access', async t => {
  const f = poolFixture(t);
  f.rows([{agent_name: 'agent', port: 8080, protocol: 'http', share_level: 'public'}]);
  assert.equal(await f.pool.eligible(8080), false);
  assert.equal((await f.pool.publish(8080)).status, 'conflict');
  f.rows([]); await f.pool.publish(8080);
  f.rows([{agent_name: 'agent', port: 8080, protocol: 'https', share_level: 'owner'}]);
  assert.equal((await f.pool.publish(8080)).status, 'conflict');
  assert.equal(f.posts, 1);
  f.pool.get = async () => { throw new Error('outage'); };
  await assert.rejects(f.pool.publish(8081), /outage/);
  assert.equal(f.posts, 1);
});
test('component environment omits preview address, data, access and local-mode secrets', () => {
  const clean = isolatedEnv({PATH: '/bin', GIT_SSH_COMMAND: 'ssh', QUOTUM_PORT: '12345', QUOTUM_DATA_DIR: '/preview', QUOTUM_LOCAL_KEY: 'secret', QUOTUM_LOCAL_TOKEN: 'secret', CODER_SESSION_TOKEN: 'secret', QUOTUM_PUBLIC_URL: 'https://preview.example.com', DEV_ACCESS: 'coder', PUBLIC_DOMAIN: 'example.com', NODE_OPTIONS: '--inspect'});
  assert.deepEqual(clean, {PATH: '/bin', GIT_SSH_COMMAND: 'ssh'});
  assert.equal(externalUrl({DEV_ACCESS: 'coder', PUBLIC_DOMAIN: 'example.com', CODER_WORKSPACE_AGENT_NAME: 'agent', CODER_WORKSPACE_NAME: 'workspace', CODER_WORKSPACE_OWNER_NAME: 'owner'}, 8080), 'https://8080--agent--workspace--owner.example.com');
});
