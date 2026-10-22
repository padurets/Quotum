import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {mounted} from './activitySubsetFixture';
import {defaultFilters} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import {setLocale} from '../i18n';

for(const fixed of [false,true])for(const change of ['same-mask','native-metadata','literal-click'] as const)test(`${fixed?'fixed':'live'} ${change}: legend controls remain available before numerical preparation completes`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()});
 const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
 credit('Keep project',NOW-20*M,NOW-18*M);credit('Other project',NOW-17*M,NOW-14*M);h.events.flush();await flush();const d=await drawings(h);
 let mask:Record<string,boolean>={'activity:project:"Work project"':true},paint:any;
 const writes:{key:string;on:boolean}[]=[];
 const local=mounted(h,d.renderActivity(),async(_board,request)=>expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request))),undefined,[],(key,on)=>{writes.push({key,on});mask={...mask,[key]:on};paint.setMask(mask);});
 paint=consumer({...h,...d},{muted:mask,subset:local.reader,hook:local.hook});
 try{
  paint.render();await flush();const a=paint.settle();assert.equal(a.entries.length,3);assert.ok(a.entries[1]);
  const names=a.entries.map((entry:any)=>entry.name),authority=h.page.get().board!.workAuthority,presentation=d.renderActivity().presentation,run=h.page.get().hubEpoch;
  if(change==='literal-click'){local.click(a.entries[1]);assert.equal(writes.length,1,'executes the production LegendItem onClick and chartMuteKey');}
  else if(change==='same-mask'){paint.setMask({...mask});}
  else{h.store.record(h.source,{observedAt:NOW-M,plan:'Updated plan',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:18,remaining:82,resetAt:NOW+H}]});h.events.flush();await flush();}
  const pending=paint.render();assert.equal(h.page.get().board!.workAuthority,authority);assert.equal(h.page.get().hubEpoch,run);assert.equal(d.renderActivity().presentation,presentation);
  assert.deepEqual(pending.entries.map((entry:any)=>entry.name),names,'changing numerical scope keeps every authorized legend control available');
  for(const language of ['en','ru'] as const){setLocale(language);assert.ok(local.legend(pending.entries[1]).includes(names[1]));}
  if(change==='literal-click'){
    assert.equal(pending.entries[1].muted,true);local.click(pending.entries[1]);assert.equal(writes.length,2,'a second literal click succeeds before B can prepare');
    const returning=paint.render();assert.deepEqual(returning.entries.map((entry:any)=>entry.name),names);assert.equal(returning.entries[1].muted,false);
    assert.equal(local.reader.sameScope(a.totals.model),false,'returning to the original mask does not revive its old numerical lifetime');
  }
  await flush();const recovered=paint.settle();assert.deepEqual(recovered.entries.map((entry:any)=>entry.name),names);assert.equal(recovered.entries[1].muted,false);

 }finally{paint.close();await local.close();d.close();await h.close();setLocale('en');}
});
