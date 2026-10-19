import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {moneyView, selectMoney} from '../controls.js';
import type {Cdp} from '../cdp.js';

function moneyPage(broken?: 'blank' | 'scale' | 'slow-quota') {
  let frame = 0, loaded = () => {};
  let ids: [string, string][] = [['dense-1', 'balance'], ['dense-2', 'balance']];
  const ready = () => frame >= 9;
  const root = {
    viewBox:{baseVal:{height:220}},dataset: {get drawReady() {return String(ready());}},
    getBoundingClientRect: () => ({x: Math.min(frame, 8), y: 0, width: 900, height: 220}),
  };
  const line = {
    matches: () => false,
    querySelectorAll: () => [{getAttribute: () => frame < 5 ? '' : 'M0,10H100'}],
    getBBox: () => ({y: broken === 'scale' ? -1 : 10, height: 0}),
    ownerSVGElement: {viewBox: {baseVal: {height: 220}}},
  };
  const balance='[data-widget="budget-history"]';
  const panel={querySelector:(child:string)=>child==='.chart>svg'?root:null,querySelectorAll:()=>broken==='blank'?[]:[line]};
  const context = {
    localStorage: {getItem: () => '{}', setItem: () => {}},
    URL,location:{href:'https://fixture.invalid/?board=board'},
    fetch:async(path:string,init?:{body:string})=>{
      if(path==='/api/session')return {json:async()=>({user:{id:'user'},boards:[]})};
      if(!init)return {json:async()=>({filters:{version:1},revision:1,authority:'fixture-authority'})};
      const {filters}=JSON.parse(init.body);
      ids=filters.wallet.values.map((ref:{source:string;kind:string;key?:string})=>[ref.source,ref.kind==='keyCap'?'key:'+ref.key+':cap':'balance']);
      return {ok:true,status:200};
    },
    Date: {now: () => frame * 16},
    requestAnimationFrame: (callback: (stamp: number) => void) => queueMicrotask(() => callback(++frame * 16)),
    document: {
      querySelector: (selector: string) => selector===balance?panel:selector === balance+' .chart > svg'||selector==='.budget-history .chart > svg' ? root
        : selector === '.budget-history.is-loading' ? ready() ? null : {}
        : selector.startsWith('.history.is-loading,') ? broken === 'slow-quota' && frame < 20 ? {} : null
        : selector === '.budget-history .panel-head .picker > button' ? {click() {}}
        : selector.startsWith('[data-series=') ? line : null,
      querySelectorAll: (selector: string) => frame<3?[]:selector === balance+' [data-series]'?ids.map(()=>line):selector === '.budget-history [data-series]'?ids.flatMap(()=>[line,line]):[],
      getAnimations: () => frame < 8 ? [{playState: 'running', effect: {target: {matches: () => true}}}] : [],
    },
  };
  const cdp = {
    on: (_method: string, callback: () => void) => {loaded = callback;},
    send: async (method: string) => {if (method === 'Page.reload') loaded();},
    evaluate: async (source: string) => runInNewContext(source, context),
  } as unknown as Cdp;
  return {cdp, ids: () => ids, frame: () => frame};
}

test('the monetary update phase replaces the dense pan selection with its measured account', async () => {
  const page = moneyPage();
  await selectMoney(page.cdp, [['measured', 'balance']]);
  assert.deepEqual(page.ids(), [['measured', 'balance']]);
  assert.ok(page.frame()>=11,'readiness requires the selected account in the balance widget');
});

test('monetary measurements wait for the other reader to finish after selection reload', async () => {
  const page = moneyPage('slow-quota');
  await selectMoney(page.cdp, [['measured', 'balance']]);
  assert.ok(page.frame() >= 22, 'three stable frames start only after quota history is ready');
});

test('money controls check account balances and limits after a stable drawing', async () => {
  const page = moneyPage();
  await moneyView(page.cdp, 'wallet', 'capped', 'zero');
  assert.ok(page.frame()>=11);
});

test('fixed purpose verification rejects an empty numeric plot', async () => {
  await assert.rejects(moneyView(moneyPage('blank').cdp, 'wallet', 'capped', 'zero'), /no account line/);
});


test('waiting for a money view still rejects geometry outside the current scale', async () => {
  await assert.rejects(moneyView(moneyPage('scale').cdp, 'wallet', 'capped', 'zero'), /left its scale/);
});
