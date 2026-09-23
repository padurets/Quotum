#!/usr/bin/env node
/**
 * Lets the release workflow publish every npm package of Quotum (npm's trusted
 * publishing): the registry then accepts `npm publish` without a token from the job of
 * .github/workflows/release.yml that runs in the `npm` environment of this repository.
 * The account's owner can still publish by hand with two-factor authentication; to
 * forbid even that, set each package's publishing access to "Require two-factor
 * authentication and disallow tokens" on npmjs.com. npm only trusts a
 * package that exists, so a new package is published once by hand first
 * (`node npm/build.mjs && node npm/publish.mjs`). Run once per package:
 *
 *   node npm/trust.mjs --otp=123456                   every package
 *   node npm/trust.mjs --otp=123456 @quotum/win32-x64  only these (after a code expired)
 *
 * Options such as `--otp` go to every `npm trust`. The registry wants to be told what a
 * trust allows (publishing), which only npm 12 and newer can say: the script runs that
 * npm's `trust` whatever npm is installed.
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

const args = process.argv.slice(2);
const options = args.filter(arg => arg.startsWith('-'));
const chosen = args.filter(arg => !arg.startsWith('-'));
const all = [...PLATFORMS.map(p => `@quotum/${p.name}`), 'quotum'];
const unknown = chosen.filter(name => !all.includes(name));
if (unknown.length) throw new Error(`not a package of Quotum: ${unknown.join(', ')}`);

// `npm trust` of npm 12, which says what the trust allows (`--allow-publish`).
const npm = ['exec', '--yes', '--package=npm@12', '--', 'npm'];
const failed = [];
for (const name of chosen.length ? chosen : all) {
  console.log(`trusting ${repository} release.yml to publish ${name}`);
  try {
    const trust = ['trust', 'github', name, '--file', 'release.yml', '--repository', repository, '--environment', 'npm', '--allow-publish', '--yes'];
    execFileSync('npm', [...npm, ...trust, ...options], {stdio: 'inherit'});
  } catch {
    failed.push(name);
  }
}
if (failed.length) {
  console.error(`not trusted yet: ${failed.join(' ')}\nwith a fresh code: node npm/trust.mjs --otp=<code> ${failed.join(' ')}`);
  process.exitCode = 1;
}
