#!/usr/bin/env node
/** Package the Rust controller and Chromium without linking a second web engine. */
import {execFileSync} from 'node:child_process';
import {appendFileSync, chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {appImageRuntime} from './prepare-electron.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const target = 'x86_64-unknown-linux-gnu';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 packaging requires a Linux x64 host');
const version = JSON.parse(readFileSync(path.join(here, '../hub/package.json'))).version;
const cargo = readFileSync(path.join(here, 'Cargo.toml'), 'utf8');
if (!cargo.includes(`version = "${version}"`)) throw new Error('desktop and hub versions differ');
const run = (file, argv, cwd = here) => execFileSync(file, argv, {cwd, stdio: 'inherit'});
const debug = args.includes('--debug');
const output = path.resolve(process.env.CARGO_TARGET_DIR || path.join(here, 'target'), target, debug ? 'debug' : 'release');
if (!args.includes('--no-build')) run('cargo', ['build', '--locked', '--target', target, ...(debug ? [] : ['--release'])]);
const bundle = path.join(output, 'bundle');
const appdir = path.join(bundle, 'Quotum.AppDir');
rmSync(appdir, {recursive: true, force: true});
const bin = path.join(appdir, 'usr/bin');
const share = path.join(appdir, 'usr/share/quotum');
mkdirSync(bin, {recursive: true});
mkdirSync(share, {recursive: true});
copyFileSync(path.join(output, 'quotum-desktop'), path.join(bin, 'quotum-desktop'));
copyFileSync(path.join(here, `binaries/quotum-node-${target}`), path.join(bin, 'quotum-node'));
for (const name of ['quotum-desktop', 'quotum-node']) chmodSync(path.join(bin, name), 0o755);
for (const name of ['hub', 'licenses', 'electron']) cpSync(path.join(here, 'resources', name), path.join(share, name), {recursive: true});
mkdirSync(path.join(share, 'gui'), {recursive: true});
for (const name of ['main.cjs', 'preload.cjs', 'policy.cjs']) copyFileSync(path.join(here, 'electron', name), path.join(share, 'gui', name));
cpSync(path.join(here, 'static'), path.join(share, 'gui/static'), {recursive: true});
copyFileSync(path.join(here, 'icons/128x128.png'), path.join(share, 'icon.png'));
// Never setuid in an AppImage: it uses Chromium's user-namespace sandbox.
chmodSync(path.join(share, 'electron/chrome-sandbox'), 0o755);
const desktop = '[Desktop Entry]\nType=Application\nName=Quotum\nComment=How much of your coding-agent subscriptions is left\nExec=quotum-desktop\nIcon=quotum\nTerminal=false\nCategories=Development;\nStartupWMClass=Quotum\n';
mkdirSync(path.join(appdir, 'usr/share/applications'), {recursive: true});
writeFileSync(path.join(appdir, 'usr/share/applications/quotum.desktop'), desktop);
const iconDir = path.join(appdir, 'usr/share/icons/hicolor/128x128/apps');
mkdirSync(iconDir, {recursive: true});
copyFileSync(path.join(share, 'icon.png'), path.join(iconDir, 'quotum.png'));
writeFileSync(path.join(appdir, 'AppRun'), '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/usr/bin/quotum-desktop" "$@"\n');
chmodSync(path.join(appdir, 'AppRun'), 0o755);
symlinkSync('usr/share/applications/quotum.desktop', path.join(appdir, 'quotum.desktop'));
symlinkSync('usr/share/quotum/icon.png', path.join(appdir, 'quotum.png'));
symlinkSync('quotum.png', path.join(appdir, '.DirIcon'));
console.log(`prepared ${appdir}`);
if (args.includes('--dir-only')) process.exit(0);

// A native package installs the sandbox helper with root ownership and setuid. On
// systems without unprivileged user namespaces Chromium can use this sandbox instead.
const stage = path.join(bundle, 'native');
rmSync(stage, {recursive: true, force: true});
mkdirSync(stage, {recursive: true});
cpSync(path.join(appdir, 'usr'), path.join(stage, 'usr'), {recursive: true});
chmodSync(path.join(stage, 'usr/share/quotum/electron/chrome-sandbox'), 0o4755);
const deb = path.join(bundle, 'deb');
mkdirSync(deb, {recursive: true});
mkdirSync(path.join(stage, 'DEBIAN'));
writeFileSync(path.join(stage, 'DEBIAN/control'), `Package: quotum\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Sergey Padurets\nSection: devel\nPriority: optional\nHomepage: https://github.com/padurets/Quotum\nDepends: libc6 (>= 2.35), libnss3, libnspr4, libatk1.0-0, libatk-bridge2.0-0, libcups2, libdrm2, libdbus-1-3, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libxkbcommon0, libasound2, libgtk-3-0\nDescription: Coding-agent subscription limits on this machine\n Quotum measures through the clients and shows their limits on its board.\n`);
run('dpkg-deb', ['--root-owner-group', '--threads-max=2', '-Zzstd', '-z6', '--build', stage, path.join(deb, `Quotum_${version}_amd64.deb`)]);
rmSync(path.join(stage, 'DEBIAN'), {recursive: true});
const rpm = path.join(bundle, 'rpm');
mkdirSync(rpm, {recursive: true});
const spec = path.join(bundle, 'quotum.spec');
function rpmFiles(directory, relative = '') {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) return [`%dir "${file}"`, ...rpmFiles(path.join(directory, entry.name), file)];
    const mode = file.endsWith('/electron/chrome-sandbox') ? '%attr(4755,root,root) ' : '';
    return [`${mode}"${file}"`];
  });
}
const ownedFiles = rpmFiles(path.join(stage, 'usr/share/quotum'), '/usr/share/quotum').join('\n');
writeFileSync(spec, `Name: quotum\nVersion: ${version}\nRelease: 1\nSummary: Coding-agent subscription limits on this machine\nLicense: MIT\nURL: https://github.com/padurets/Quotum\nBuildArch: x86_64\nRequires: nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, dbus-libs, libX11, libxcb, libXcomposite, libXdamage, libXext, libXfixes, libXrandr, mesa-libgbm, libxkbcommon, alsa-lib, gtk3\nAutoReqProv: no\n%description\nQuotum measures through the clients and shows their limits on its board.\n%files\n%defattr(-,root,root,-)\n/usr/bin/quotum-desktop\n/usr/bin/quotum-node\n/usr/share/applications/quotum.desktop\n/usr/share/icons/hicolor/128x128/apps/quotum.png\n%dir /usr/share/quotum\n${ownedFiles}\n`);
const rpmDb = path.join(bundle, 'rpm-db');
mkdirSync(rpmDb, {recursive: true});
run('rpm', ['--dbpath', rpmDb, '--initdb']);
run('rpmbuild', ['-bb', '--buildroot', stage, '--define', `_topdir ${path.join(bundle, 'rpm-build')}`, '--define', `_dbpath ${rpmDb}`, '--define', `_rpmdir ${rpm}`, '--define', '_build_id_links none', '--define', '_binary_payload w3T2.zstdio', '--define', '__os_install_post %{nil}', spec]);
for (const name of readdirSync(path.join(rpm, 'x86_64'))) {
  if (name.endsWith('.rpm')) copyFileSync(path.join(rpm, 'x86_64', name), path.join(rpm, name));
}
const images = path.join(bundle, 'appimage');
mkdirSync(images, {recursive: true});
const squash = path.join(bundle, 'quotum.squashfs');
rmSync(squash, {force: true});
run('mksquashfs', [appdir, squash, '-root-owned', '-no-xattrs', '-noappend', '-comp', 'zstd', '-processors', '2', '-mem', '256M']);
const image = path.join(images, `Quotum_${version}_amd64.AppImage`);
copyFileSync(await appImageRuntime(), image);
appendFileSync(image, readFileSync(squash));
chmodSync(image, 0o755);
rmSync(squash);
console.log(`packaged ${image}`);
