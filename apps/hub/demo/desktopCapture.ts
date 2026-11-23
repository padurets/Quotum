/** Serve the desktop screenshot fixture through the production hub's local entry point. */
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {newSecret} from '../server/domain/auth.js';
import {Agent} from './client.js';
import {addressOf, Demo, DEMO_SECRET_KEY, prepare} from './index.js';
import {machineInfo, machines, sessionsAt} from './model.js';
import {SHOWCASE_DESKTOP as set} from './showcaseData.js';

const port = process.env.QUOTUM_PORT;
// This disposable stand only listens on loopback and uses its own database and secrets.
for (const key of Object.keys(process.env)) if (key.startsWith('QUOTUM_')) delete process.env[key];
const address = addressOf({QUOTUM_PORT: port});
await prepare(address);
const dataDir = mkdtempSync(path.join(tmpdir(), 'quotum-desktop-capture-'));
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.once(signal, () => stop.abort());
const demo = new Demo({
  set,
  scene: set.scene,
  still: true,
  dataDir,
  address,
  onExit: () => stop.abort(new Error('The demo hub stopped during seeding')),
});
try {
  const stand = await demo.run(stop.signal);
  await demo.stop();
  stop.signal.throwIfAborted();

  const key = newSecret('qt_s');
  const token = newSecret('qt_m');
  const hub = spawn(process.execPath, ['dist/server/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      QUOTUM_PORT: String(address.port),
      QUOTUM_DATA_DIR: dataDir,
      QUOTUM_LOCAL_KEY: key,
      QUOTUM_LOCAL_TOKEN: token,
      QUOTUM_SECRET_KEY: DEMO_SECRET_KEY,
      QUOTUM_RESETS: 'off',
    },
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    hub.once('close', resolve);
    hub.once('error', reject);
  });
  const closeInput = () => hub.stdin.end();
  stop.signal.addEventListener('abort', closeInput, {once: true});
  try {
    // The same readiness event and stdin lifetime as the packaged desktop controller.
    let started = false;
    for await (const line of createInterface({input: hub.stdout})) {
      const event = JSON.parse(line) as {event: string; local?: boolean};
      if (event.event !== 'start' || !event.local) continue;
      started = true;
      const [machine] = machines(set);
      const sessions = sessionsAt(set, machine, stand.start, 0);
      const response = await fetch(address.base + '/v1/sessions', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
        body: JSON.stringify({
          version: 1,
          agent: Agent.VERSION,
          machine: machineInfo(machine),
          sentAt: new Date().toISOString(),
          sessions,
        }),
      });
      if (!response.ok || (await response.json()).accepted !== sessions.length)
        throw new Error('The local hub did not accept the demo sessions');
      console.log(address.base + '/local?key=' + key);
      break;
    }
    const code = await closed;
    if (!stop.signal.aborted && (code !== 0 || !started))
      throw new Error('The local hub stopped before completing the capture');
  } finally {
    closeInput();
    await closed;
  }
} catch (error) {
  if (!stop.signal.aborted || stop.signal.reason?.name !== 'AbortError') throw error;
} finally {
  await demo.stop();
  rmSync(dataDir, {recursive: true, force: true, maxRetries: 5});
}
