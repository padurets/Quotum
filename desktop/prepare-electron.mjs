/** Pinned Linux engine and AppImage runtime; no install scripts or global tools. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

export const ELECTRON_VERSION = '44.4.5';
const ELECTRON = {
  file: `electron-v${ELECTRON_VERSION}-linux-x64.zip`,
  // electron's published npm checksums.json (also in its GitHub release).
  sha256: '04586a0ec46c3283fbdaef85530f561f71f0b5e136ad0cb9ef63683615609780',
};
const RUNTIME = {
  file: 'runtime-x86_64-20251108',
  sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
};
const cacheRoot = () => process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
async function download(file, digest, url) {
  const cache = path.join(cacheRoot(), 'quotum-build');
  mkdirSync(cache, {recursive: true});
  const target = path.join(cache, file);
  if (existsSync(target) && sha(target) === digest) return target;
  // Reuse a standard Electron cache only after checking the same pinned digest.
  const electronCache = path.join(cacheRoot(), 'electron');
  if (existsSync(electronCache)) {
    for (const directory of readdirSync(electronCache, {withFileTypes: true}).filter(e => e.isDirectory())) {
      const candidate = path.join(electronCache, directory.name, file);
      if (existsSync(candidate) && sha(candidate) === digest) { copyFileSync(candidate, target); return target; }
    }
  }
  console.log(`downloading ${url}`);
  const response = await fetch(url, {signal: AbortSignal.timeout(120_000)});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`${file}: SHA-256 mismatch`);
  writeFileSync(`${target}.new`, bytes);
  const {renameSync} = await import('node:fs');
  renameSync(`${target}.new`, target);
  return target;
}
export async function prepareElectron(resources) {
  const archive = await download(ELECTRON.file, ELECTRON.sha256, `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ELECTRON.file}`);
  const output = path.join(resources, 'electron');
  rmSync(output, {recursive: true, force: true});
  mkdirSync(output, {recursive: true});
  execFileSync('unzip', ['-q', archive, '-d', output], {stdio: 'inherit'});
  // Keep Electron's LICENSE and Chromium's LICENSES.chromium.html beside the engine.
  writeFileSync(path.join(output, 'quotum-engine.json'), JSON.stringify({version: ELECTRON_VERSION, archiveSha256: ELECTRON.sha256}) + '\n');
}
export async function appImageRuntime() {
  return download(RUNTIME.file, RUNTIME.sha256, 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64');
}
