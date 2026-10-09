import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isolatedEnv} from '../runtime.mjs';

test('the real benchmark wrapper forwards only named harness settings and writes the canary artifact', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quotum-checks-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const scripts = path.join(root, 'tooling/dev'); mkdirSync(scripts, {recursive: true});
  for (const name of readdirSync(source).filter(name => name.endsWith('.mjs'))) copyFileSync(path.join(source, name), path.join(scripts, name));
  mkdirSync(path.join(root, 'hub')); mkdirSync(path.join(root, 'bin'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const dir = path.join(root, 'evidence'); mkdirSync(dir);
  writeFileSync(path.join(root, '.env'), 'QUOTUM_PORT=12345\nDEV_MODE=hub\n');
  const executable = path.join(root, 'bin/npm');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(path.join(process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR,'canary.json'), JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(QUOTUM_|DEV_)/.test(key)))));
`, {mode: 0o755});
  execFileSync(process.execPath, [path.join(scripts, 'checks.mjs'), 'bench'], {cwd: root, timeout: 10_000,
    env: {...isolatedEnv(), PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
      QUOTUM_BENCH_DIAGNOSTICS_DIR: dir, QUOTUM_BENCH_DIAGNOSE_NATIVE: '1', QUOTUM_CHROME: 'fixture-chrome',
      QUOTUM_PUBLIC_URL: 'private-canary', QUOTUM_PORT: '12345', QUOTUM_DATA_DIR: 'private-canary', QUOTUM_LOCAL_KEY: 'private-canary', QUOTUM_SECRET_KEY_FILE: 'private-canary', DEV_MODE: 'hub', DEV_ACCESS: 'coder'},
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'canary.json'), 'utf8')), {
    QUOTUM_CHROME: 'fixture-chrome', QUOTUM_BENCH_DIAGNOSTICS_DIR: dir, QUOTUM_BENCH_DIAGNOSE_NATIVE: '1',
  });
});
