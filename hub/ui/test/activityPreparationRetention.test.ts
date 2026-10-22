import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {mounted} from './activitySubsetFixture';
import {defaultFilters} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';

for(const fixed of [false,true])for(const preparing of [false,true])test(`${fixed?'fixed':'live'} ${preparing?'queued B stays charged beside painted A and current C':'unseen B adds no retained charge'}`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()});
 const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
 credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();const d=await drawings(h);
 const local=mounted(h,d.renderActivity(),async(_board,request)=>expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request))));
 const paint=consumer({...h,...d},{muted:{'activity:project:"Work project"':true},subset:local.reader});
 try{
  paint.render();await flush();const initial=paint.settle(),a=local.reader.get().model!;assert.ok(a);assert.equal(local.pool.estimatedBytes,a.bytes);
  credit('B project',NOW-17*M,NOW-14*M);h.events.flush();await flush();const b=local.reader.get().model!;assert.notEqual(a,b);
  if(preparing){const pending=paint.render();assert.deepEqual(pending.paths,initial.paths);}assert.equal(paint.queuedParent(),preparing?1:0,'the real parent generator captures numeric B only after its render');
  credit('C project',NOW-10*M,NOW-6*M);h.events.flush();await flush();const c=local.reader.get().model!;assert.notEqual(b,c);
  assert.equal(paint.queuedParent(),preparing?1:0,'there has been no React render to replace or cancel the B job');
  const charged=local.pool.estimatedBytes,held=a.bytes+(preparing?b.bytes:0)+c.bytes;
  if(preparing){paint.finishParent();const publishedB=paint.render();assert.equal(publishedB.incomingModel,b,'finishing the outstanding actual generator publishes B even though C is current');assert.equal(local.reader.get().model,c);assert.equal(local.pool.estimatedBytes,a.bytes+b.bytes+c.bytes,'queued input and completed output share one retained charge');}assert.ok(charged>=held,'A displayed plus B preparing plus C current all retain numerical projectors');
 }finally{paint.close();await local.close();d.close();await h.close();}
});
