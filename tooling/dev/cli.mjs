#!/usr/bin/env node
import {cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coderPool, externalUrl} from './access.mjs';
import {allocate, config, envText, parseEnv, validateState} from './config.mjs';
import {build, desired, fileHash, healthy, sourceBuild, start, stop} from './runtime.mjs';
import {atomic, context, git, hash, locked, ownedMembers, readJson, saveJson} from './system.mjs';

export function dirtyGuard(ctx) {
  if (git(ctx.root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')) throw new Error('Worktree has uncommitted or untracked work; removal stopped before teardown.');
}

async function accessFor(c) {
  try { return {pool: await coderPool(c)}; }
  catch (error) { return {pool: null, problem: error.message}; }
}
export async function info(ctx) {
  const state = readJson(ctx.record);
  validateState(ctx, state);
  const ready = state && await healthy(state);
  const c = state?.config ?? config(ctx.root);
  const port = state?.port ?? (parseEnv(envText(ctx.root)).QUOTUM_PORT || null);
  let access = {status: 'local'};
  if (ready && c.DEV_ACCESS === 'coder') {
    const {pool, problem} = await accessFor(c);
    try {
      access = pool ? await pool.observe(Number(port)) : {status: 'unavailable', detail: problem};
      if (access.status === 'absent' && state.access?.status === 'rejected') access = {...state.access, observed: 'absent'};
    }
    catch (error) { access = {status: 'unavailable', detail: error.message}; }
  } else if (state) access = state.access;
  let quota = null, memory = null;
  try { const [limit, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' '); quota = limit === 'max' ? null : Number(limit) / Number(period); } catch {}
  try { const value = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(); memory = value === 'max' ? null : Number(value); } catch {}
  return {tree: ctx.root, branch: git(ctx.root, 'branch', '--show-current'), status: ready ? 'ready' : state?.status === 'ready' ? 'stale' : state?.status ?? 'prepared',
    instance: state?.instance ?? null, build: state?.build ?? null, mode: state?.mode ?? c.DEV_MODE, port: Number(port) || null,
    localUrl: port ? `http://127.0.0.1:${port}` : null,
    externalUrl: ready && (access.status === 'public' || c.DEV_ACCESS === 'none') ? externalUrl(c, port) : null,
    access, logs: state?.log ?? path.join(ctx.local, 'stand.log'), data: state?.data ?? null,
    budget: {slotCPUs: Number(c.SLOT_CPUS), machineCPUs: quota, memoryBytes: memory, heavyChecks: 'serialized per repository'},
    ...(ready && state.mode === 'demo' && state.demo ? {syntheticFixtureDefaults: state.demo} : {})};
}
function printInfo(data) {
  console.log(`Tree: ${data.tree}\nBranch: ${data.branch}\nStatus: ${data.status}\nInstance: ${data.instance ?? '-'}\nBuild: ${data.build?.inputs ?? '-'}\nCommit at build: ${data.build?.commit ?? '-'}\nMode: ${data.mode}\nPort: ${data.port ?? '-'}\nLocal: ${data.localUrl ?? '-'}\nExternal: ${data.externalUrl ?? '-'}\nAccess: ${data.access?.status ?? '-'}${data.access?.evidence ? ` (${data.access.evidence})` : ''}${data.access?.detail ? ` (${data.access.detail})` : ''}\nLogs: ${data.logs}\nData: ${data.data ?? '-'}\nBudget: slot ${data.budget.slotCPUs} CPU; machine ${data.budget.machineCPUs ?? 'unlimited'} CPU, ${data.budget.memoryBytes ? data.budget.memoryBytes / 1024 ** 3 + ' GiB' : 'unlimited memory'}; ${data.budget.heavyChecks}`);
  if (data.syntheticFixtureDefaults) {
    const fixture = data.syntheticFixtureDefaults;
    console.log(`Synthetic demo fixture defaults (${fixture.set}, resets ${fixture.scene}, still ${fixture.still}):\nPassword: ${fixture.password}\n${fixture.accounts.map(a => `${a.email}  ${a.name}`).join('\n')}`);
  }
}

export async function command(action, root, json = false) {
  const ctx = context(realpathSync(root));
  if (process.platform !== 'linux') throw new Error('Managed development stands currently require Linux, Node 24 and flock.');
  if (action === 'info') {
    const result = await info(ctx);
    if (json) console.log(JSON.stringify(result)); else printInfo(result);
    return result;
  }
  if (action === 'logs') {
    const state = readJson(ctx.record);
    validateState(ctx, state);
    const log = state?.log ?? path.join(ctx.local, 'stand.log');
    if (log !== path.join(ctx.local, 'stand.log')) throw new Error('Unrecognized managed log path.');
    if (existsSync(log)) console.log(readFileSync(log, 'utf8').split('\n').slice(-200).join('\n'));
    else console.log('No stand log yet.');
    return;
  }
  if (action === 'install-dev') return install(ctx);
  return locked(path.join(ctx.shared, `${ctx.id}.lock`), async () => {
    if (action === 'pre-remove') {
      dirtyGuard(ctx);
      await stop(ctx, true);
      console.log('Owned local teardown complete. Public pool entries were retained.');
      return;
    }
    if (action === 'down') { await stop(ctx); console.log('Stand down; its port remains reserved while this tree exists.'); return; }
    if (action === 'hook-prepare' && !existsSync(path.join(ctx.root, 'tooling/dev/cli.mjs'))) {
      const state = readJson(ctx.record);
      validateState(ctx, state);
      console.log(state ? 'Managed state retained; shared tooling can still stop it.' : 'Legacy tree has no managed tooling; preparation skipped.');
      return;
    }
    if (!['prepare', 'hook-prepare', 'dev'].includes(action)) throw new Error(`Unknown command: ${action}`);
    const c = config(ctx.root);
    // Fail malformed scenarios before dependency installation, port assignment or stopping a stand.
    if (c.DEV_MODE === 'demo') {
      const catalogue = readFileSync(path.join(ctx.root, 'hub/demo/catalogue.ts'), 'utf8');
      if (!['all', 'showcase', 'activity'].includes(c.DEV_SET)) throw new Error('Invalid DEV_SET; use all, showcase or activity.');
      if (c.DEV_RESETS && !new RegExp(`kind: 'scene',\\s*id: ['"]${c.DEV_RESETS.replace(/[^a-z0-9-]/gi, '!')}['"]`).test(catalogue)) throw new Error('Invalid DEV_RESETS; see hub/demo/catalogue.ts.');
    }
    const {pool, problem} = await accessFor(c);
    if (problem) console.log(`External access unavailable: ${problem}`);
    let port = await allocate(ctx, c, pool);
    if (action !== 'dev') { console.log(`Prepared ${ctx.root}; reserved port ${port}. No stand started.`); return; }
    let state = readJson(ctx.record);
    validateState(ctx, state);
    const inputs = sourceBuild(ctx);
    const priorBuild = readJson(path.join(ctx.local, 'build.json'));
    const reusable = state && state.build.inputs === inputs && priorBuild?.inputs === inputs && state.build.output === fileHash(path.join(state.build.hub ?? path.join(ctx.root, 'hub'), 'dist')) && JSON.stringify(state.config) === JSON.stringify(desired(c, port)) && await healthy(state);
    if (reusable) console.log(`Reusing ready instance ${state.instance}.`);
    else {
      if (state && ownedMembers(state).length) console.log('Source, configuration or readiness changed; rebuilding/restarting the owned stand.');
      // Build first: a failed build leaves the previous live stand available.
      const built = await build(ctx);
      await stop(ctx);
      for (let attempt = 0; ; attempt++) {
        try { state = await start(ctx, c, port, built); break; }
        catch (error) {
          const lease = readJson(path.join(ctx.local, 'lease.json'));
          if (error.code !== 'PORT_BUSY' || !lease?.initial || lease.port !== port || attempt >= 7) throw error;
          console.log(`Initial port ${port} was taken after probing; trying the next eligible number.`);
          port = await allocate(ctx, c, pool, port + 1);
        }
      }
    }
    let access = {status: 'local'};
    if (c.DEV_ACCESS === 'coder') {
      try { access = pool ? await pool.publish(port) : {status: 'unavailable', detail: problem}; }
      catch (error) { access = {status: 'unavailable', detail: error.message}; }
    }
    state = readJson(ctx.record);
    saveJson(ctx.record, {...state, access});
    const result = await info(ctx);
    if (json) console.log(JSON.stringify(result)); else printInfo(result);
    if (c.DEV_ACCESS === 'coder' && result.access.status !== 'public') process.exitCode = 1;
    return result;
  });
}

/** Keep a versioned runner outside checkouts so old branches cannot bypass owned teardown. */
function install(ctx) {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const digest = hash(readdirSync(source).filter(f => f.endsWith('.mjs')).sort().map(f => readFileSync(path.join(source, f))).join('\n'));
  const dest = path.join(ctx.shared, 'tooling', digest);
  if (!existsSync(dest)) { mkdirSync(dest, {recursive: true, mode: 0o700}); cpSync(source, dest, {recursive: true}); }
  const dispatch = `import {readFileSync} from 'node:fs';\nimport {pathToFileURL} from 'node:url';\nconst runner = JSON.parse(readFileSync(new URL('./runner.json', import.meta.url), 'utf8')).runner;\nconst {command} = await import(pathToFileURL(runner));\nawait command(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });\n`;
  atomic(path.join(ctx.shared, 'hook.mjs'), dispatch);
  saveJson(path.join(ctx.shared, 'runner.json'), {runner: path.join(dest, 'cli.mjs')});
  console.log(`Installed shared hook runner: ${path.join(ctx.shared, 'hook.mjs')}\nPass hook-prepare or pre-remove followed by the explicit target root. Configure these as blocking Worktrunk user hooks; see CONTRIBUTING.md.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  command(process.argv[2] ?? 'info', process.argv[3] && process.argv[3] !== '--json' ? process.argv[3] : process.cwd(), process.argv.includes('--json')).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
