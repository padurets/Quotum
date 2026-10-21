import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ScriptBinding} from '../scriptBinding.js';
import {safeEvidence} from '../evidence.js';

const body='/* private-canary */ globalThis.bound=true;',hash=createHash('sha256').update(body).digest('hex');
const url='http://private-canary.invalid/assets/index-test.js?private-canary',client={status:'available' as const,name:'index-test.js',bytes:Buffer.byteLength(body),sha256:hash};
const sampler='/* private-canary */ const nativeSampler=true;',samplerHash=createHash('sha256').update(sampler).digest('hex');
function fixture(parsed:unknown[]=[{url,hash,scriptId:'4'}],reply:unknown={body,base64Encoded:false}) {
  const listeners=new Map<string,Set<(value:unknown)=>void>>(),sent:string[]=[],files=new Map<string,unknown>();
  const emit=(name:string,value:unknown)=>{for(const listener of listeners.get(name)??[])listener(value);};
  const cdp={
    on:(name:string,listener:(value:unknown)=>void)=>{let set=listeners.get(name);if(!set)listeners.set(name,set=new Set());set.add(listener);},
    off:(name:string,listener:(value:unknown)=>void)=>{const set=listeners.get(name);set?.delete(listener);if(!set?.size)listeners.delete(name);},
    send:async(name:string)=>{sent.push(name);if(name==='Debugger.enable')for(const event of parsed)emit('Debugger.scriptParsed',event);return name==='Network.getResponseBody'?reply:{};},
  };
  const binding=new ScriptBinding(cdp as never,client,(name,value)=>files.set(name,structuredClone(value)));
  const receive=()=>emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url}});
  const report=()=>files.get('source-family-1') as any;
  return {cdp,listeners,sent,files,binding,receive,report,emit};
}

test('received body and parsed owner both match, with bounded numeric private-free export',async()=>{
  const f=fixture();f.receive();await f.binding.afterFamily([1,2]);const r=f.report();
  assert.equal(r.status,'complete');assert.equal(r.bytes,Buffer.byteLength(body));assert.equal(r.clientHash,hash);assert.equal(r.receivedHash,hash);
  assert.deepEqual(r.owners,[{scriptId:4,parsedHash:hash,receivedAssetHashMatches:true}]);assert.equal(r.debuggerDisabled,true);
  assert.deepEqual(f.sent,['Network.getResponseBody','Debugger.enable','Debugger.disable']);
  assert.doesNotMatch(JSON.stringify(safeEvidence(r)),/private-canary|requestId|url|scriptSource/);
  f.binding.close();assert.equal(f.listeners.size,0);
});

test('binary response preserves the received byte hash',async()=>{
  const f=fixture(undefined,{body:Buffer.from(body).toString('base64'),base64Encoded:true});f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'complete');f.binding.close();
});

test('successful injected sources bind separately from the received client',async()=>{
  const second=sampler+'\n',secondHash=createHash('sha256').update(second).digest('hex');
  const f=fixture([{url,hash,scriptId:'4'},{url:'',hash:samplerHash,scriptId:'21'},{url:'',hash:secondHash,scriptId:'22'}]);
  f.binding.rememberInjected(1,sampler);f.binding.rememberInjected(2,second);f.receive();await f.binding.afterFamily([1,2]);
  const r=f.report();assert.equal(r.status,'complete');assert.equal(r.injected.status,'complete');
  assert.deepEqual(r.injected.owners.map((owner:any)=>[owner.scriptId,owner.parsedHash,owner.intervals,owner.expectedHashMatches]),[[21,samplerHash,[1],true],[22,secondHash,[2],true]]);
  const saved=safeEvidence(r) as any;assert.equal(saved.injected.status,'complete');assert.equal(saved.injected.expected[0].sourceHash,samplerHash);
  assert.deepEqual(saved.injected.owners[0].intervals,[1]);assert.doesNotMatch(JSON.stringify(saved),/private-canary|scriptSource/);
  assert.deepEqual(f.sent,['Network.getResponseBody','Debugger.enable','Debugger.disable']);f.binding.close();
});

test('missing and conflicting injected owners remain unknown without changing the client verdict',async()=>{
  const other='1'.repeat(64);
  for(const owners of [[],[{url:'',hash:samplerHash,scriptId:'21'},{url:'',hash:other,scriptId:'21'}],[{url:'',hash:other,scriptId:'21'},{url:'',hash:samplerHash,scriptId:'21'}]]){
    const f=fixture([{url,hash,scriptId:'4'},...owners]);f.binding.rememberInjected(1,sampler);f.receive();await f.binding.afterFamily([1]);
    const r=f.report();assert.equal(r.status,'complete');assert.equal(r.injected.status,'insufficient-evidence');assert.deepEqual(r.injected.unmatchedIntervals,[1]);
    assert.ok(r.injected.owners.every((owner:any)=>!owner.expectedHashMatches));
    f.receive();await f.binding.afterFamily([2]);assert.equal((f.files.get('source-family-2')as any).injected.status,'not-requested');
    assert.deepEqual(f.sent,['Network.getResponseBody','Debugger.enable','Debugger.disable','Network.getResponseBody','Debugger.enable','Debugger.disable']);f.binding.close();
  }
});

test('an injected owner beyond the anonymous limit cannot retain a positive match',async()=>{
  const unrelated=Array.from({length:256},(_,i)=>({url:'',hash:'0'.repeat(64),scriptId:String(i+10)}));
  const f=fixture([{url,hash,scriptId:'4'},...unrelated,{url:'',hash:samplerHash,scriptId:'300'},{url:'',hash:'1'.repeat(64),scriptId:'300'}]);
  f.binding.rememberInjected(1,sampler);f.receive();await f.binding.afterFamily([1]);const r=f.report();
  assert.equal(r.status,'complete');assert.equal(r.injected.status,'insufficient-evidence');assert.equal(r.injected.omittedAnonymous,2);
  assert.equal(r.injected.owners[0].expectedHashMatches,false);assert.deepEqual(r.injected.unmatchedIntervals,[1]);
  assert.deepEqual(f.sent,['Network.getResponseBody','Debugger.enable','Debugger.disable']);f.binding.close();
});

test('matching expected body cannot credit a different parsed hash or URL',async()=>{
  for(const parsed of [[{url,hash:'0'.repeat(64),scriptId:'4'}],[{url:url+'&other',hash,scriptId:'4'}]]){
    const f=fixture(parsed);f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'mismatch');assert.ok(f.report().owners.every((v:any)=>!v.receivedAssetHashMatches));f.binding.close();
  }
});

test('a matching parsed hash cannot credit different received bytes',async()=>{
  const f=fixture(undefined,{body:body+' ',base64Encoded:false});f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'mismatch');assert.equal(f.report().receivedAssetHashMatches,false);assert.equal(f.report().owners[0].receivedAssetHashMatches,false);f.binding.close();
});

test('invalid owner IDs and digest fields never qualify',async()=>{
  const parsed=[...['0','04','-1','1.5',4,'9007199254740992'].map(scriptId=>({url,hash,scriptId})),{url,hash:'private-canary',scriptId:'4'}];
  const f=fixture(parsed);f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'mismatch');assert.deepEqual(f.report().owners,[]);f.binding.close();
});

test('conflicting owner hashes cannot retain a positive individual owner',async()=>{
  const f=fixture([{url,hash,scriptId:'4'},{url,hash:'0'.repeat(64),scriptId:'4'}]);f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'mismatch');assert.equal(f.report().conflicts,1);assert.equal(f.report().owners[0].receivedAssetHashMatches,false);f.binding.close();
});

test('unobserved resource and another family cannot reuse an earlier match',async()=>{
  const f=fixture();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'unavailable');assert.equal(f.report().debuggerDisabled,true);assert.deepEqual(f.sent,[]);
  f.receive();await f.binding.afterFamily([3,4]);assert.equal((f.files.get('source-family-2')as any).status,'complete');
  await f.binding.afterFamily([5,6]);assert.equal((f.files.get('source-family-3')as any).status,'unavailable');assert.equal(f.sent.length,3);f.binding.close();
});

test('non-script responses and a different resource never enable the debugger',async()=>{
  const f=fixture();for(const value of [{type:'Fetch',requestId:'private-canary',response:{url}},{type:'Script',requestId:'private-canary',response:{url:'http://private-canary.invalid/assets/other.js'}}])f.emit('Network.responseReceived',value);
  await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'unavailable');assert.deepEqual(f.sent,[]);f.binding.close();
});

test('request and owner limits fail qualification instead of silently dropping rows',async()=>{
  const f=fixture();for(let i=0;i<33;i++)f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'unavailable');assert.equal(f.report().omitted,1);assert.deepEqual(f.sent,[]);f.binding.close();
  const g=fixture(Array.from({length:33},(_,i)=>({url,hash,scriptId:String(i+1)})));g.receive();await g.binding.afterFamily([1,2]);assert.equal(g.report().status,'mismatch');assert.equal(g.report().omittedOwners,1);assert.equal(g.report().owners.length,32);g.binding.close();
});

test('malformed or oversized response bodies never enter the debugger',async()=>{
  for(const reply of [{body:4,base64Encoded:false},{body,base64Encoded:'private-canary'},{body:'x'.repeat(4*1024*1024+1),base64Encoded:false}]){
    const f=fixture(undefined,reply);f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'unavailable');assert.deepEqual(f.sent,['Network.getResponseBody']);assert.equal(f.report().debuggerDisabled,true);f.binding.close();
  }
});

test('a lost enable acknowledgement still disables the possibly enabled debugger',async()=>{
  const f=fixture(),original=f.cdp.send;f.cdp.send=async name=>{if(name==='Debugger.enable'){f.sent.push(name);throw Error('private-canary');}return original(name);};
  f.receive();await f.binding.afterFamily([1,2]);assert.equal(f.report().status,'unavailable');assert.equal(f.report().debuggerDisabled,true);assert.equal(f.sent.at(-1),'Debugger.disable');f.binding.close();
});

test('an unconfirmed disable stops the next measured family',async()=>{
  const f=fixture(),original=f.cdp.send;f.cdp.send=async name=>{if(name==='Debugger.disable'){f.sent.push(name);throw Error('private-canary');}return original(name);};
  f.receive();await assert.rejects(f.binding.afterFamily([1,2]),/cleanup unconfirmed/);assert.equal(f.report().status,'unavailable');assert.equal(f.report().debuggerDisabled,false);assert.equal(f.sent.filter(v=>v==='Debugger.disable').length,2);f.binding.close();assert.equal(f.listeners.size,0);
});

test('a missing body acknowledgement is cancelled at the diagnostic deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();let aborted=false,reached=()=>{};const pending=new Promise<void>(resolve=>{reached=resolve;});
  f.cdp.send=((name:string,_params:object,signal:AbortSignal)=>{f.sent.push(name);reached();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));})as any;
  f.receive();const result=f.binding.afterFamily([1,2]);await pending;t.mock.timers.tick(5000);await result;
  assert.equal(aborted,true);assert.equal(f.report().status,'unavailable');assert.equal(f.report().debuggerDisabled,true);assert.deepEqual(f.sent,['Network.getResponseBody']);f.binding.close();assert.equal(f.listeners.size,0);
});


test('cancelled post-window binding starts no source or debugger command',async()=>{
  const f=fixture(),abort=new AbortController();f.receive();abort.abort();
  await f.binding.afterFamily([1],'after-family',abort.signal);
  assert.equal(f.report().status,'unavailable');assert.equal(f.report().debuggerDisabled,true);assert.deepEqual(f.sent,[]);f.binding.close();
});
