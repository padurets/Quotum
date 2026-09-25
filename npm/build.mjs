#!/usr/bin/env node
/**
 * Builds the npm packages of the agent into npm/dist/:
 *
 *   quotum                 the `quotum` command: a launcher that runs the binary below
 *   @quotum/<os>-<cpu>     one package per platform with the prebuilt binary; `quotum`
 *                          lists them as optional dependencies and npm installs only the
 *                          one matching `os` and `cpu`
 *
 * Binaries are cross-compiled with cargo-zigbuild, so one Linux machine builds them all:
 * it needs `cargo install cargo-zigbuild`, zig on PATH and the Rust targets below
 * (`rustup target add …`). Linux builds are static (musl) and run on any distribution.
 *
 *   node npm/build.mjs            build every platform
 *   node npm/build.mjs linux-x64  build some of them (the others are left out of `quotum`)
 *
 * The version is the agent's (agent/Cargo.toml). A release tag builds and publishes them
 * from CI (.github/workflows/release.yml); `node npm/publish.mjs` is what it runs.
 */
import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLATFORMS} from './platforms.mjs';
import {thirdPartyLicenses} from './licenses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const agent = path.join(root, 'agent');
const dist = path.join(here, 'dist');

const version = /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/.exec(readFileSync(path.join(agent, 'Cargo.toml'), 'utf8'))?.[1];
if (!version) throw new Error('no version in agent/Cargo.toml');

const launcher = readFileSync(path.join(here, 'quotum/bin/quotum.js'), 'utf8');
const listed = JSON.parse(/const SUPPORTED = (\[[^\]]*\])/.exec(launcher)?.[1].replaceAll("'", '"') ?? '[]');
if (listed.join() !== PLATFORMS.map(p => p.name).join()) throw new Error('npm/quotum/bin/quotum.js: SUPPORTED differs from PLATFORMS');

const wanted = process.argv.slice(2);
const platforms = wanted.length ? PLATFORMS.filter(p => wanted.includes(p.name)) : PLATFORMS;
if (platforms.length !== (wanted.length || PLATFORMS.length)) throw new Error(`unknown platform in: ${wanted.join(', ')}`);

const main = JSON.parse(readFileSync(path.join(here, 'quotum/package.json'), 'utf8'));
const shared = {license: main.license, author: main.author, homepage: main.homepage, bugs: main.bugs};
const write = (file, value) => writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

rmSync(dist, {recursive: true, force: true});
mkdirSync(dist, {recursive: true});
// The same notices for every platform: the crates any of the builds links.
const notices = path.join(dist, 'THIRD_PARTY_LICENSES.md');
write(
  notices,
  thirdPartyLicenses(agent, 'quotum', PLATFORMS.map(p => p.target), [
    'The Quotum agent is MIT-licensed (see LICENSE). Its binaries include the Rust crates',
    'below, each under its own license. They also include the Rust standard library (MIT',
    'OR Apache-2.0, https://github.com/rust-lang/rust); the Linux builds link musl libc',
    'statically (MIT, https://musl.libc.org/COPYRIGHT) and the Windows build the MinGW-w64',
    'runtime (https://github.com/mingw-w64/mingw-w64/blob/master/COPYING).',
  ]),
);

for (const p of platforms) {
  console.log(`building ${p.name} (${p.target})`);
  execFileSync('cargo', ['zigbuild', '--release', '--locked', '--target', p.target, '-p', 'quotum'], {cwd: agent, stdio: 'inherit'});
  const dir = path.join(dist, `quotum-${p.name}`);
  mkdirSync(path.join(dir, 'bin'), {recursive: true});
  const binary = path.join(dir, 'bin', `quotum${p.exe ?? ''}`);
  copyFileSync(path.join(agent, 'target', p.target, 'release', `quotum${p.exe ?? ''}`), binary);
  chmodSync(binary, 0o755);
  copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
  copyFileSync(notices, path.join(dir, 'THIRD_PARTY_LICENSES.md'));
  write(path.join(dir, 'README.md'), `# @quotum/${p.name}\n\nThe [Quotum](${main.homepage}) agent built for ${p.title}. Install \`quotum\` instead: it picks this package when it matches your platform.\n`);
  write(path.join(dir, 'package.json'), {
    name: `@quotum/${p.name}`,
    version,
    description: `The Quotum agent for ${p.title}; installed by \`quotum\`.`,
    ...shared,
    repository: {...main.repository, directory: 'agent'},
    os: [p.os],
    cpu: [p.cpu],
    files: ['bin', 'THIRD_PARTY_LICENSES.md'],
    preferUnplugged: true,
  });
}

const dir = path.join(dist, 'quotum');
cpSync(path.join(here, 'quotum'), dir, {recursive: true});
copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
write(path.join(dir, 'package.json'), {
  ...main,
  version,
  optionalDependencies: Object.fromEntries(platforms.map(p => [`@quotum/${p.name}`, version])),
});
console.log(`npm/dist: quotum ${version} with ${platforms.map(p => p.name).join(', ')}`);
