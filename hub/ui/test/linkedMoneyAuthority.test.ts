import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture.js';
import {PeriodAccounting} from '../../server/domain/periodAccounting.js';
import {expandPeriod} from '../../server/domain/periodWire.js';
import type {Meter} from '../../server/domain/meters.js';

test('a scheduled link keeps its work authority through the next financial-only event',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({current:true});
  const settle=async()=>{await flush();for(let i=0;i<3;i++)await new Promise<void>(resolve=>setImmediate(resolve));await flush();};
  try{
    const wallet=h.store.source('openrouter','w'.repeat(24),NOW-H);
    h.store.hold(wallet,h.owner,NOW-H);h.store.share(h.board,wallet,h.owner,NOW-H);
    h.store.links.mutate(h.owner,'create',null,{clientId:'codex',deviceId:null,route:null,sourceId:wallet,from:NOW+11000,to:null,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},NOW);
    for(let i=0;i<3;i++){h.events.flush();await settle();}
    const before=h.page.get().board!.workAuthority;
    now=NOW+11000;h.advance(now);await settle();
    const authority=h.page.get().board!.workAuthority;
    assert.notEqual(authority,before);assert.equal(authority,h.store.workKey(h.board));
    assert.equal(h.period.get().rows.length,1);h.requests.length=0;
    now=NOW+12000;h.events.history(wallet,now,['budget']);h.events.flush();await settle();
    assert.equal(h.page.get().board!.workAuthority,authority,'financial history cannot roll back a timed work boundary');
    assert.equal(h.period.get().rows.length,1);assert.equal(h.period.get().loading,false);assert.equal(h.pool.activeFlights,0);
    assert.ok(h.requests.every(request=>!request.sessions),'a subsequent financial event reuses the settled work ledger');
  }finally{await h.close();}
});

for(const fixed of [false,true])test(`correcting funding retires old ${fixed?'fixed':'live'} work curves while preserving exact financial accounting`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true,ownerDevice:true,fixed});
  try{
    const wallet=h.store.source('openrouter','w'.repeat(24),NOW-H),other=h.store.source('openrouter','o'.repeat(24),NOW-H);
    for(const source of [wallet,other]){
      h.store.hold(source,h.owner,NOW-H);
      for(const [at,value] of [[NOW-50*M,'0'],[NOW-M,'6000000']] as const){
        const meter=(id:string,amount:string):Meter=>({id,at,amount,kind:'counter',unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H,stale:false});
        h.store.record(source,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('usage',value),meter('credits','60000000')],keys:[],inventoryComplete:true,inventoryError:null});
      }
    }
    const rule=h.store.links.mutate(h.owner,'create',null,{clientId:'codex',deviceId:null,route:null,sourceId:wallet,from:NOW-H,to:null,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},NOW).body.links[0];
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents','activity','budget-table','budget-history']},h.owner,NOW);
    h.events.touchBoards([h.board]);h.events.flush();await flush();
    assert.equal(h.period.moneyWorkAt(wallet,NOW)?.activeMs,M);
    const financial=h.period.getFinancialProjectionRevision('budget');
    h.store.links.mutate(h.owner,'correct',rule.id,{...rule,sourceId:other,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},NOW);h.events.flush();
    assert.equal(h.period.moneyWorkAt(wallet,NOW),undefined,'authority retirement immediately removes the old estimate');
    for(let i=0;i<5;i++){await new Promise<void>(resolve=>setImmediate(resolve));await flush();}
    assert.equal(h.pool.activeFlights,0);
    const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:fixed?{mode:'range',from:NOW-H,to:NOW}:{mode:'live',periodMs:H},evaluatedAt:NOW,budget:{cell:String(M),from:String(NOW-H),to:String(NOW),unit:'USD',meters:JSON.stringify([[wallet,'balance'],[other,'balance']]),work:'1',cells:'skip'},sessions:{}})));
    assert.ok(reply.budget&&reply.budget.state==='complete');assert.ok(reply.sessions&&reply.sessions.state==='complete');
    const exact=new PeriodAccounting(reply.budget.value.tape!,reply.sessions.value),range=reply.budget.basis.range;
    for(const source of [wallet,other])assert.deepEqual(h.period.moneyWorkAt(source,NOW),exact.moneyWorkSummary(source,range));
    assert.equal(h.period.moneyWorkAt(wallet,NOW)?.activeMs,0);assert.equal(h.period.moneyWorkAt(other,NOW)?.activeMs,M);
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial,'changing funding does not rebuild native financial indices');
  }finally{await h.close();}
});

for(const fixed of [false,true])test(`a financial observation preserves ${fixed?'fixed':'live'} work authority without reading sessions again`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true,ownerDevice:true,fixed});
  try{
    const wallet=h.store.source('openrouter','w'.repeat(24),NOW-H);h.store.hold(wallet,h.owner,NOW-H);
    const record=(at:number,usage:string)=>{
      const meter=(id:string,amount:string):Meter=>({id,at,amount,kind:'counter',unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H,stale:false});
      h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('usage',usage),meter('credits','60000000')],keys:[],inventoryComplete:true,inventoryError:null});
    };
    record(NOW-50*M,'0');record(NOW-M,'6000000');
    h.store.links.mutate(h.owner,'create',null,{clientId:'codex',deviceId:null,route:null,sourceId:wallet,from:NOW-H,to:null,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},NOW);
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents','activity','budget-table','budget-history']},h.owner,NOW);
    h.events.touchBoards([h.board]);h.events.flush();await flush();
    assert.equal(h.period.moneyWorkAt(wallet,NOW)?.activeMs,M);h.requests.length=0;
    record(NOW-5000,'7000000');h.events.flush();await flush();
    assert.equal(h.pool.activeFlights,0);assert.ok(h.requests.some(request=>request.budget));
    assert.ok(h.requests.every(request=>!request.sessions),'a financial measurement reuses the admitted work ledger');
    const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:fixed?{mode:'range',from:NOW-H,to:NOW}:{mode:'live',periodMs:H},evaluatedAt:NOW,budget:{cell:String(M),from:String(NOW-H),to:String(NOW),unit:'USD',meters:JSON.stringify([[wallet,'balance']]),work:'1',cells:'skip'},sessions:{}})));
    assert.ok(reply.budget?.state==='complete'&&reply.sessions?.state==='complete');
    const exact=new PeriodAccounting(reply.budget.value.tape!,reply.sessions.value);
    assert.deepEqual(h.period.moneyWorkAt(wallet,NOW),exact.moneyWorkSummary(wallet,reply.budget.basis.range));
    assert.equal(h.period.moneyWorkAt(wallet,NOW)?.activeMs,M);
  }finally{await h.close();}
});
