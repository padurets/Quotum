import {spawn} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {listenerOwned, processOf, readJson, saveJson, sleep} from './system.mjs';

const [root, record, instance] = process.argv.slice(2);
let state = readJson(record);
if (state?.root !== root || state.instance !== instance || state.status !== 'starting') throw new Error('Invalid start journal.');
state.supervisor = processOf(process.pid);
saveJson(record, state);
let demo, hub, stopping = false;
const tell = message => { if (process.connected) process.send(message); };
const write = updates => {
  if (readJson(record)?.instance !== instance) throw new Error('Instance journal changed.');
  state = {...state, ...updates};
  saveJson(record, state);
};
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (demo) await demo.stop();
  if (hub && hub.exitCode === null && hub.signalCode === null) {
    const exited = new Promise(resolve => hub.once('exit', resolve));
    hub.kill('SIGTERM');
    const timeout = setTimeout(() => hub.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timeout);
  }
  write({status: 'stopped'});
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop(0));
try {
  if (state.mode === 'demo') {
    // tsx's ESM registration API handles the existing demo's TypeScript entrypoint.
    const {register: registerTsx} = await import(pathToFileURL(path.join(root, 'hub/node_modules/tsx/dist/esm/api/index.mjs')).href);
    registerTsx();
    const {Demo, addressOf, parseArgs, prepare} = await import(pathToFileURL(path.join(root, 'hub/demo/index.ts')).href);
    const {accessOf} = await import(pathToFileURL(path.join(root, 'hub/demo/access.ts')).href);
    const args = [state.config.DEV_SET, ...(state.config.DEV_STILL === 'true' ? ['--still'] : []), ...(state.config.DEV_RESETS ? ['--resets', state.config.DEV_RESETS] : [])];
    const options = parseArgs(args);
    const address = addressOf(process.env);
    await prepare(address, state.build.hub);
    demo = new Demo({...options, address, dataDir: state.data, hubRoot: state.build.hub, onExit: code => void stop(code)});
    const stand = await demo.run();
    if (stopping) process.exit(0);
    if (demo.dir !== state.data) throw new Error('This demo does not support managed data; cleanup blocked.');
    write({hub: processOf(demo.pid), demo: {set: stand.set.id, scene: options.scene, still: options.still, ...accessOf(stand.set)}});
  } else {
    hub = spawn(process.execPath, ['dist/server/index.js'], {cwd: state.build.hub ?? path.join(root, 'hub'), env: {...process.env, QUOTUM_DATA_DIR: state.data}, stdio: ['ignore', 'inherit', 'inherit']});
    hub.on('exit', code => { if (!stopping) void stop(code ?? 1); });
    write({hub: processOf(hub.pid)});
    const until = Date.now() + 15000;
    let ready = false;
    while (Date.now() < until && !stopping) {
      if (listenerOwned(hub.pid, state.port)) {
        try { ready = (await fetch(`http://127.0.0.1:${state.port}/health`, {signal: AbortSignal.timeout(1000)})).ok; } catch {}
        if (ready) break;
      }
      await sleep(100);
    }
    if (!ready) throw new Error('Hub did not get ready.');
  }
  if (!listenerOwned(state.hub.pid, state.port)) throw new Error('Ready hub does not own the selected listener.');
  write({status: 'ready'});
  saveJson(path.join(root, '.quotum-dev', 'lease.json'), {version: 1, port: state.port, initial: false});
  tell({event: 'ready'});
  console.log(`Managed ${state.mode} ready; instance ${instance}, build ${state.build.inputs}.`);
} catch (error) {
  console.error(error.message);
  tell({event: 'failed', code: /taken|EADDRINUSE|port_in_use/.test(error.message) ? 'PORT_BUSY' : 'START_FAILED'});
  await stop(1);
}
