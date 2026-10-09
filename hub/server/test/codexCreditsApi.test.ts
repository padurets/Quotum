import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {ResetFeed} from '../resets.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {buildApp} from '../api.js';
import {newSecret} from '../domain/auth.js';
import {composeMeters} from '../domain/meterHistory.js';
import type {WindowMeasurement} from '../domain/quota.js';
const creditMeasurement=(_scene:string,at:number):WindowMeasurement=>({observedAt:at,staleAfterMs:3_600_000,plan:'pro',resets:null,windows:[{id:'weekly',kind:'weekly',used:40,remaining:60,resetAt:null,minutes:10080,label:null}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'2500',hasCredits:true}]});
import {displayMeter} from '../domain/currencyPresentation.js';

async function fixture(t:TestContext) {
  let now=Date.UTC(2026,9,8,12);t.mock.method(Date,'now',()=>now);
  const store=new Store(':memory:',now),directory=new Directory(store.db);
  const alice=directory.createUser('alice@example.test','Alice','fixture',now),bob=directory.createUser('bob@example.test','Bob','fixture',now);
  const board=directory.createBoard('Shared',alice.id,now);directory.addMember(board.id,bob.id,now);
  const source=store.source('codex','a'.repeat(24),now);store.hold(source,bob.id,now);
  store.record(source,creditMeasurement('finite',now));store.share(board.id,source,bob.id,now);
  const ingest=new Ingest(store,directory,new Duty(),new Cadence()),resets=new ResetFeed(undefined,()=>{});
  const app=await buildApp({store,directory,ingest,resets,pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  const cookies=new Map([alice,bob].map(user=>{const token=newSecret('qt_s');directory.createSession(token,user.id,now,86_400_000);return [user.id,'quotum_session='+token];}));
  const call=(user:string,method:'GET'|'POST'|'PUT',url:string,payload?:object)=>app.inject({method,url,payload,headers:{cookie:cookies.get(user)!,origin:'http://localhost','X-Quotum-View-Version':'2'}});
  const overview=async(user=alice.id)=>(await call(user,'GET','/api/overview?board='+board.id)).json();
  const history=async(scope='budget')=>call(alice.id,'GET','/api/history?board='+board.id+'&cell=60000&from='+Date.UTC(2026,9,8,12)+'&to='+Date.UTC(2026,9,8,12,10)+(scope?'&scope='+scope:'')+'&unit=USD&currency=USD&meters='+encodeURIComponent(JSON.stringify([[source,'balance:credits']])));
  const grant=async(user:string,enabled:boolean,revision:string)=>call(user,'PUT','/api/boards/'+board.id+'/shares/'+source+'/budget',{enabled,expectedRevision:revision});
  t.after(async()=>{await app.close();store.close();});
  return {store,directory,alice,bob,board,source,call,overview,history,grant,advance:(ms:number)=>now+=ms};
}

test('shared financial authority covers current values, both history routes, private USD rates and warm-cache revocation',async t=>{
  const h=await fixture(t),off=await h.overview();
  assert.equal(off.sources[0].budget.enabled,false);assert.equal(off.sources[0].creditBalance,undefined);assert.equal(off.sources[0].meters,undefined);
  assert.equal(off.currencies.sources[h.source],undefined);
  for(const scope of ['budget',''])assert.equal((await h.history(scope)).statusCode,404);
  assert.equal((await h.grant(h.alice.id,true,off.sources[0].budget.revision)).statusCode,404,'board owner cannot grant another member’s finances');
  h.advance(30_000);
  const enabled=(await h.grant(h.bob.id,true,off.sources[0].budget.revision)).json().budget;
  assert.equal(enabled.anchor,null);
  const current=await h.overview();assert.equal(current.sources[0].meters[0].at,Date.UTC(2026,9,8,12));
  assert.equal((await h.history()).json().chunks.flatMap((c:any)=>c.meterSeries??[]).length,0);
  h.store.currencies.setRate(h.bob.id,'credits:codex','USD','30000',0,Date.now(),'basePerUnit');
  h.advance(30_000);h.store.record(h.source,creditMeasurement('finite',Date.now()));
  for(const [user,expected] of [[h.alice.id,'100000000'],[h.bob.id,'75000000']]) {
    const snap=await h.overview(user);assert.equal(displayMeter(snap.sources[0].meters[0],h.source,snap.currencies)!.amount,expected);
  }
  const answer=(await h.history()).json(),history=composeMeters(answer.chunks,60_000,Date.UTC(2026,9,8,12),Date.UTC(2026,9,8,12,10))[0];
  assert.equal(history.points[0].at,Date.now());assert.equal(history.points[0].semantics?.conversion?.original.at,Date.now());assert.equal(history.end,'100000000');
  assert.equal((await h.grant(h.bob.id,false,off.sources[0].budget.revision)).statusCode,409);
  const removed=(await h.grant(h.bob.id,false,enabled.revision)).json().budget;
  const denied=await h.overview();assert.equal(denied.sources[0].meters,undefined);assert.equal(denied.sources[0].creditBalance,undefined);assert.equal(denied.currencies.sources[h.source],undefined);
  for(const scope of ['budget',''])assert.equal((await h.history(scope)).statusCode,404);
  h.advance(30_000);const again=(await h.grant(h.bob.id,true,removed.revision)).json().budget;
  assert.equal(again.anchor,null);assert.equal((await h.history()).json().chunks.flatMap((c:any)=>c.meterSeries??[]).length,0);
});

test('builtin credit rate writes use CAS receipts, keep history and cannot become personal definitions or display targets',async t=>{
  const h=await fixture(t),path='/api/currencies/credits:codex',manage=(await h.call(h.bob.id,'GET','/api/currencies/manage')).json();
  const body={base:'USD',rate:'30000',direction:'basePerUnit',expectedRevision:manage.registryRevision,requestId:randomUUID()};
  assert.equal((await h.call(h.bob.id,'POST',path+'/rates',{base:'USD',rate:'30000',direction:'basePerUnit'})).statusCode,400);
  const saved=await h.call(h.bob.id,'POST',path+'/rates',body);assert.equal(saved.statusCode,200);
  assert.deepEqual((await h.call(h.bob.id,'POST',path+'/rates',body)).json(),saved.json());
  assert.equal((await h.call(h.bob.id,'POST',path+'/rates',{...body,rate:'50000',requestId:randomUUID()})).statusCode,409);
  const after=(await h.call(h.bob.id,'GET','/api/currencies/manage')).json();assert.equal(after.personal.length,0);assert.equal(after.builtins[0].pairs[0].rate,'30000');
  h.advance(1000);assert.equal((await h.call(h.bob.id,'POST',path+'/rates/default',{expectedRevision:after.registryRevision,requestId:randomUUID()})).statusCode,200);
  const restored=(await h.call(h.bob.id,'GET',path+'/history')).json();
  assert.equal(restored.changes.length,2);assert.equal(restored.changes[0].nominal,false);assert.equal(restored.changes[0].effectiveAt,Date.now());
  assert.equal((await h.call(h.alice.id,'GET',path+'/history')).json().changes.length,0);
  assert.equal((await h.call(h.bob.id,'POST','/api/currencies/display',{currency:'credits:codex'})).statusCode,400);
});
