import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {moneyView, selectMoney} from '../controls.js';
import type {Cdp} from '../cdp.js';

function moneyPage(broken?: 'blank' | 'scale' | 'slow-quota') {
  let frame = 0, changedAt: number | null = null, loaded = () => {};
  const selected: {label: string; frame: number}[] = [];
  let ids: [string, string][] = [['dense-1', 'balance'], ['dense-2', 'balance']];
  const ready = () => changedAt === null ? frame >= 9 : frame - changedAt >= 4;
  const root = {
    dataset: {get drawReady() {return String(ready());}},
    getBoundingClientRect: () => ({x: Math.min(frame, 8), y: 0, width: 900, height: 220}),
  };
  const line = {
    matches: () => false,
    querySelectorAll: () => [{getAttribute: () => frame < 5 || broken === 'blank' && changedAt !== null && !ready() ? '' : 'M0,10H100'}],
    getBBox: () => ({y: broken === 'scale' && changedAt !== null ? -1 : 10, height: 0}),
    ownerSVGElement: {viewBox: {baseVal: {height: 220}}},
  };
  const buttons = ['Spending', 'Balance'].map(textContent => ({textContent, click() {
    assert.ok(frame >= 11, 'controls wait for populated paths, committed data and stable layout');
    if (changedAt !== null) assert.ok(ready(), 'each switch must finish its numeric preparation');
    selected.push({label: textContent, frame}); changedAt = frame;
  }}));
  const context = {
    localStorage: {getItem: () => '{}', setItem: (_key: string, value: string) => {ids = JSON.parse(value).money.selected.USD;}},
    Date: {now: () => frame * 16},
    requestAnimationFrame: (callback: (stamp: number) => void) => queueMicrotask(() => callback(++frame * 16)),
    document: {
      querySelector: (selector: string) => selector === '.budget-history .chart > svg' ? root
        : selector === '.budget-history.is-loading' ? ready() ? null : {}
        : selector.startsWith('.history.is-loading,') ? broken === 'slow-quota' && frame < 20 ? {} : null
        : selector === '.analytics-head .controls .picker > button' ? {click() {}}
        : selector.startsWith('[data-series=') ? line : null,
      querySelectorAll: (selector: string) => selector === '.budget-history [data-series]' ? frame >= 3 ? ids.map(() => line) : [] : buttons,
      getAnimations: () => frame < 8 ? [{playState: 'running', effect: {target: {matches: () => true}}}] : [],
    },
  };
  const cdp = {
    on: (_method: string, callback: () => void) => {loaded = callback;},
    send: async (method: string) => {if (method === 'Page.reload') loaded();},
    evaluate: async (source: string) => runInNewContext(source, context),
  } as unknown as Cdp;
  return {cdp, selected, ids: () => ids, frame: () => frame};
}

test('the monetary update phase replaces the dense pan selection with its measured account', async () => {
  const page = moneyPage();
  await selectMoney(page.cdp, [['measured', 'balance']]);
  assert.deepEqual(page.ids(), [['measured', 'balance']]);
  assert.deepEqual(page.selected, [], 'selecting accounts does not switch the financial view');
});

test('monetary measurements wait for the other reader to finish after selection reload', async () => {
  const page = moneyPage('slow-quota');
  await selectMoney(page.cdp, [['measured', 'balance']]);
  assert.ok(page.frame() >= 22, 'three stable frames start only after quota history is ready');
});

test('money controls start from a complete drawing and await each prepared view', async () => {
  const page = moneyPage();
  await moneyView(page.cdp, 'wallet', 'capped', 'zero');
  assert.deepEqual(page.selected.map(change => change.label), ['Spending', 'Balance', 'Spending']);
  for (let i = 1; i < page.selected.length; i++) assert.ok(page.selected[i].frame - page.selected[i - 1].frame >= 4);
});

test('waiting for a money view still rejects a lost line before preparation finishes', async () => {
  await assert.rejects(moneyView(moneyPage('blank').cdp, 'wallet', 'capped', 'zero'), /money line disappeared/);
});

test('waiting for a money view still rejects geometry outside the current scale', async () => {
  await assert.rejects(moneyView(moneyPage('scale').cdp, 'wallet', 'capped', 'zero'), /outside its new scale/);
});
