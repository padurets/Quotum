import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {openRouter,decodeOpenRouter} from '../connectors/openrouter.js';
import {ConnectorTransport} from '../connectors/transport.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {periodValueAt,type PeriodValues} from '../domain/periodValues.js';
import * as meters from '../domain/meters.js';
import * as resources from '../domain/resources.js';
import * as filterModel from '../domain/dataFilters.js';
import * as currency from '../domain/currency.js';

const M=60_000,H=60*M,now=1_800_000_000_000,secret=Buffer.from('sk-or-v1-'+'a'.repeat(64));
const workspaces=['550e8400-e29b-41d4-a716-446655440000','550e8400-e29b-41d4-a716-446655440001'];
const rawKey=(index:number,limit:unknown)=>({hash:String(index).padStart(64,'0'),workspace_id:workspaces[index-1],name:'Key '+index,disabled:false,expires_at:null,include_byok_in_limit:false,usage:5,usage_daily:0,usage_weekly:0,usage_monthly:0,limit,limit_remaining:typeof limit==='number'?limit-5:null,limit_reset:null});

/** Render the production card, substituting only effects and closed UI primitives. */
async function renderer() {
  const load=(file:string)=>import(new URL(file,import.meta.url).href);
  const money=await load('../../ui/lib/money.ts'),format=await load('../../ui/lib/format.ts'),i18n=await load('../../ui/i18n/index.ts');
  let clock=now;
  const trigger=({trigger}:{trigger:React.ReactNode})=>React.createElement('span',{},trigger);
  const fixture={exports:{} as {MoneyValues:React.ComponentType<Record<string,unknown>>},require:(name:string)=>{
    if(name==='../lib/dataFilters')return {useDataFilters:()=>({current:null})};
    if(name==='../../server/domain/dataFilters')return filterModel;
    if(name==='../lib/prefs')return {usePref:()=>({unit:'USD'})};
    if(name==='../components/DataFilters')return {openDataFilters:()=>{}};
    if(name==='react')return React;if(name==='react/jsx-runtime')return jsx;
    if(name==='../../server/domain/meters')return meters;if(name==='../../server/domain/resources')return resources;if(name==='../../server/domain/currency')return currency;
    if(name==='../lib/money')return money;if(name==='../lib/format')return format;if(name==='../i18n')return i18n;
    if(name==='../lib/measurementClock')return {useMeasurementClock:()=>clock,useMeasurementTime:()=>clock};
    if(name==='./Popover')return {Popover:trigger};if(name==='./StatusMark')return {StatusMark:trigger,KeyIcon:()=>null,WarningIcon:()=>null};
    if(name==='./Meter')return {MeterBar:()=>null};if(name==='./Kit')return {ErrorLine:()=>null};if(name==='../lib/quota')return {level:()=> 'ok'};
    return {};
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../../ui/components/MoneyCard.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,fixture);
  return (value:PeriodValues,to:number)=>{clock=to;return renderToStaticMarkup(React.createElement(fixture.exports.MoneyValues,{source:value,keys:value.keys,meters:value.meters,context:currency.defaultCurrencyContext}));};
}

async function fixture(t:TestContext) {
  t.mock.method(Date,'now',()=>now);
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-key-cap-')),file=path.join(dir,'store.sqlite');
  let store=new Store(file,now-3*H),directory=new Directory(store.db);
  const user=directory.createUser('reader@example.test','Reader','unused',now-3*H),board=directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,now-3*H,24*H);
  let time=now-H,limit:unknown=15,omit=false;
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(operation,_bytes,query={})=>{
    const value=operation==='key'?{data:{is_management_key:true,expires_at:null,organization_id:null,creator_user_id:'fixture'}}:
      operation==='credits'?{data:{total_credits:100,total_usage:5}}:
      operation==='workspaces'?{data:workspaces.map(id=>({id})),total_count:2}:
      {data:query.workspace_id===workspaces[0]?(omit?[]:[rawKey(1,limit)]):[rawKey(2,null)]};
    if(operation==='keys')time+=1000;
    return decodeOpenRouter(JSON.stringify(value));
  };
  const producer=openRouter(transport,()=>time),identity=await producer.identify(secret),source=store.source('openrouter',identity.account,now-3*H);store.hold(source,user.id,now-3*H);
  const build=()=>buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  let app=await build();
  t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const draw=await renderer();
  const record=async(at:number,value:unknown,missing=false)=>{time=at;limit=value;omit=missing;const answer=await producer.measure(secret,identity),measurement=answer.measurement!;assert.ok(store.record(source,measurement).accepted);return measurement;};
  const read=async(to:number)=>{
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:{version:1,selection:{mode:'range',from:to-H,to},evaluatedAt:now,values:[source]}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    if(reply.values?.state!=='complete')throw new Error('missing values');return reply.values.value[0];
  };
  const reopen=async()=>{await app.close();store.close();store=new Store(file,now);directory=new Directory(store.db);app=await build();};
  return {get store(){return store;},source,record,read,reopen,draw};
}
const caps=(value:PeriodValues)=>value.meters.filter(m=>m.kind==='cap');
const membership=(store:Store,source:string,key:string)=>store.db.prepare('SELECT from_at,to_at,payload FROM meter_contexts WHERE source_id=? AND item=? ORDER BY from_at').all(source,'key-cap:'+key);

test('explicit per-key cap removal survives unknown inventory, retention and restart until a valid cap restores it',async t=>{
  const h=await fixture(t),a=now-50*M,b=now-40*M,c=now-30*M,d=now-20*M,e=now-10*M;
  const first=await h.record(a,15),key=first.keys[0].id,cap='key:'+key+':cap';
  await h.record(a+M,15);
  const removed=await h.record(b,null),removal=removed.keys[0].at;
  assert.ok(removal<removed.inventoryAt!,'the first page precedes inventory completion');
  const before=await h.read(removal),after=await h.read(removal+1);
  assert.equal(caps(before)[0]?.id,cap);assert.equal(caps(after).length,0);
  assert.match(h.draw(before,removal),/class="limit money-limit/);assert.doesNotMatch(h.draw(after,removal+1),/class="limit money-limit/);
  assert.equal(periodValueAt(before,removal+1)?.meters.some(m=>m.id===cap),false);
  const malformed=await h.record(c,'malformed');assert.equal(malformed.inventoryComplete,false);assert.equal(malformed.keys.some(k=>k.id===key),true);
  const partial=await h.read(c+3000);assert.equal(caps(partial).length,0);assert.doesNotMatch(h.draw(partial,c+3000),/class="limit money-limit/);
  await h.record(d,null,true);assert.equal(caps(await h.read(d+3000)).length,0);
  const restored=await h.record(e,25),restoration=restored.keys[0].at;
  const cutoff=b+2*M;h.store.meters.prune(cutoff);await h.reopen();
  const rows=membership(h.store,h.source,key);
  assert.deepEqual(rows.map(row=>[row.from_at,JSON.parse(String(row.payload)).present]),[[removal,false],[restoration,true]]);
  assert.equal(caps(await h.read(cutoff+1)).length,0);assert.equal(caps(await h.read(restoration)).length,0);
  const value=await h.read(restoration+1);assert.equal(caps(value)[0].limit,'25000000');
  const inventory=await h.read(restored.inventoryAt!+1);assert.match(h.draw(inventory,restored.inventoryAt!+1),/class="limit money-limit/);
  h.store.meters.contexts.seed();assert.deepEqual(membership(h.store,h.source,key),rows);
});

test('retained legacy uncapped evidence starts at inventory completion and survives later malformed inventory and pruning',async t=>{
  const h=await fixture(t),a=now-50*M,b=now-40*M,c=now-30*M,e=now-10*M;
  const first=await h.record(a,15),key=first.keys[0].id,removed=await h.record(b,null),removal=removed.keys[0].at,knownBy=removed.inventoryAt!;
  await h.record(c,'malformed');const restored=await h.record(e,25),restoration=restored.keys[0].at;
  h.store.db.prepare("DELETE FROM meter_contexts WHERE source_id=? AND item LIKE 'key-cap:%'").run(h.source);
  await h.reopen();
  const rows=membership(h.store,h.source,key);
  assert.ok(rows.some(row=>row.from_at===knownBy&&JSON.parse(String(row.payload)).present===false));
  assert.ok(!rows.some(row=>row.from_at===removal));
  assert.equal(caps(await h.read(removal+1)).length,1);assert.equal(caps(await h.read(knownBy)).length,1);assert.equal(caps(await h.read(knownBy+1)).length,0);
  h.store.meters.prune(b+2*M);await h.reopen();
  const partial=await h.read(c+3000);assert.equal(caps(partial).length,0);assert.doesNotMatch(h.draw(partial,c+3000),/class="limit money-limit/);
  assert.equal(caps(await h.read(restoration)).length,0);assert.equal(caps(await h.read(restoration+1))[0].limit,'25000000');
});

test('a legacy absence whose evidence was already pruned stays unknown instead of borrowing current state',async t=>{
  const h=await fixture(t),a=now-50*M,b=now-40*M,c=now-30*M;
  const first=await h.record(a,15),key=first.keys[0].id;
  await h.record(b,null);await h.record(c,'malformed');
  h.store.db.prepare("DELETE FROM meter_contexts WHERE source_id=? AND item LIKE 'key-cap:%'").run(h.source);
  h.store.meters.prune(c+M);await h.reopen();
  assert.equal(membership(h.store,h.source,key).length,0);
  const value=await h.read(c+2*M);assert.equal(caps(value).length,1);assert.equal(caps(value)[0].stale,true);assert.equal(caps(value)[0].at,first.keys[0].at);
});

test('legacy backfill rolls back atomically when a negative transition cannot be saved',async t=>{
  const h=await fixture(t),first=await h.record(now-50*M,15),key=first.keys[0].id;
  await h.record(now-40*M,null);
  h.store.db.prepare("DELETE FROM meter_contexts WHERE source_id=? AND item LIKE 'key-cap:%'").run(h.source);
  h.store.db.exec(`CREATE TRIGGER reject_absence BEFORE INSERT ON meter_contexts WHEN NEW.item LIKE 'key-cap:%' AND json_extract(NEW.payload,'$.present')=0 BEGIN SELECT RAISE(ABORT,'fixture'); END`);
  assert.throws(()=>h.store.meters.contexts.seed(),/fixture/);assert.equal(membership(h.store,h.source,key).length,0);
  h.store.db.exec('DROP TRIGGER reject_absence');h.store.meters.contexts.seed();
  assert.equal(caps(await h.read(now-30*M)).length,0);
});

test('an accepted key-only negative observation invalidates budget history at its own timestamp',async t=>{
  const h=await fixture(t),first=await h.record(now-50*M,15),key={...first.keys[0],at:now-40*M};
  const events:{source:string;since:number;scopes:readonly string[]|undefined}[]=[];
  h.store.setObserver({touchSources:()=>{},touchBoards:()=>{},touchUser:()=>{},touchHub:()=>{},dropSessions:()=>{},dropMember:()=>{},dropBoard:()=>{},history:(source,since,scopes)=>{events.push({source,since,scopes});}});
  assert.ok(h.store.record(h.source,{type:'meters',observedAt:key.at-1000,staleAfterMs:key.staleAfterMs,meters:[],keys:[key],uncapped:[key.id],inventoryComplete:false,inventoryError:'connector_inventory_partial'}).accepted);
  assert.deepEqual(events,[{source:h.source,since:key.at,scopes:['budget']}]);assert.equal(caps(await h.read(key.at+1)).length,0);
});
