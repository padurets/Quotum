import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {gunzipSync} from 'node:zlib';
import {buildApp} from '../api.js';
import {Events,type PollAnswer} from '../events.js';
import {config} from '../config.js';
import {KEEP_MS} from '../sessions.js';
import {newSecret} from '../domain/auth.js';
import {saveProjectColors} from '../store/projectColors.js';
import {centralFixture,at} from './centralFixture.js';

async function fixture(t:TestContext,reader:'owner'|'foreign'='foreign',encoding:'identity'|'gzip'='identity') {
  let now=at+60_000;
  t.mock.method(Date,'now',()=>now);
  const f=await centralFixture();await f.app.close();
  const user=reader==='owner'?f.owner:f.reader,secret=newSecret('qt_s');
  f.directory.createSession(secret,user.id,now,86_400_000);
  const events=new Events(f.hub,{...config.events,recheckMs:0},{now:()=>now,after:()=>()=>{}},null);
  let mutate:(()=>void)|null=null,preparedStream=false;
  const app=await buildApp({...f.hub,events},app=>{
    app.addHook('onSend',async(request,_reply,payload)=>{
      if(request.url.startsWith('/api/events?')&&mutate){
        preparedStream=payload instanceof Readable;
        const change=mutate;mutate=null;await Promise.resolve();change();
      }
      return payload;
    });
  });
  t.after(async()=>{await app.close();f.store.close();});
  const credit=(project:string)=>f.store.creditWork(f.device.id,at,at+60_000,[{source:null,client:'codex',origin:'terminal',startedAt:at,project,folder:'',identity:{kind:'legacy',ordinal:0}}]);
  const pin=(project:string,color:'#bf616a'|'#d08770'='#bf616a')=>{if(saveProjectColors(f.store.db,f.board,[[project,color]],f.owner.id,now))f.store.projectColorsChanged(f.board);};
  const request=async(lease?:string)=>{
    const response=await app.inject({url:`/api/events?mode=poll&board=${f.board}`+(lease?'&lease='+lease:''),headers:{cookie:'quotum_session='+secret,'quotum-stream':'1','accept-encoding':encoding}});
    const body=response.headers['content-encoding']==='gzip'?gunzipSync(response.rawPayload).toString():response.body;
    assert.equal(response.statusCode,200);return {response,body,answer:JSON.parse(body) as {lease:string;events:{type:string;data:any}[]}};
  };
  const revoke=()=>{const policy=f.store.sessionDevices(f.board,f.owner.id)[0];f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,false,policy.revision,now);};
  return {...f,events,user,secret,credit,pin,request,revoke,change:(run:()=>void)=>{mutate=run;},advance:(ms:number)=>{now+=ms;},preparedStream:()=>preparedStream};
}

for(const reader of ['owner','foreign'] as const)for(const encoding of ['identity','gzip'] as const){
  test(`${reader} poll replaces revoked work and pins after asynchronous ${encoding} preparation`,async t=>{
    const f=await fixture(t,reader,encoding);f.credit('private-poll-canary');f.pin('private-poll-canary');
    f.change(f.revoke);
    const {response,body,answer}=await f.request();
    assert.equal(f.preparedStream(),encoding==='gzip','the revoke happens after native compression preparation');
    assert.equal(response.headers['content-encoding'],undefined);
    assert.equal(body.includes('private-poll-canary'),false);
    assert.equal(answer.events[0].type,'hello','a replaced initial answer still establishes the connection');
    const snapshot=answer.events.find(event=>event.type==='snapshot')!.data;
    const colors=answer.events.find(event=>event.type==='projectColors')!.data;
    assert.equal(snapshot.workAuthority,f.store.workKey(f.board));
    assert.equal(snapshot.projectColorsAuthority,colors.authority);assert.equal(snapshot.projectColorsRevision,colors.revision);
    assert.deepEqual(colors.pins,[]);
  });
}

for(const change of ['membership','session'] as const)test(`a prepared poll retires every private frame after ${change} revocation`,async t=>{
  const f=await fixture(t);f.credit('revoked-reader-canary');f.pin('revoked-reader-canary');
  f.change(()=>{if(change==='membership')f.directory.removeMember(f.board,f.user.id);else f.directory.deleteSession(f.secret);});
  const {answer,body}=await f.request();
  assert.deepEqual(answer.events,[{type:'bye',data:{reason:change==='membership'?'gone':'unauthorized'}}]);
  assert.equal(body.includes('revoked-reader-canary'),false);assert.equal(f.events.readers,0);
});

for(const encoding of ['identity','gzip'] as const)test(`financial revocation replaces a prepared ${encoding} poll without retiring admitted colours`,async t=>{
  const f=await fixture(t,'foreign',encoding),now=Date.now();f.credit('admitted-project');f.pin('admitted-project');
  const source=f.store.source('codex','a'.repeat(24),now);f.store.hold(source,f.owner.id,now);f.store.share(f.board,source,f.owner.id,now,true);
  f.store.record(source,{observedAt:now,staleAfterMs:3_600_000,plan:'pro',windows:[],resets:null,balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'991123',hasCredits:true}]});
  const work=f.store.workKey(f.board);
  f.change(()=>{const budget=f.store.sources(f.board).find(row=>row.id===source)!.budget!;f.store.setBudget(f.board,source,f.owner.id,false,budget.revision,now);});
  const {answer,body}=await f.request(),snapshot=answer.events.find(event=>event.type==='snapshot')!.data;
  assert.equal(body.includes('991123'),false);assert.equal(snapshot.workAuthority,work);
  assert.deepEqual(answer.events.find(event=>event.type==='projectColors')!.data.pins,[['admitted-project','#bf616a']]);
  assert.equal(snapshot.sources[0].meters,undefined);assert.equal(snapshot.sources[0].creditBalance,undefined);
});

for(const pending of ['initial','sessions','configuration'] as const)test(`a live-only pin expires during prepared ${pending} delivery without changing work authority`,async t=>{
  const f=await fixture(t),empty=pending==='sessions'?await f.request():null,now=Date.now();
  f.hub.ingest.live.report(f.device.id,f.owner.id,[{clientId:'opencode',sessionId:null,source:null,origin:'terminal',project:'expired-live-canary',folder:null,startedAt:now,sentStartedAt:now,lastWorkedAt:null,working:false,device:{id:f.device.id,name:'Laptop'},accountBy:null,route:null}],now);
  f.pin('expired-live-canary');const first=pending==='configuration'?await f.request():empty,work=f.store.workKey(f.board);
  if(pending==='configuration')f.pin('expired-live-canary','#d08770');
  f.events.flush();f.change(()=>f.advance(KEEP_MS+1));
  const {answer,body}=await f.request(first?.answer.lease);
  assert.equal(f.store.workKey(f.board),work);assert.equal(body.includes('expired-live-canary'),false);
  assert.deepEqual(answer.events.find(event=>event.type==='projectColors')!.data.pins,[]);
  assert.equal(answer.events.some(event=>event.type==='history'),false);
  assert.equal(answer.events.some(event=>event.type==='snapshot'),pending!=='configuration');
});

for(const reader of ['owner','foreign'] as const)for(const encoding of ['identity','gzip'] as const)for(const refreshed of [false,true]){
  test(`${reader} ${encoding} poll retires producer work expired before take${refreshed?' even after a fresh queued batch':''}`,async t=>{
    const f=await fixture(t,reader,encoding),first=await f.request(),now=Date.now(),canary='expired-before-take-canary';
    f.hub.ingest.live.report(f.device.id,f.owner.id,[{clientId:'opencode',sessionId:null,source:null,origin:'terminal',project:canary,folder:null,startedAt:now,sentStartedAt:now,lastWorkedAt:null,working:false,device:{id:f.device.id,name:'Laptop'},accountBy:null,route:null}],now);
    f.pin(canary);f.events.flush();const work=f.store.workKey(f.board);
    f.advance(KEEP_MS+1);
    if(refreshed){f.events.touchBoards([f.board]);f.events.flush();}
    const {answer,body}=await f.request(first.answer.lease);
    assert.equal(body.includes(canary),false);assert.equal(f.store.workKey(f.board),work);
    const snapshot=answer.events.find(event=>event.type==='snapshot')!.data,colors=answer.events.find(event=>event.type==='projectColors')!.data;
    assert.deepEqual(snapshot.unattributedSessions,[]);assert.deepEqual(colors.pins,[]);
    assert.equal(snapshot.projectColorsAuthority,colors.authority);assert.equal(snapshot.workAuthority,work);
    assert.equal(answer.events.some(event=>event.type==='history'),false);
  });
}

test('another reader cannot replace the producer provenance by sanitizing metadata before enqueue',async t=>{
  const f=await fixture(t),now=Date.now();let expire=false;
  const opened=f.events.open({user:f.user.id,secret:f.secret,board:f.board,kind:'stream',send:()=>{if(expire){expire=false;f.advance(KEEP_MS+1);}},end:()=>{}});
  assert.ok(opened&&opened!=='limit');
  const first=await f.request(),canary='expired-during-producer-canary';
  f.hub.ingest.live.report(f.device.id,f.owner.id,[{clientId:'opencode',sessionId:null,source:null,origin:'terminal',project:canary,folder:null,startedAt:now,sentStartedAt:now,lastWorkedAt:null,working:false,device:{id:f.device.id,name:'Laptop'},accountBy:null,route:null}],now);
  f.pin(canary);expire=true;f.events.flush();
  const {body,answer}=await f.request(first.answer.lease);
  assert.equal(body.includes(canary),false);assert.ok(answer.events.some(event=>event.type==='snapshot'));
});

test('a producer deadline retires queued live work even without any colour pins',async t=>{
  const f=await fixture(t),first=await f.request(),now=Date.now(),canary='unpinned-expired-canary';
  f.hub.ingest.live.report(f.device.id,f.owner.id,[{clientId:'opencode',sessionId:null,source:null,origin:'terminal',project:canary,folder:null,startedAt:now,sentStartedAt:now,lastWorkedAt:null,working:false,device:{id:f.device.id,name:'Laptop'},accountBy:null,route:null}],now);
  f.events.flush();const before=f.hub.projectColors!.context(f.board).envelope,work=f.store.workKey(f.board);f.advance(KEEP_MS+1);
  const {answer,body}=await f.request(first.answer.lease),after=f.hub.projectColors!.context(f.board).envelope;
  assert.equal(body.includes(canary),false);assert.deepEqual(after,before);assert.equal(f.store.workKey(f.board),work);
  assert.deepEqual(answer.events.find(event=>event.type==='snapshot')!.data.unattributedSessions,[]);
});

for(const reset of [false,true])test(`a colour-only ${reset?'reset':'save'} keeps a prepared session delta without a new baseline`,async t=>{
  const f=await fixture(t),now=Date.now();
  const report=(folder:string)=>f.hub.ingest.live.report(f.device.id,f.owner.id,[{clientId:'opencode',sessionId:null,source:null,origin:'terminal',project:'still-admitted',folder,startedAt:now,sentStartedAt:now,lastWorkedAt:null,working:false,device:{id:f.device.id,name:'Laptop'},accountBy:null,route:null}],now);
  report('first');if(reset)f.pin('still-admitted');const first=await f.request(),work=f.store.workKey(f.board);
  report('second');f.events.flush();
  f.change(()=>{if(reset){saveProjectColors(f.store.db,f.board,[],f.owner.id,now);f.store.projectColorsChanged(f.board);}else f.pin('still-admitted');});
  const {answer}=await f.request(first.answer.lease);
  assert.equal(f.store.workKey(f.board),work);
  assert.equal(answer.events.some(event=>event.type==='snapshot'||event.type==='history'),false);
  assert.equal(answer.events.find(event=>event.type==='unattributedSessions')!.data.sessions[0].project,'still-admitted');
  assert.deepEqual(answer.events.find(event=>event.type==='projectColors')!.data.pins,reset?[]:[['still-admitted','#bf616a']]);
});

test('each prepared response keeps its own authority when another poll advances the lease',async t=>{
  const f=await fixture(t);f.credit('overlapping-poll-canary');f.pin('overlapping-poll-canary');
  const reader={user:f.user.id,secret:f.secret,board:f.board};
  const old=await f.events.poll(reader,undefined);assert.ok(old&&old!=='limit');
  f.revoke();f.events.flush();
  const newer=await f.events.poll(reader,old.lease);assert.ok(newer&&newer!=='limit');
  const delivered=f.events.deliverPoll(old);
  assert.equal(JSON.stringify(delivered.frames).includes('overlapping-poll-canary'),false);
  assert.equal(delivered.frames.find(frame=>frame.type==='snapshot')&&JSON.parse(delivered.frames.find(frame=>frame.type==='snapshot')!.data).workAuthority,f.store.workKey(f.board));
  assert.deepEqual(f.events.deliverPoll(newer).frames,newer.frames);
});

test('delivery rechecking does not alter an unrelated subscriber or native reader',async t=>{
  const f=await fixture(t);f.credit('A');f.pin('A');
  const browser:PollAnswer['frames']=[],native:PollAnswer['frames']=[],reader={user:f.user.id,secret:f.secret,board:f.board,kind:'stream' as const,end:()=>{}};
  const ordinary=f.events.open({...reader,send:frames=>browser.push(...frames)}),background=f.events.open({...reader,desktop:true,send:frames=>native.push(...frames)});
  assert.ok(ordinary&&ordinary!=='limit');assert.ok(background&&background!=='limit');
  browser.length=0;native.length=0;
  const poll=await f.events.poll(reader,undefined);assert.ok(poll&&poll!=='limit');browser.length=0;native.length=0;
  f.pin('A','#d08770');const delivered=f.events.deliverPoll(poll);
  assert.equal(JSON.parse(delivered.frames.find(frame=>frame.type==='projectColors')!.data).pins[0][1],'#d08770');
  assert.equal(browser.length,0);assert.equal(native.length,0);
  f.events.flush();assert.ok(browser.some(frame=>frame.type==='projectColors'));assert.deepEqual(native,[]);
});
