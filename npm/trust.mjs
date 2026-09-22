#!/usr/bin/env node
/**
 * Lets the release workflow publish every npm package of Quotum (npm's trusted
 * publishing): the registry then accepts `npm publish` from .github/workflows/release.yml
 * of this repository and from nowhere else, without any token. npm only trusts a
 * package that exists, so a new package is published once by hand first
 * (`node npm/build.mjs && node npm/publish.mjs`). Run once per package; extra arguments
 * go to every `npm trust` (for example `--otp=123456` with two-factor auth).
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLATFORMS} from './platforms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = JSON.parse(readFileSync(path.join(here, 'quotum/package.json'), 'utf8'));
const repository = /github\.com\/([^/]+\/[^/.]+)/.exec(main.repository.url)?.[1];
if (!repository) throw new Error(`no GitHub repository in npm/quotum/package.json: ${main.repository.url}`);

for (const name of [...PLATFORMS.map(p => `@quotum/${p.name}`), 'quotum']) {
  console.log(`trusting ${repository} release.yml to publish ${name}`);
  execFileSync('npm', ['trust', 'github', name, '--file', 'release.yml', '--repository', repository, '--yes', ...process.argv.slice(2)], {stdio: 'inherit'});
}
