import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters,onDataFilters,filtersReady,effectiveFilters} from '../lib/filterSelection';
import {subscriptionSelection} from '../lib/subscription';
import {moneyReadSelection} from '../lib/moneySelection';
import {plotGroups} from '../lib/historyPlot';
import type {HistoryStore} from '../lib/history';
import type {HistoryTile} from '../lib/historyTiles';
import {ApiError} from '../lib/http';
import * as widgets from '../../server/domain/widgets';

const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
const adapter=source.slice(source.indexOf('const selectedMeters ='),source.indexOf('export const historyReaders'));
const listener=source.split('\n').find(line=>line.startsWith('onDataFilters(()=>{'));
const selectedKey=source.split('\n').find(line=>line.startsWith('const selectedWorkKey='));
assert.ok(listener);assert.ok(selectedKey);

/** Execute the production filter subscription against the real reader and coordinator. */
function wire(h:Awaited<ReturnType<typeof fixture>>,d:Awaited<ReturnType<typeof drawings>>) {
  const stopPeriod=onDataFilters(()=>h.period.changed());let stopReader=()=>{};
  const unused={setMeters(){},setActive(){}};
  runInNewContext(ts.transpileModule(adapter+'\n'+selectedKey+'\n'+listener,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    ...widgets,subscriptionSelection,moneyReadSelection,filtersReady,effectiveFilters,workFilter,
    page:h.page,prefs:()=>h.settings,shellActive:true,pan:h.pan,
    quotaHistory:d.loader,budgetHistory:unused,fundsHistory:unused,
    onDataFilters:(fn:()=>void)=>(stopReader=onDataFilters(fn)),
  });
  return ()=>{stopPeriod();stopReader();};
}
const buffers=(loader:HistoryStore)=>[...(loader as unknown as {grids:Map<number,Map<number,HistoryTile>>}).grids.values()].flatMap(grid=>
  [...grid.values()].flatMap(tile=>[...(tile as unknown as {series:Map<string,{values:Float64Array}>}).series.values()].map(row=>row.values)));
const names=(loader:HistoryStore)=>{
  const plot=loader.getActivityPlot();assert.ok(plot);
  return plotGroups(plot,{k0:Math.floor((NOW-H-M)/plot.cell),k1:Math.ceil((NOW-M)/plot.cell)-1},'project').filter(row=>row.cells.some(([,ms])=>ms>0)).map(row=>row.name);
};
const showActivity=(h:Awaited<ReturnType<typeof fixture>>)=>{
  const view=h.page.get().board!.view;h.directory.saveView(h.board,{...view,hidden:view.hidden.filter(id=>id!==widgets.ACTIVITY),shown:[...new Set([...view.shown,widgets.ACTIVITY])]},h.alice.id,NOW);h.events.flush();
};
const addB=(h:Awaited<ReturnType<typeof fixture>>,show=true)=>{
  if(show)showActivity(h);
  h.store.creditWork(h.device,NOW-20*M,NOW-10*M,[{source:h.source,client:'codex',origin:'terminal',project:'B',folder:'',startedAt:NOW-3*H,identity:{kind:'stable',sessionId:'filter-pan-B'}}]);h.events.flush();
};
const excludeB=()=>{const filters=defaultFilters();filters.projects={mode:'exclude',values:['B']};return filters;};
const move=(loader:HistoryStore,token:number)=>loader.pan({token,length:H,from:NOW-H-M,to:NOW-M,direction:0});

for(const kind of ['cached strip','active strip','late reply','A→B→A','client off','device off','fixed range','cold native-only'] as const)test(`the actual activity drawing follows work filters through ${kind} without replacing native buffers`,async()=>{
  const originalNow=Date.now;Date.now=()=>NOW;publishDataFilters(defaultFilters());
  const h=await fixture({personal:true,fixed:kind==='fixed range'});let d:Awaited<ReturnType<typeof drawings>>|undefined,gate:ReturnType<typeof h.hold>|undefined,stop=()=>{};
  try{
    addB(h,kind!=='cold native-only');await flush();assert.ok(h.period.get().rows.some((row:{project:string})=>row.project==='B'));
    if(kind==='late reply')gate=h.hold();
    d=await drawings(h,kind!=='cold native-only');stop=wire(h,d);
    if(kind==='cold native-only'){
      assert.equal(d.loader.getFinancial().history!.series.length,1);
      const before=h.requests.length;showActivity(h);publishDataFilters({...defaultFilters()});await flush();
      assert.ok(h.requests.slice(before).some(body=>body.quota?.sources==='[]'),'showing activity fills its own previously unread coverage');
    }
    let oldFlight:{controller:AbortController}|undefined,native:Float64Array[]=[];
    if(kind==='late reply'){
      oldFlight=[...(d.loader as unknown as {flights:Set<{controller:AbortController}>}).flights][0];assert.ok(oldFlight);
    }else{
      move(d.loader,1);await flush();assert.ok(names(d.loader).includes('B'));
      if(kind!=='active strip')d.loader.endPan(false);await flush();native=buffers(d.loader);assert.ok(native.length);
    }
    const financial=d.loader.getFinancial(),nativePlot=d.loader.getPlot(),requests=h.requests.length;
    if(kind==='A→B→A')gate=h.hold();
    const filters=excludeB();
    if(kind==='client off'){filters.projects=defaultFilters().projects;filters.clients={mode:'include',values:[]};}
    if(kind==='device off'){filters.projects=defaultFilters().projects;filters.devices={mode:'exclude',values:[h.device]};}
    publishDataFilters(filters);await flush();
    if(kind==='A→B→A'){publishDataFilters(defaultFilters());await flush();}
    if(oldFlight)assert.equal(oldFlight.controller.signal.aborted,true);
    gate?.release();await flush();
    const expected=kind==='A→B→A';
    assert.equal(h.period.get().rows.some((row:{project:string})=>row.project==='B'),expected);
    assert.equal(d.render().history.activity.by.project.some((row:{name:string})=>row.name==='B'),expected);
    const c=consumer({...h,...d});assert.equal(c.settle().names.includes('B'),expected);
    if(native.length){
      assert.ok(native.every(value=>buffers(d!.loader).includes(value)),'native typed buffers survive selected activity replacement');
      assert.equal(d.loader.getFinancial(),financial,'a work-only refresh does not publish another native frame');
      if(kind==='active strip')assert.equal(d.loader.getPlot(),nativePlot,'selected replacement keeps the exact prepared native strip');
      const refresh=h.requests.slice(requests).filter(body=>body.quota);
      assert.ok(refresh.length);
      if(kind!=='fixed range')assert.ok(refresh.every(body=>body.quota!.sources==='[]'&&body.quota!.evidence==='skip'),'cached native cells request activity alone');
      else assert.ok(refresh.some(body=>body.quota!.evidence!=='skip'),'a pending native summary still obtains its own evidence');
    }
    move(d.loader,2);await flush();c.pan();
    assert.equal(names(d.loader).includes('B'),expected,'the cached strip has the selected cohort');
    assert.equal(c.settle().names.includes('B'),expected,'the actual prepared Activity legend has the selected cohort');
    assert.equal(d.loader.getPlot()?.series.length,1,'native geometry remains available alongside selected activity');
  }finally{
    gate?.release();await flush();stop();d?.close();await h.close();publishDataFilters(null,false);Date.now=originalNow;
  }
});

test('a hidden activity widget defers its selected drawing read while native charts reuse their cache',async()=>{
  const originalNow=Date.now;Date.now=()=>NOW;publishDataFilters(defaultFilters());
  const h=await fixture({personal:true});let d:Awaited<ReturnType<typeof drawings>>|undefined,stop=()=>{};
  try{
    addB(h,false);await flush();d=await drawings(h);stop=wire(h,d);const native=buffers(d.loader),financial=d.loader.getFinancial(),before=h.requests.length;
    const filters=excludeB();publishDataFilters(filters);await flush();
    assert.equal(h.requests.slice(before).filter(body=>body.quota).length,0);
    assert.equal(d.loader.getFinancial(),financial);assert.ok(native.every(value=>buffers(d!.loader).includes(value)));
    showActivity(h);publishDataFilters({...filters});await flush();
    assert.ok(h.requests.slice(before).some(body=>body.quota?.sources==='[]'));
    move(d.loader,1);await flush();assert.equal(names(d.loader).includes('B'),false);
  }finally{await flush();stop();d?.close();await h.close();publishDataFilters(null,false);Date.now=originalNow;}
});

for(const failure of ['history_limit','history_failed'] as const)test(`a selected activity ${failure} keeps native measurements live and its own Retry recovers the strip`,async()=>{
  const originalNow=Date.now;Date.now=()=>NOW;publishDataFilters(defaultFilters());
  const h=await fixture({personal:true});let d:Awaited<ReturnType<typeof drawings>>|undefined,stop=()=>{},gate:ReturnType<typeof h.hold>|undefined;
  try{
    addB(h);await flush();d=await drawings(h);stop=wire(h,d);
    move(d.loader,1);await flush();assert.ok(names(d.loader).includes('B'));d.loader.endPan(false);await flush();
    const native=buffers(d.loader),financial=d.loader.getFinancial();assert.ok(native.length);
    gate=h.hold();publishDataFilters(excludeB());await flush();gate.reject(failure==='history_limit'?new ApiError(413,'history_limit'):new Error('offline'));await flush();
    assert.equal(d.loader.get().error,failure);
    assert.equal(d.loader.getFinancial(),financial);
    assert.ok(native.every(value=>buffers(d!.loader).includes(value)));
    assert.equal(d.loader.getActivityPlot(),null);
    const before=h.requests.length;
    h.store.record(h.source,{observedAt:NOW-M/2,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:28,remaining:72,resetAt:NOW+H}]});h.events.flush();await flush();
    assert.equal(h.page.get().board!.cards[h.source].windows[0].remaining,72);
    assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,72);
    assert.equal(d.loader.getFinancial().history!.series[0].points.at(-1)![1],72,'the actual native drawing catches up without selected Retry');
    assert.equal(d.loader.getFinancial().error,undefined);assert.equal(d.loader.get().error,failure);
    assert.ok(h.requests.slice(before).some(body=>body.quota&&body.quota.cells!=='skip'));
    d.loader.retry();await flush();
    assert.equal(d.loader.get().error,undefined);assert.equal(h.period.get().error,null);
    move(d.loader,2);await flush();assert.equal(names(d.loader).includes('B'),false);
    assert.equal(d.loader.getFinancial().history!.series[0].points.at(-1)![1],72);
    assert.equal(d.loader.getPlot()?.series.length,1);
  }finally{
    gate?.release();await flush();stop();d?.close();await h.close();publishDataFilters(null,false);Date.now=originalNow;
  }
});
