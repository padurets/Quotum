import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {frequencySource, normalizeUpdates, moneyView, selectMoney} from '../controls.js';
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
    performance: {now: () => frame * 16}, window: {},
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
    off: () => {loaded = () => {};},
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


test('the update leaf restores a ready live one-day page and its probe before financial measurement',async()=>{
  let frame=0,loaded=()=>{},removed=false,cleaned=false,resets=0;
  const prefs={range:'30d',horizon:'3d'},location={href:'http://localhost/?board=fixture&from=10&to=20'},commands:{method:string;params?:unknown}[]=[];
  const context={URL,Date:{now:()=>frame*16},window:{__quotumPan:{cleanup:()=>{cleaned=true;}},__quotumBench:{reset:()=>{resets++;}}},
    localStorage:{getItem:()=>JSON.stringify(prefs),setItem:(_key:string,value:string)=>Object.assign(prefs,JSON.parse(value))},location,
    history:{replaceState:(_state:unknown,_title:string,url:URL)=>{location.href=String(url);}},
    requestAnimationFrame:(run:()=>void)=>queueMicrotask(()=>{frame++;run();}),
    document:{getElementById:()=>({remove:()=>{removed=true;}}),querySelector:(selector:string)=>selector.startsWith('[data-widget=')?{dataset:{drawReady:String(frame>=3)}}:null}};
  const cdp={on:(_method:string,run:()=>void)=>{loaded=run;},off:()=>{},send:async(method:string,params?:unknown)=>{commands.push({method,params});if(method==='Page.reload')loaded();},evaluate:async(source:string)=>runInNewContext(source,context)} as unknown as Cdp;
  await normalizeUpdates(cdp);
  assert.equal(prefs.range,'24h');assert.equal(prefs.horizon,'3d');assert.equal(location.href,'http://localhost/?board=fixture');
  assert.ok(removed&&cleaned);assert.equal(resets,1);assert.ok(frame>=3);
  assert.deepEqual(commands.slice(0,4),[{method:'Emulation.setCPUThrottlingRate',params:{rate:1}},{method:'Emulation.clearDeviceMetricsOverride',params:undefined},{method:'Network.emulateNetworkConditions',params:{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1}},{method:'Fetch.disable',params:undefined}]);
  assert.equal(commands.at(-1)?.method,'Page.reload');
});

test('standalone frequency selects the actual first mounted card, independently of the quota measurement source',async()=>{
  const source='claude:0123456789ab';
  const cdp={evaluate:async(expression:string)=>runInNewContext(expression,{document:{querySelector:()=>({closest:()=>({getAttribute:()=>source})})}})} as unknown as Cdp;
  assert.equal(await frequencySource(cdp),source);
});
