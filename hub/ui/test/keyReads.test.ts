import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {buildApp} from '../../server/api';
import {Cadence} from '../../server/cadence';
import {Duty} from '../../server/duty';
import {Ingest} from '../../server/ingest';
import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import {ResetFeed} from '../../server/resets';
import * as bounds from '../../server/domain/sourceKeys';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {ApiError} from '../lib/http';
import type {KeyPage} from '../lib/keyReads';

const code=ts.transpileModule(readFileSync(new URL('../lib/keyReads.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const reader=(call:unknown)=>{const context={exports:{} as typeof import('../lib/keyReads'),require:(name:string)=>name.endsWith('/http')?{ApiError,call}:bounds};runInNewContext(code,context);return context.exports.readKeyIds;};
const empty:KeyPage={keys:[],meters:[],total:0,inventory:null,next:null};

test('the shared key reader recovers selections above the real endpoint limit without changing that limit',async t=>{
  const now=Date.now(),store=new Store(':memory:',now),directory=new Directory(store.db),user=directory.createUser('keys@fixture.example','Keys','unused',now),board=directory.createBoard('Keys',user.id,now);
  const source=store.source('openrouter','1'.repeat(24),now);store.hold(source,user.id,now);store.share(board.id,source,user.id,now);directory.createSession('key-read-fixture',user.id,now,60_000);
  const keys:KeyPart[]=Array.from({length:57},(_,i)=>({id:i.toString(16).padStart(12,'0'),name:'Key '+i,disabled:false,expiresAt:null,includeByok:false,at:now,staleAfterMs:300_000,presence:'observed',missCount:0,periods:{day:null,week:null,month:null}}));
  const meters:Meter[]=keys.map(key=>({id:`key:${key.id}:cap`,kind:'cap',unit:'USD',amount:'1000000',limit:'2000000',at:now,staleAfterMs:300_000,stale:false,resetAt:null,minutes:null,scope:null,label:null}));
  store.record(source,{type:'meters',observedAt:now,staleAfterMs:300_000,meters,keys,inventoryComplete:true,inventoryError:null});
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});t.after(async()=>{await app.close();store.close();});
  const paths:string[]=[];
  const call=async(_method:string,path:string)=>{paths.push(path);const reply=await app.inject({method:'GET',url:path,headers:{cookie:'quotum_session=key-read-fixture'}});if(reply.statusCode!==200)throw new ApiError(reply.statusCode,reply.json().error);return reply.json();};
  const ids=keys.slice(0,51).map(key=>key.id),base=`/api/boards/${board.id}/sources/${source}/keys?ids=`;
  await assert.rejects(call('GET',base+encodeURIComponent(JSON.stringify(ids))),error=>error instanceof ApiError&&error.status===400);
  paths.length=0;const read=reader(call),selected=await read(board.id,source,[...ids,ids[0]]);
  assert.deepEqual(Array.from(selected.keys,key=>key.id).sort(),[...ids].sort());assert.equal(selected.meters.length,51);assert.equal(paths.length,2);
  assert.deepEqual(paths.map(path=>JSON.parse(new URL(path,'https://fixture.invalid').searchParams.get('ids')!).length),[50,1]);
  paths.length=0;
  const unicode=Array.from({length:51},(_,i)=>'Ж'.repeat(117)+String(i).padStart(3,'0'));
  const missing=await read(board.id,source,unicode);assert.equal(missing.keys.length,0);assert.ok(paths.length>2);
  for(const path of paths){const encoded=path.slice(path.indexOf('?ids=')+5);assert.ok(encoded.length<=bounds.KEY_IDS_QUERY_LIMIT);assert.ok(JSON.parse(decodeURIComponent(encoded)).length<=bounds.KEY_IDS_LIMIT);}
  paths.length=0;await read(board.id,source,[]);assert.equal(paths.length,0);
});

test('closing a key consumer cancels a pending lookup before it can start another batch',async()=>{
  const controller=new AbortController(),calls:string[]=[];let release!:(value:KeyPage)=>void;
  const read=reader((_method:string,path:string,_body:unknown,_timeout:number,signal:AbortSignal)=>{assert.equal(signal,controller.signal);calls.push(path);return new Promise<KeyPage>(resolve=>{release=resolve;});});
  const pending=read('board','source',Array.from({length:51},(_,i)=>String(i)),controller.signal);
  assert.equal(calls.length,1);controller.abort();release(empty);
  await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');assert.equal(calls.length,1);
});

test('a failed later key batch rejects the complete membership result',async()=>{
  let calls=0;const read=reader(async()=>{if(++calls===2)throw new ApiError(503,'unavailable');return empty;});
  await assert.rejects(read('board','source',Array.from({length:51},(_,i)=>String(i))),error=>error instanceof ApiError&&error.code==='unavailable');assert.equal(calls,2);
});
