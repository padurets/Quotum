#!/usr/bin/env node
/**
 * Puts together what the desktop app carries but git does not hold, for one target:
 *
 *   resources/hub/              the hub of this commit as one file, with its dashboard
 *   binaries/quotum-node-<target>   Node, downloaded and checked against a pinned SHA-256
 *   resources/licenses/         the licenses of Quotum, Node and the Rust crates the app links
 *   icons/                      the app's icons, drawn from the dashboard's favicon
 *
 * The app's build needs all of them, and so do its checks: tauri-build reads them while
 * compiling. Run it before `cargo clippy`, `cargo test` and a build; it needs cargo for
 * the licenses.
 *
 *   node desktop/prepare.mjs                     for this machine
 *   node desktop/prepare.mjs --target <triple>   x86_64-unknown-linux-gnu or x86_64-pc-windows-msvc
 *   node desktop/prepare.mjs --no-build          keep a hub already built in hub/dist
 *
 * Node is called quotum-node in the app: a deb puts it in /usr/bin, where `node` belongs
 * to the nodejs package.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {thirdPartyLicenses} from '../npm/licenses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hub = path.resolve(here, '../hub');

const NODE_VERSION = 'v24.21.0';
/** From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt; the archive holds node and its LICENSE. */
const NODE = {
  'x86_64-unknown-linux-gnu': {
    archive: `node-${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    binary: 'bin/node',
  },
  'x86_64-pc-windows-msvc': {
    archive: `node-${NODE_VERSION}-win-x64.zip`,
    sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    binary: 'node.exe',
  },
};

const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const target = option('--target') ?? hostTarget();
const node = NODE[target];
if (!node) throw new Error(`the app is built for ${Object.keys(NODE).join(' and ')}, not ${target}`);
const windows = target.includes('windows');

const run = (command, commandArgs, cwd) =>
  // npm is a .cmd on Windows, which only a shell starts.
  execFileSync(command, commandArgs, {cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm'});

// 1. The hub: built, then bundled into one file that runs without node_modules.
if (!args.includes('--no-build') || !existsSync(path.join(hub, 'dist/app/server.mjs'))) {
  run('npm', ['ci'], hub);
  run('npm', ['run', 'build'], hub);
  run('npm', ['run', 'bundle'], hub);
}
const resources = path.join(here, 'resources/hub');
rmSync(resources, {recursive: true, force: true});
mkdirSync(path.join(resources, 'dist/app'), {recursive: true});
copyFileSync(path.join(hub, 'package.json'), path.join(resources, 'package.json'));
for (const file of ['server.mjs', 'server-licenses.md']) copyFileSync(path.join(hub, 'dist/app', file), path.join(resources, 'dist/app', file));
cpSync(path.join(hub, 'dist/client'), path.join(resources, 'dist/client'), {recursive: true});

// 2. Node, once per version and target: a binary already in place is checked, not fetched again.
const binaries = path.join(here, 'binaries');
const binary = path.join(binaries, `quotum-node-${target}${windows ? '.exe' : ''}`);
const license = path.join(binaries, `node-LICENSE-${NODE_VERSION}`);
const stamp = path.join(binaries, `quotum-node-${target}.sha256`);
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (!existsSync(binary) || !existsSync(license) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== `${node.sha256} ${sha256(binary)}`) {
  mkdirSync(binaries, {recursive: true});
  const work = mkdtempSync(path.join(tmpdir(), 'quotum-node-'));
  const archive = path.join(work, node.archive);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${node.archive}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(archive);
  if (actual !== node.sha256) throw new Error(`${node.archive}: SHA-256 ${actual}, expected ${node.sha256}`);
  // tar reads .tar.xz everywhere, and .zip on Windows (bsdtar); elsewhere unzip does.
  if (node.archive.endsWith('.zip') && process.platform !== 'win32') run('unzip', ['-q', archive, '-d', work], work);
  else run('tar', ['-xf', archive, '-C', work], work);
  const unpacked = path.join(work, node.archive.replace(/\.(tar\.xz|zip)$/, ''));
  copyFileSync(path.join(unpacked, node.binary), binary);
  chmodSync(binary, 0o755);
  copyFileSync(path.join(unpacked, 'LICENSE'), license);
  writeFileSync(stamp, `${node.sha256} ${sha256(binary)}`);
  rmSync(work, {recursive: true, force: true});
}

// 3. Licenses: Quotum's, Node's, and those of the Rust crates the app links on this target.
const licenses = path.join(here, 'resources/licenses');
rmSync(licenses, {recursive: true, force: true});
mkdirSync(licenses, {recursive: true});
copyFileSync(path.resolve(here, '../LICENSE'), path.join(licenses, 'LICENSE'));
copyFileSync(license, path.join(licenses, 'node-LICENSE'));
writeFileSync(
  path.join(licenses, 'THIRD_PARTY_LICENSES.md'),
  thirdPartyLicenses(here, 'quotum-desktop', [target], [
    'The Quotum app is MIT-licensed (LICENSE next to this file). Its program includes the',
    'Rust crates below, each under its own license, and the Rust standard library (MIT OR',
    'Apache-2.0, https://github.com/rust-lang/rust). The app also carries Node.js',
    '(node-LICENSE next to this file) and the Quotum hub: the packages bundled into its',
    'server are listed with their licenses in hub/dist/app/server-licenses.md, those of',
    'its dashboard in hub/dist/client/third-party-licenses.md.',
  ]),
);

// 4. Icons, from the favicon (square, 32×32).
const icons = path.join(here, 'icons');
if (!existsSync(path.join(icons, 'icon.png'))) {
  execFileSync('npx', ['--yes', '@tauri-apps/cli@2.11.5', 'icon', path.join(hub, 'public/favicon.svg'), '-o', icons], {
    cwd: here,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

console.log(`prepared the desktop app for ${target}`);

function hostTarget() {
  const key = `${process.platform}-${process.arch}`;
  const targets = {'linux-x64': 'x86_64-unknown-linux-gnu', 'win32-x64': 'x86_64-pc-windows-msvc'};
  if (!targets[key]) throw new Error(`no desktop app for ${key}; pass --target`);
  return targets[key];
}
