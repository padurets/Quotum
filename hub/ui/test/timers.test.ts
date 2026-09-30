import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the page may keep a timer: the connection to the hub, the one clock, the history
 * loader, retries of the first session, saving the view and short-lived gestures and
 * tooltips. Anything that shows time asks the clock (lib/clock.ts), anything that shows
 * data waits for the hub's events (docs/architecture.md, "The dashboard"): a timer of its
 * own elsewhere is a change of that rule, made here on purpose.
 */
const TIMERS = [
  'lib/live.ts',
  'lib/clock.ts',
  'lib/history.ts',
  'lib/session.ts',
  'lib/view.ts',
  // A "copied" mark.
  'components/Kit.tsx',
  // The tooltip of a card's dot after a tap, in its `CardMark`.
  'components/SourceCard.tsx',
  // The chart's tooltip after a tap on a label past its edge.
  'components/Chart.tsx',
  // A legend entry's tooltip pinned briefly after a tap.
  'components/Activity.tsx',
  // Holding a press before a drag, on either chart along the analytics' time.
  'components/timeAxis.ts',
];

function sources(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(file);
    return /\.tsx?$/.test(entry.name) ? [path.relative(UI, file).split(path.sep).join('/')] : [];
  });
}

test('nothing on the page polls: no interval anywhere, timeouts only where the page keeps its timers', () => {
  const files = sources(UI);
  assert.ok(files.includes('main.tsx') && files.includes('lib/live.ts'), 'the page is read');
  for (const file of files) {
    const text = readFileSync(path.join(UI, file), 'utf8');
    assert.ok(!/\bsetInterval\s*\(/.test(text), `${file} sets an interval`);
    if (/\bsetTimeout\s*\(/.test(text)) assert.ok(TIMERS.includes(file), `${file} sets a timeout`);
  }
});
