import {spawnSync} from 'node:child_process';
import {constants as osConstants} from 'node:os';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const DEFAULT_GLOBS = [
  'server/test/*.test.ts',
  'ui/test/*.test.ts',
  'demo/test/*.test.ts',
  'bench/test/*.test.ts',
];

const VALUE_FLAGS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
  '--test-rerun-failures',
  '--test-isolation',
  '--experimental-test-isolation',
  '--test-global-setup',
  '--test-coverage-include',
  '--test-coverage-exclude',
  '--test-coverage-lines',
  '--test-coverage-branches',
  '--test-coverage-functions',
  '-C',
  '--conditions',
  '--import',
  '--loader',
  '-r',
  '--require',
]);

/**
 * Builds `node --import tsx --test ...` arguments while respecting `DEVKIT_TEST_WORKERS`
 * and preserving default test globs when callers pass only test-runner flags.
 *
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function buildTestArgs(argv, env) {
  const forwarded = argv[0] === '--' ? argv.slice(1) : [...argv];
  let hasConcurrency = false;
  let hasReporter = false;
  let hasTarget = false;
  let afterSeparator = false;

  for (let i = 0; i < forwarded.length; i++) {
    const arg = forwarded[i];
    if (afterSeparator) {
      hasTarget = true;
      continue;
    }
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')) {
        hasConcurrency = true;
      }
      if (arg === '--test-reporter' || arg.startsWith('--test-reporter=')) {
        hasReporter = true;
      }
      if (VALUE_FLAGS.has(arg) && i + 1 < forwarded.length) {
        i++;
      }
    } else {
      hasTarget = true;
    }
  }

  /** @type {string[]} */
  const concurrency =
    !hasConcurrency && /^[1-9]\d*$/.test(env.DEVKIT_TEST_WORKERS ?? '')
      ? [`--test-concurrency=${env.DEVKIT_TEST_WORKERS}`]
      : [];
  const reporter = hasReporter ? [] : ['--test-reporter=@docouno/env/node-test-reporter'];

  return [
    '--import',
    'tsx',
    '--test',
    ...concurrency,
    ...reporter,
    ...forwarded,
    ...(hasTarget ? [] : DEFAULT_GLOBS),
  ];
}

const isMain = () => {
  try {
    return (
      typeof process.argv[1] === 'string' &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isMain()) {
  const result = spawnSync(process.execPath, buildTestArgs(process.argv.slice(2), process.env), {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.signal) {
    const signalNumber = osConstants.signals[result.signal];
    process.exit(typeof signalNumber === 'number' ? 128 + signalNumber : 1);
  }
  process.exit(result.status ?? 1);
}
