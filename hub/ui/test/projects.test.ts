import {test} from 'node:test';
import assert from 'node:assert/strict';
import {merging, renaming, restoring, shown, timeless, type ProjectGroup} from '../lib/projects';

const group = (name: string | null, reported: string[], agentMs = 60_000, lastAt: number | null = 1): ProjectGroup => ({
  name,
  agentMs,
  lastAt,
  machines: [{id: 'd', name: 'laptop'}],
  reported: reported.map(name => ({name, agentMs: 0})),
});

test('a project is renamed alone, merged with all selected under the one chosen, and a reported name given back alone', () => {
  const quotum = group('quotum', ['quotum', 'quotum.feat']);
  const upper = group('Quotum', ['Quotum']);
  const docs = group('docs', ['docs-site']);
  assert.deepEqual(renaming(quotum, 'core'), {groups: ['quotum'], name: 'core'});
  assert.deepEqual(renaming(quotum, ''), {groups: ['quotum'], name: ''}, 'an empty name: each its own back');
  assert.deepEqual(merging([quotum, upper, docs], upper), {groups: ['quotum', 'Quotum', 'docs'], name: 'Quotum'});
  assert.deepEqual(restoring('quotum.feat'), {reported: ['quotum.feat']});
});

test('a project shows what it gathers besides its own name, by name', () => {
  assert.deepEqual(shown(group('quotum', ['quotum'])), []);
  assert.deepEqual(shown(group('quotum', ['quotum', 'zeta', 'Quotum', 'alpha'])), ['alpha', 'Quotum', 'zeta']);
  assert.deepEqual(shown(group('docs', ['docs-site'])), ['docs-site'], 'a name given before any time came');
  assert.deepEqual(shown(group(null, [])), []);
});

test('a correction with no time kept has none to show, which is not no time at all', () => {
  assert.equal(timeless(group('docs', ['docs-site'], 0, null)), true);
  assert.equal(timeless(group('quotum', ['quotum'], 0, 5)), false);
});
