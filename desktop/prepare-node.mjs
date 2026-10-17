/** Reuse only checksum-verified Node archives; every extraction owns its temporary files. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function saveArchive(cache, name, bytes) {
  mkdirSync(cache, {recursive: true});
  const work = mkdtempSync(path.join(cache, 'quotum-node-'));
  try {
    const archive = path.join(work, name);
    writeFileSync(archive, bytes);
    renameSync(archive, path.join(cache, name));
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}

export async function prepareNode(here, target, node, version) {
  const binaries = path.join(here, 'binaries');
  const binary = path.join(binaries, `quotum-node-${target}${target.includes('windows') ? '.exe' : ''}`);
  const license = path.join(binaries, `node-LICENSE-${version}`);
  const stamp = path.join(binaries, `quotum-node-${target}.sha256`);
  if (existsSync(binary) && existsSync(license) && existsSync(stamp)
    && readFileSync(stamp, 'utf8') === `${node.sha256} ${sha256(readFileSync(binary))}`) return license;

  mkdirSync(binaries, {recursive: true});
  const work = mkdtempSync(path.join(tmpdir(), 'quotum-node-'));
  try {
    const cache = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'quotum-build/node');
    const cached = path.join(cache, node.archive);
    let bytes;
    try {bytes = readFileSync(cached);}
    catch (error) {if (error.code !== 'ENOENT') console.warn(`could not read cached ${node.archive}`);}
    if (bytes && sha256(bytes) !== node.sha256) {
      console.warn(`discarding cached ${node.archive}: SHA-256 mismatch`);
      try {rmSync(cached);}
      catch {console.warn(`could not remove cached ${node.archive}`);}
      bytes = undefined;
    }
    const downloaded = bytes === undefined;
    if (downloaded) {
      const url = `https://nodejs.org/dist/${version}/${node.archive}`;
      console.log(`downloading ${url}`);
      const response = await fetch(url, {signal: AbortSignal.timeout(120_000)});
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== node.sha256) throw new Error(`${node.archive}: SHA-256 ${actual}, expected ${node.sha256}`);
    }

    const archive = path.join(work, node.archive);
    writeFileSync(archive, bytes);
    // tar reads .tar.xz everywhere, and .zip on Windows (bsdtar); elsewhere unzip does.
    if (node.archive.endsWith('.zip') && process.platform !== 'win32') {
      execFileSync('unzip', ['-q', archive, '-d', work], {cwd: work, stdio: 'inherit'});
    } else {
      execFileSync('tar', ['-xf', archive, '-C', work], {cwd: work, stdio: 'inherit'});
    }
    const unpacked = path.join(work, node.archive.replace(/\.(tar\.xz|zip)$/, ''));
    copyFileSync(path.join(unpacked, node.binary), binary);
    chmodSync(binary, 0o755);
    copyFileSync(path.join(unpacked, 'LICENSE'), license);
    if (downloaded) {
      try {saveArchive(cache, node.archive, bytes);}
      catch {console.warn(`could not cache ${node.archive}`);}
    }
    writeFileSync(stamp, `${node.sha256} ${sha256(readFileSync(binary))}`);
    return license;
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}
