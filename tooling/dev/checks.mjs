import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {context, locked} from './system.mjs';
import {isolatedEnv, run} from './runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ctx = context(root);
const action = process.argv[2];
const jobs = process.env.SLOT_CPUS || '4';
if (!/^\d+$/.test(jobs) || Number(jobs) < 1 || Number(jobs) > 1024) throw new Error('Invalid SLOT_CPUS.');
const env = isolatedEnv();
const docker = async (desktop, script) => {
  const image = (desktop ? process.env.DEV_DESKTOP_IMAGE : process.env.DEV_RUST_IMAGE) || (desktop ? 'quotum-dev-desktop' : 'quotum-rust');
  try { execFileSync('docker', ['image', 'inspect', image], {stdio: 'ignore'}); }
  catch { await run('docker', ['build', '-t', image, '-f', path.join(root, 'tooling/dev', `${desktop ? 'Desktop' : 'Rust'}.Dockerfile`), path.join(root, 'tooling/dev')], root, env); }
  let newVolume = false;
  try { execFileSync('docker', ['volume', 'inspect', 'quotum-cargo'], {stdio: 'ignore'}); }
  catch { await run('docker', ['volume', 'create', 'quotum-cargo'], root, env); newVolume = true; }
  const user = `${process.getuid()}:${process.getgid()}`;
  if (newVolume) await run('docker', ['run', '--rm', '-v', 'quotum-cargo:/cargo', image, 'chown', user, '/cargo'], root, env);
  const npmCache = process.env.npm_config_cache || path.join(os.homedir(), '.npm');
  const buildCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  mkdirSync(npmCache, {recursive: true});
  mkdirSync(buildCache, {recursive: true});
  await run('docker', ['run', '--rm', '--user', user, '-e', 'CARGO_HOME=/cargo', '-e', `CARGO_BUILD_JOBS=${jobs}`,
    '-e', 'npm_config_cache=/npm', '-v', `${npmCache}:/npm`,
    '-e', 'XDG_CACHE_HOME=/build-cache', '-v', `${buildCache}:/build-cache`,
    '-v', 'quotum-cargo:/cargo', '-v', `${root}:/work`, '-w', desktop ? '/work' : '/work/agent', image, 'sh', '-c', script], root, env);
};

await locked(path.join(ctx.shared, 'heavy.lock'), async () => {
  if (action === 'check-hub') {
    for (const args of [['ci'], ['run', 'typecheck'], ['test'], ['run', 'build']]) await run('npm', args, path.join(root, 'hub'), env);
  } else if (action === 'check-agent') {
    await docker(false, 'cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked');
  } else if (action === 'check-desktop') {
    await docker(true, 'node desktop/prepare.mjs && cd desktop && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked');
  } else if (action === 'bench') {
    const benchEnv = {...env};
    if (process.env.QUOTUM_CHROME) benchEnv.QUOTUM_CHROME = process.env.QUOTUM_CHROME;
    for (const key of ['QUOTUM_BENCH_DIAGNOSTICS_DIR', 'QUOTUM_BENCH_DIAGNOSE_NATIVE', 'QUOTUM_BENCH_DIAGNOSE_PANNING']) {
      if (process.env[key]) benchEnv[key] = process.env[key];
    }
    const args = ['run', 'bench', '--', '--ci', ...(process.env.BENCH_CDP ? ['--cdp', process.env.BENCH_CDP] : [])];
    await run('npm', args, path.join(root, 'hub'), benchEnv);
  } else throw new Error(`Unknown check: ${action}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
