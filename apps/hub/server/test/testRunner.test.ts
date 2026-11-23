import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const evalBuildTestArgs = (argv: readonly string[], env: Record<string, string>) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import {pathToFileURL} from "node:url"; const {buildTestArgs} = await import(pathToFileURL(process.argv[2]).href); process.stdout.write(JSON.stringify(buildTestArgs(JSON.parse(process.argv[3]), JSON.parse(process.argv[4]))));',
        'test-harness',
        runner,
        JSON.stringify(argv),
        JSON.stringify(env),
      ],
      {encoding: 'utf8'},
    ),
  ) as string[];

test('test runner applies DEVKIT_TEST_WORKERS and preserves default globs for flag-only runs', () => {
  const base = evalBuildTestArgs([], {DEVKIT_TEST_WORKERS: '4'});
  assert.ok(base.includes('--test-concurrency=4'));
  assert.ok(base.includes('server/test/*.test.ts'));
  assert.ok(base.includes('bench/test/*.test.ts'));

  const filtered = evalBuildTestArgs(['--', '--test-name-pattern', 'foo'], {
    DEVKIT_TEST_WORKERS: '3',
  });
  assert.ok(filtered.includes('--test-concurrency=3'));
  assert.ok(filtered.includes('--test-name-pattern'));
  assert.ok(filtered.includes('foo'));
  assert.ok(filtered.includes('server/test/*.test.ts'));
  assert.ok(!filtered.includes('--'));

  const targeted = evalBuildTestArgs(['--test-concurrency=2', 'server/test/api.test.ts'], {
    DEVKIT_TEST_WORKERS: '4',
  });
  assert.ok(!targeted.includes('--test-concurrency=4'));
  assert.ok(targeted.includes('--test-concurrency=2'));
  assert.ok(targeted.includes('server/test/api.test.ts'));
  assert.ok(!targeted.includes('bench/test/*.test.ts'));

  const invalid = evalBuildTestArgs([], {DEVKIT_TEST_WORKERS: '0'});
  assert.ok(!invalid.some(arg => arg.startsWith('--test-concurrency=')));

  const customReporterEq = evalBuildTestArgs(['--test-reporter=spec', 'server/test/api.test.ts'], {
    DEVKIT_TEST_WORKERS: '4',
  });
  assert.ok(!customReporterEq.includes('--test-reporter=@docouno/env/node-test-reporter'));
  assert.ok(customReporterEq.includes('--test-reporter=spec'));
  assert.ok(!customReporterEq.includes('bench/test/*.test.ts'));

  const customReporterSpace = evalBuildTestArgs(['--test-reporter', 'spec'], {});
  assert.ok(!customReporterSpace.includes('--test-reporter=@docouno/env/node-test-reporter'));
  const reporterIdx = customReporterSpace.indexOf('--test-reporter');
  assert.deepEqual(customReporterSpace.slice(reporterIdx, reporterIdx + 2), [
    '--test-reporter',
    'spec',
  ]);
  assert.ok(customReporterSpace.includes('server/test/*.test.ts'));

  const isolation = evalBuildTestArgs(
    ['--test-isolation', 'none', '--test-name-pattern', 'foo'],
    {},
  );
  const isolationIdx = isolation.indexOf('--test-isolation');
  assert.deepEqual(isolation.slice(isolationIdx, isolationIdx + 4), [
    '--test-isolation',
    'none',
    '--test-name-pattern',
    'foo',
  ]);
  assert.ok(isolation.includes('server/test/*.test.ts'));

  const dashTarget = evalBuildTestArgs(['--test-only', '--', '-foo.test.ts'], {});
  assert.deepEqual(dashTarget.slice(-3), ['--test-only', '--', '-foo.test.ts']);
  assert.ok(!dashTarget.includes('server/test/*.test.ts'));
});
