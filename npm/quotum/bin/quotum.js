#!/usr/bin/env node
// Runs the quotum agent built for this platform. npm installs that binary from the
// matching optional dependency (@quotum/<platform>-<arch>); nothing is downloaded here.
'use strict';
const {spawnSync} = require('node:child_process');

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
const target = `${process.platform}-${process.arch}`;

function fail(message) {
  console.error(`quotum: ${message}`);
  process.exit(1);
}

let binary;
try {
  binary = require.resolve(`@quotum/${target}/bin/quotum${process.platform === 'win32' ? '.exe' : ''}`);
} catch {
  fail(
    SUPPORTED.includes(target)
      ? `the binary for ${target} is not installed; reinstall without --omit=optional (or --no-optional).`
      : `there is no prebuilt binary for ${target} yet (${SUPPORTED.join(', ')}); build it from source: https://github.com/padurets/quotum`,
  );
}

const result = spawnSync(binary, process.argv.slice(2), {stdio: 'inherit'});
if (result.error) fail(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
