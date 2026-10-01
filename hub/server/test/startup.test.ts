import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const entry = process.env.QUOTUM_TEST_HUB_ENTRY ?? fileURLToPath(new URL('../../dist/server/index.js', import.meta.url));

for (const [name, invalid, missingModules] of [
  ['public URL', {QUOTUM_PUBLIC_URL: 'invalid-startup-fixture'}, false],
  ['local mode', {QUOTUM_LOCAL_KEY: 'too-short'}, false],
  ['module loading', {}, true],
] as const) {
  test(`early ${name} failure keeps keys out of diagnostic reports`, {skip: missingModules && !!process.env.QUOTUM_TEST_HUB_ENTRY}, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'quotum-startup-report-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const current = Buffer.alloc(32, 7).toString('base64url');
    const previous = Buffer.alloc(32, 8).toString('base64url');
    let target = entry;
    if (missingModules) {
      // A broken modular deployment must be private before its imports can be linked.
      target = path.join(root, 'entry.mjs');
      copyFileSync(entry, target);
    }
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('QUOTUM_') && key.toUpperCase() !== 'NODE_OPTIONS'));
    const result = spawnSync(process.execPath, ['--report-uncaught-exception', '--report-directory', root, target], {
      env: {...inherited, QUOTUM_DATA_DIR: path.join(root, 'data'), QUOTUM_RESETS: 'off', QUOTUM_SECRET_KEY: current, QUOTUM_SECRET_KEY_PREVIOUS: previous, ...invalid},
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const reports = readdirSync(root).filter(file => file.startsWith('report.') && file.endsWith('.json'));
    assert.equal(reports.length, 1, 'the fixture must reach an actual early diagnostic report');
    const reportFile = path.join(root, reports[0]);
    const text = readFileSync(reportFile, 'utf8');
    assert.equal(Object.hasOwn(JSON.parse(text), 'environmentVariables'), false);
    for (const secret of [current, previous]) {
      assert.equal(text.includes(secret), false);
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
    }
    if (process.platform !== 'win32') assert.equal(statSync(reportFile).mode & 0o777, 0o600);
  });
}
