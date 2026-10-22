import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {mounted} from './activitySubsetFixture';
import {defaultFilters} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import {setLocale} from '../i18n';

for(const fixed of [false,true])for(const mutedArrival of [false,true])test(`${fixed?'fixed':'live'} dormant mute: ${mutedArrival?'excluded':'ordinary'} project arrival retains complete A until drawing B`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
 const local=mounted(h,d.renderActivity(),async(_board,request)=>expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request))),undefined,['"Later project"']);
 const paint=consumer({...h,...d},{muted:{'activity:project:"Later project"':true},subset:local.reader,hook:local.hook});
 try{
  paint.render();await flush();const a=paint.settle();assert.ok(local.renderProps(a.totals).includes('data-agent-ms="60000"'));
  const project=mutedArrival?'Later project':'Ordinary project';
  h.store.creditWork(h.device,NOW-17*M,NOW-14*M,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);h.events.flush();await flush();
  const held=paint.render();assert.deepEqual(held.paths,a.paths);
  const missing:string[]=[];for(const language of ['en','ru'] as const){setLocale(language);const html=local.renderProps(held.totals);if(!html.includes('data-agent-ms="60000"'))missing.push(language);}
  await flush();const b=paint.settle();assert.ok(local.renderProps(b.totals).includes(`data-agent-ms="${mutedArrival?M:4*M}"`));assert.deepEqual(missing,[],'retained enabled cohort keeps its complete metrics');
 }finally{paint.close();await local.close();d.close();await h.close();setLocale('en');}
});

test('a disappearing excluded live group never widens retained A while B prepares',async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({personal:true,initialFilters:defaultFilters(),creditFrom:NOW-H+M/2,creditTo:NOW-H+1.5*M});
 const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
 credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();const d=await drawings(h);
 const local=mounted(h,d.renderActivity(),async(_board,request)=>expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request))));
 const paint=consumer({...h,...d},{muted:{'activity:project:"Work project"':true},subset:local.reader,hook:local.hook,now:h.clock.hubNow});
 try{
  paint.render();await flush();const a=paint.settle();assert.equal(a.totals.scoped,true);assert.ok(local.renderProps(a.totals).includes(`data-agent-ms="${2*M}"`));
  h.advance(NOW+2*M);credit('New project',NOW-8*M,NOW-5*M);h.events.flush();await flush();
  const held=paint.render();assert.deepEqual(held.paths,a.paths);
  const widened:string[]=[];for(const language of ['en','ru'] as const){setLocale(language);const html=local.renderProps(held.totals);if(!html.includes(`data-agent-ms="${2*M}"`))widened.push(language);}const b=paint.settle();assert.ok(local.renderProps(b.totals).includes(`data-agent-ms="${5*M}"`));assert.deepEqual(widened,[],'retained selected drawing never reads the wider original cohort');
 }finally{paint.close();await local.close();d.close();await h.close();setLocale('en');}
});

for(const fixed of [false,true])test(`${fixed?'fixed':'live'} all-off controls make no subset request and resume when enabled work appears`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);let reads=0;
 const local=mounted(h,d.renderActivity(),async(_board,request)=>{reads++;return expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request)));});
 const paint=consumer({...h,...d},{muted:{'activity:project:"Work project"':true},subset:local.reader,hook:local.hook});
 try{
  paint.render();await flush();const off=paint.settle();assert.equal(reads,0,'the actual all-off hook pauses its dirty scope before transport');assert.equal(off.entries.length,1);
  h.store.creditWork(h.device,NOW-20*M,NOW-18*M,[{source:h.source,client:'codex',origin:'terminal',project:'Keep project',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'Keep project'}}]);h.events.flush();await flush();
  paint.render();await flush();const ready=paint.settle();assert.ok(local.renderProps(ready.totals).includes(`data-agent-ms="${2*M}"`));assert.equal(reads,fixed?1:0,'resuming the same dirty scope needs at most one bounded fixed-subset request');
 }finally{paint.close();await local.close();d.close();await h.close();}
});
