#!/usr/bin/env node
/**
 * Publishes what `node npm/build.mjs` put into npm/dist: the platform packages first,
 * then `quotum`, which depends on them. Versions already on the registry are skipped,
 * so an interrupted run can simply be repeated. The release workflow runs it with no
 * token (npm trusts the workflow, see trust.mjs); by hand, extra arguments go to every
 * `npm publish` (for example `--dry-run`, or `--otp=123456` with two-factor auth).
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
if (!existsSync(path.join(dist, 'quotum'))) throw new Error('nothing to publish: run `node npm/build.mjs` first');

const published = (name, version) => {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim() === version;
  } catch {
    return false;
  }
};

// Every package is a directory; the notices next to them are not one.
const platforms = readdirSync(dist, {withFileTypes: true}).filter(entry => entry.isDirectory() && entry.name !== 'quotum');
for (const dir of [...platforms.map(entry => entry.name).sort(), 'quotum']) {
  const {name, version} = JSON.parse(readFileSync(path.join(dist, dir, 'package.json'), 'utf8'));
  if (published(name, version)) {
    console.log(`${name}@${version} is already published`);
    continue;
  }
  console.log(`publishing ${name}@${version}`);
  execFileSync('npm', ['publish', '--access', 'public', ...process.argv.slice(2)], {cwd: path.join(dist, dir), stdio: 'inherit'});
}
