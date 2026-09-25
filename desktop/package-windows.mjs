// The same Windows build as the installer, in a folder that runs after extraction.
import {copyFileSync, cpSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

if (process.platform !== 'win32') throw new Error('Package the Windows build on Windows');
const here = path.dirname(fileURLToPath(import.meta.url));
const target = 'x86_64-pc-windows-msvc';
const output = path.resolve(process.env.CARGO_TARGET_DIR || path.join(here, 'target'), target, 'release');
const bundle = path.join(output, 'bundle/portable');
const stage = path.join(bundle, 'Quotum');
const {version} = JSON.parse(readFileSync(path.join(here, '../hub/package.json'), 'utf8'));
const archive = path.join(bundle, `Quotum_${version}_x64-portable.zip`);
rmSync(stage, {recursive: true, force: true});
mkdirSync(stage, {recursive: true});
copyFileSync(path.join(output, 'quotum-desktop.exe'), path.join(stage, 'quotum-desktop.exe'));
copyFileSync(path.join(here, `binaries/quotum-node-${target}.exe`), path.join(stage, 'quotum-node.exe'));
for (const name of ['hub', 'licenses']) cpSync(path.join(here, 'resources', name), path.join(stage, name), {recursive: true});
rmSync(archive, {force: true});
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Compress-Archive -LiteralPath $env:QUOTUM_PORTABLE_STAGE -DestinationPath $env:QUOTUM_PORTABLE_ZIP -CompressionLevel Optimal'], {
  env: {...process.env, QUOTUM_PORTABLE_STAGE: stage, QUOTUM_PORTABLE_ZIP: archive}, stdio: 'inherit',
});
console.log(`packaged ${archive}`);
