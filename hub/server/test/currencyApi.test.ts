import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../api.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';
import {bootstrapLocal} from '../local.js';
import {newSecret} from '../domain/auth.js';

for(const local of [false,true])test(`currency HTTP commands retain authority, receipts and CAS (${local?'local':'web'})`,async()=>{
  const now=Date.now(),store=new Store(':memory:',now),directory=new Directory(store.db),key='k'.repeat(43);
  const a=local?bootstrapLocal(directory,'qt_m_'+'a'.repeat(30),now,'Fixture'):directory.createUser('a@example.com','A','fixture',now),b=local?a:directory.createUser('b@example.com','B','fixture',now);
  const app=await buildApp({store,directory,resets:new ResetFeed(undefined,()=>{}),ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),setup:new Setup(false,null),local:local?{key}:null});
  try {
    const cookies=new Map<string,string>();
    for(const user of [a,b]){const token=newSecret('qt_s');directory.createSession(token,user.id,now,3600000);cookies.set(user.id,'quotum_session='+token);}
    if(local){const entered=await app.inject({url:'/local?key='+key});cookies.set(a.id,String(entered.headers['set-cookie']).split(';')[0]);}
    const request=(method:'GET'|'POST',url:string,payload?:object,owner=a.id,origin?:string)=>app.inject({method,url,payload,headers:{cookie:cookies.get(owner)!,...(origin?{origin}:{})}});
    const management=async()=>{const r=await request('GET','/api/currencies/manage');assert.equal(r.statusCode,200);return r.json();};
    const command=async(url:string,body:object)=>request('POST',url,{...body,requestId:randomUUID(),expectedRevision:(await management()).registryRevision});
    assert.equal((await app.inject({url:'/api/currencies/manage'})).statusCode,401);
    const initial=await management();assert.ok(initial.standards.length>100);
    const input={name:'Points',symbol:'PT',fractionDigits:2,base:'USD',rate:'2000000',requestId:randomUUID(),expectedRevision:initial.registryRevision};
    const created=await request('POST','/api/currencies',input);assert.equal(created.statusCode,201);const id=created.json().id;
    assert.deepEqual((await request('POST','/api/currencies',input)).json(),created.json());assert.equal((await management()).personal.length,1);
    assert.equal((await request('POST','/api/currencies',{...input,name:'Other'})).json().error,'mutation_conflict');
    assert.equal((await command('/api/currencies/'+id,{name:'Changed',symbol:'P',fractionDigits:6})).statusCode,200);
    assert.equal((await request('POST','/api/currencies/'+id,{name:'Old',symbol:'O',fractionDigits:2,expectedRevision:initial.registryRevision,requestId:randomUUID()})).json().error,'currency_conflict');
    if(!local)assert.equal((await request('GET','/api/currencies/'+id+'/history',undefined,b.id)).statusCode,404);
    if(!local)assert.equal((await request('POST','/api/currencies/'+id+'/restore',{requestId:randomUUID(),expectedRevision:'0'},b.id)).statusCode,404);
    if(!local){
      const foreign=await request('POST','/api/currencies',{...input,requestId:randomUUID(),expectedRevision:'0'},b.id);assert.equal(foreign.statusCode,201);
      assert.equal((await request('POST','/api/currencies/'+foreign.json().id+'/rates',{base:'USD',rate:'9000000',requestId:randomUUID(),expectedRevision:'1'},b.id)).statusCode,200);
    }
    assert.equal((await request('POST','/api/currencies/display',{currency:id},a.id,'https://foreign.example')).statusCode,403);
    await command('/api/currencies/display',{currency:id});assert.equal((await command('/api/currencies/'+id+'/archive',{})).json().error,'currency_selected');
    assert.equal((await command('/api/currencies/'+id+'/archive',{replacement:'EUR'})).statusCode,200);assert.equal((await management()).selected,'EUR');
    assert.equal((await command('/api/currencies/'+id+'/restore',{})).statusCode,200);
    const rate=await command('/api/currencies/'+id+'/rates',{base:'USD',rate:'3000000'});assert.equal(rate.statusCode,200);
    assert.equal((await command('/api/currencies/'+id+'/rates/'+rate.json().id+'/archive',{base:'USD'})).statusCode,200);
    const page=(await request('GET','/api/currencies/'+id+'/history?limit=2')).json();
    assert.deepEqual(page.changes.map((change:{sequence:number})=>change.sequence),[3,2]);assert.equal(page.pairs[0].sequence,3);
    assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor,'base64url').toString()),[a.id,id,2]);
    const older=(await request('GET','/api/currencies/'+id+'/history?before='+encodeURIComponent(page.nextCursor))).json();
    assert.deepEqual(older.changes.map((change:{sequence:number})=>change.sequence),[1]);assert.equal(older.nextCursor,null);
    for(const bad of [{base:'USD',rate:'0'},{base:'USD',rate:2},{base:'USD',rate:'1',date:Date.now()+60000}])assert.equal((await command('/api/currencies/'+id+'/rates',bad)).statusCode,400);
    assert.equal((await command('/api/currencies/USD',{name:'Bad',symbol:'X',fractionDigits:2})).statusCode,404);
  }finally{await app.close();store.close();}
});
