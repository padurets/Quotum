import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError} from '../lib/http';
import type {History} from '../lib/types';
import type {MeterSelection} from '../../server/domain/meterHistory';
import {harness, card, H, NOW, type Frame} from './historyAuthorityFixture';

const quotaIds = (history: History | null) => history?.series.map(s => `${s.sourceId}/${s.windowId}`).sort() ?? [];
const meterIds = (history: History | null) => history?.meterSeries?.map(s => `${s.sourceId}/${s.meterId}/${s.unit}`).sort() ?? [];

for (const scope of ['work','legacy','personal','shared'] as const) test(`a ${scope} zero cutoff retires the final history frame while its replacement waits`, async () => {
  const h = harness(); try {
    const initial = await h.start();
    if (scope === 'personal') h.event({type: 'snapshot', data: {...h.snapshot(), board: {id: 'b', name: '', personal: true}}});
    h.exact(false);
    h.event({type: 'history', data: scope==='personal'||scope==='shared'
      ? {sources: [], since: NOW, workSince: 0}
      : {sources: ['kept'], since: 0, ...(scope === 'work' ? {changes: [{source: 'kept', scope: 'quota', since: 0, workSince: 0}]} : {})}});
    assert.ok(h.loader.get().presentation > initial.presentation);
    emptyFrame(h.render(), 'work authority changed'); await h.answerCells();
    emptyFrame(h.render(), 'fresh cells alone cannot authorize the retired work');
    h.exact(false, 'history_failed'); emptyFrame(h.render(), 'failed replacement');
  } finally {h.close();}
});

test('budget and inaccessible resource zero cutoffs leave authorized quota presentation intact', async () => {
  const h = harness(); try {
    const initial = await h.start();
    for (const data of [{sources: ['kept'], since: 0, changes: [{source: 'kept', scope: 'budget' as const, since: 0}]}, {sources: ['foreign'], since: 0}]) {
      h.event({type: 'history', data}); assert.equal(h.render().history, initial.history); assert.equal(h.loader.get().presentation, initial.presentation);
    }
  } finally {h.close();}
});

function emptyFrame(frame: Frame, why: string) {
  assert.equal(frame.history, null, `${why}: accounting cannot borrow the retired frame`);
  assert.equal(frame.drawing, null, `${why}: drawing cannot borrow the retired frame`);
}

test('a lineup removal cannot return through retained accounting or drawing while exact evidence waits or fails', async () => {
  const h = harness();
  try {
    assert.deepEqual(quotaIds((await h.start()).history), ['kept/weekly', 'removed/weekly']);
    h.exact(false);
    h.event({type: 'lineup', data: {sources: ['kept']}});
    assert.deepEqual(h.page.get().board!.lineup, ['kept']);
    assert.equal(h.loader.get().history, null, 'the actual follower retires removed source cells');
    emptyFrame(h.render(), 'immediately after removal');
    await h.answerCells();
    assert.deepEqual(quotaIds(h.loader.get().history), ['kept/weekly'], 'clean drawing cells arrive before the exact tape');
    emptyFrame(h.render(), 'exact evidence still pending');
    assert.equal(h.render().loading, true);
    h.exact(false, 'history_failed');
    emptyFrame(h.render(), 'exact evidence failed');
    assert.equal(h.render().error, 'history_failed'); assert.equal(h.render().loading, false);
    h.exact(true);
    assert.deepEqual(quotaIds(h.render().history), ['kept/weekly']);
    assert.deepEqual(quotaIds(h.render().drawing), ['kept/weekly']);
  } finally {h.close();}
});

test('a removal during panning retires both the held frame and the live drawing strip', async () => {
  const h = harness();
  try {
    const initial = await h.start(); await h.pan();
    assert.equal(h.render().history, initial.history, 'ordinary panning holds the complete frame');
    assert.ok(h.loader.getPlot()!.series.some(series => series.sourceId === 'removed'));
    h.exact(false); h.event({type: 'lineup', data: {sources: ['kept']}});
    emptyFrame(h.render(), 'removal during a gesture');
    assert.equal(h.loader.getPlot(), null, 'the drawing strip loses removed membership immediately');
    await h.answerCells();
    assert.ok(h.loader.getPlot()!.series.every(series => series.sourceId === 'kept'));
    emptyFrame(h.render(), 'a new strip cannot restore the retired complete frame');
    h.endPan(); await h.answerCells();
    emptyFrame(h.render(), 'release while exact evidence is pending');
    h.exact(true); assert.deepEqual(quotaIds(h.render().drawing), ['kept/weekly']);
  } finally {h.close();}
});

test('a later history access boundary retires the old frame even when source IDs are unchanged', async () => {
  const h = harness();
  try {
    const initial = await h.start(), historyStart = NOW - H / 2;
    h.exact(false); h.event({type: 'snapshot', data: {...h.snapshot(), historyStart}});
    assert.deepEqual(h.page.get().board!.lineup, ['removed', 'kept']);
    emptyFrame(h.render(), 'the snapshot moved the access boundary');
    await h.answerCells();
    assert.equal(h.loader.get().history!.historyStart, historyStart);
    emptyFrame(h.render(), 'cells obey the new boundary while exact accounting waits');
    h.exact(false, 'history_failed'); emptyFrame(h.render(), 'exact accounting for the new boundary failed');
    h.exact(true); assert.notEqual(h.render().drawing, initial.drawing);
    assert.equal(h.render().drawing!.historyStart, historyStart);
  } finally {h.close();}
});

for (const panning of [false, true]) test(`removing a window from a live card retires its complete frame${panning ? ' during panning' : ''}`, async () => {
  const h = harness();
  try {
    await h.start([card('kept', ['old-window', 'weekly'])]);
    if (panning) await h.pan();
    h.exact(false); h.event({type: 'card', data: card('kept')});
    emptyFrame(h.render(), 'the card event removed a window');
    if (panning) h.endPan();
    await h.answerCells();
    assert.deepEqual(quotaIds(h.loader.get().history), ['kept/weekly']);
    emptyFrame(h.render(), 'cached cells were recomposed before the exact evidence');
    h.exact(true); assert.deepEqual(quotaIds(h.render().drawing), ['kept/weekly']);
  } finally {h.close();}
});

const initialMeters: MeterSelection = {unit: 'USD', ids: [['kept', 'balance'], ['removed', 'balance']]};
for (const [name, selection] of [
  ['meter removal', {unit: 'USD', ids: [['kept', 'balance']]}],
  ['display currency', {...initialMeters, unit: 'EUR'}],
  ['resource revision with unchanged IDs', {...initialMeters, resourceRevision: 'new-resource'}],
] satisfies [string, MeterSelection][]) test(`a ${name} cannot retain the previous money projection`, async () => {
  const h = harness();
  try {
    await h.start(); h.loader.setMeters(initialMeters); await h.answerCells();
    assert.deepEqual(meterIds(h.render().history), ['kept/balance/USD', 'removed/balance/USD']);
    h.exact(false); h.loader.setMeters(selection);
    emptyFrame(h.render(), 'resource selection changed');
    await h.answerCells();
    assert.deepEqual(meterIds(h.loader.get().history), selection.ids.map(([source, meter]) => `${source}/${meter}/${selection.unit}`).sort());
    emptyFrame(h.render(), 'new money cells arrived before exact accounting');
    h.exact(false, 'history_failed'); emptyFrame(h.render(), 'replacement accounting failed');
    h.exact(true); assert.deepEqual(meterIds(h.render().drawing), meterIds(h.loader.get().history));
  } finally {h.close();}
});

test('a missing resource response cannot be followed by resurrection of its retained frame', async () => {
  const h = harness();
  try {
    await h.start(); h.exact(false); h.loader.news(NOW);
    await h.fail(new ApiError(404, 'not_found'));
    emptyFrame(h.render(), 'the server confirmed a missing resource');
    assert.equal(h.render().error, 'history_failed');
    h.choose('6h'); await h.answerCells();
    assert.ok(h.loader.get().history, 'the recovery reads really published new cells');
    emptyFrame(h.render(), 'recovery cannot reuse accounting from before not_found');
  } finally {h.close();}
});

test('closing the board during a gesture clears accounting, drawing and pending reads', async () => {
  const h = harness();
  try {
    await h.start(); await h.pan(); h.exact(false);
    h.page.dispatch({type: 'board-close'});
    assert.equal(h.page.get().board, null); assert.equal(h.loader.getPlot(), null);
    emptyFrame(h.render(), 'board access ended');
    assert.equal(h.pending().length, 0);
  } finally {h.close();}
});

test('ordinary period changes and same-run reconnects keep the last complete frame while exact evidence waits', async () => {
  const h = harness();
  try {
    const initial = await h.start(); h.exact(false); h.choose('6h'); await h.answerCells();
    assert.equal(h.loader.get().history!.range, '6h', 'the period change published a different cell frame');
    assert.equal(h.render().history, initial.history); assert.equal(h.render().drawing, initial.drawing);
    h.exact(false, 'history_failed');
    assert.equal(h.render().history, initial.history, 'an ordinary evidence error does not revoke membership');
    assert.equal(h.render().drawing, initial.drawing); assert.equal(h.render().loading, false);
    h.exact(false); h.reconnect(); await h.answerCells();
    assert.equal(h.render().history, initial.history, 'a same-run reconnect with unchanged membership preserves the complete frame');
    assert.equal(h.render().drawing, initial.drawing);
    h.exact(true); assert.equal(h.render().history!.range, '6h'); assert.notEqual(h.render().drawing, initial.drawing);
  } finally {h.close();}
});

test('a changed-run reconnect retires the complete frame even with unchanged membership', async () => {
  const h = harness();
  try {
    const initial = await h.start(), run = h.page.get().hubEpoch;
    h.exact(false); h.restart();
    assert.notEqual(h.page.get().hubEpoch, run, 'the restart actually changes the observed producer');
    emptyFrame(h.render(), 'immediately after the new run');
    await h.answerCells();
    assert.ok(h.loader.get().history, 'the replacement really published native cells');
    emptyFrame(h.render(), 'native cells cannot authorize work from the previous run');
    h.exact(false, 'history_failed'); emptyFrame(h.render(), 'new-run exact evidence failed');
    h.exact(true);
    assert.ok(h.render().history); assert.notEqual(h.render().history, initial.history);
    assert.equal(h.render().drawing, h.render().history);
  } finally {h.close();}
});

for (const code of ['history_failed', 'history_limit']) test(`${code} recovery preserves the complete frame when resource membership is unchanged`, async () => {
  const h = harness();
  try {
    const initial = await h.start(); h.exact(false); h.loader.news(NOW);
    await h.fail(new ApiError(503, code));
    assert.equal(h.loader.get().error, code);
    h.choose('6h'); await h.answerCells();
    assert.equal(h.loader.get().history!.range, '6h');
    assert.equal(h.render().history, initial.history, 'a transient failure does not retire the authorized accounting frame');
    assert.equal(h.render().drawing, initial.drawing);
    h.exact(true); assert.equal(h.render().drawing!.range, '6h');
  } finally {h.close();}
});
