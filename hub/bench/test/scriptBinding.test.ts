import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {panEvidenceScript,panTransactionsScript} from '../panEvidence.js';
import {ScriptBinding} from '../scriptBinding.js';
import {safeEvidence} from '../evidence.js';
import {tracePanning} from '../panningDiagnostic.js';
import type {Cdp} from '../cdp.js';

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

function traceFixture() {
  const listeners=new Map<string,Set<(value:unknown)=>void>>(),sent:string[]=[],files=new Map<string,any>();
  const emit=(name:string,value:unknown)=>{for(const listener of listeners.get(name)??[])listener(value);};
  const cdp={
    on:(name:string,listener:(value:unknown)=>void)=>{let set=listeners.get(name);if(!set)listeners.set(name,set=new Set());set.add(listener);},
    off:(name:string,listener:(value:unknown)=>void)=>{const set=listeners.get(name);set?.delete(listener);if(!set?.size)listeners.delete(name);},
    send:async(name:string)=>{sent.push(name);if(name==='Tracing.end')emit('Tracing.tracingComplete',{});return {metrics:[{name:'Timestamp',value:42}],body:'stand-in resource',base64Encoded:false};},
    evaluate:async()=>({now:7,timeOrigin:35}),
  } as unknown as Cdp;
  return {cdp,listeners,sent,files,emit,evidence:{save:(name:string,value:unknown)=>files.set(name,structuredClone(value)),saveTrace:(name:string,value:unknown)=>files.set(name,structuredClone(value))}};
}

test('source binding follows both original periods and final family cleanup, preserving evaluation values',async()=>{
  const f=traceFixture(),value={alias:true};
  const result=await tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    for(const family of [1,2,3]) {
      f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url:'http://private-canary.invalid/assets/'+client.name}});
      for(const period of [1,2]) {
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
        assert.equal(f.sent.filter(name=>name==='Tracing.start').length,(family-1)*2+period);
        assert.equal(f.sent.filter(name=>name==='Debugger.enable').length,family-1);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
        assert.equal(f.sent.filter(name=>name==='Debugger.enable').length,family-1);
      }
      const original=f.cdp.evaluate;f.cdp.evaluate=(async()=>value) as Cdp['evaluate'];
      assert.equal(await cdp.evaluate(`document.getElementById('quotum-pan-layout')?.remove()`),value);f.cdp.evaluate=original;
      const start=f.sent.lastIndexOf('Debugger.enable');assert.ok(start>f.sent.lastIndexOf('Tracing.end'));
      assert.deepEqual(f.files.get('source-family-'+family).intervals,[family*2-1,family*2]);
      assert.equal(f.files.get('source-family-'+family).status,'mismatch');
      assert.equal(f.files.get('source-family-'+family).debuggerDisabled,true);
    }
    return {reports:[],problems:[]};
  },client);
  assert.deepEqual(result,{reports:[],problems:[]});assert.equal(f.listeners.size,0);
  assert.equal(f.sent.filter(name=>name==='Tracing.start').length,6);assert.equal(f.sent.filter(name=>name==='Tracing.end').length,6);
});

test('failed-family binding follows trace cleanup and retains an unavailable source as unknown',async()=>{
  const f=traceFixture(),error=new Error('original scenario failed');
  await assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url:'http://private-canary.invalid/assets/'+client.name}});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await cdp.evaluate(`(()=>{document.getElementById('quotum-pan-layout')?.remove();})()`);
    throw error;
  },client),value=>value===error);
  assert.ok(f.sent.indexOf('Debugger.enable')>f.sent.indexOf('Tracing.end'));
  assert.equal(f.files.get('source-family-1').stage,'after-failed-family');
  assert.equal(f.files.get('source-family-1').status,'mismatch');assert.equal(f.listeners.size,0);
});

test('source-binding diagnostics never attach to another browser',async()=>{
  const f=traceFixture();await assert.rejects(tracePanning(f.cdp,{endpoint:'fixture',close:async()=>{}},f.evidence,async()=>({reports:[],problems:[]})),/owned synthetic/);
  assert.equal(f.sent.length,0);assert.equal(f.listeners.size,0);
});

function nativeSampler(initiator:string,period:string) {
  const source=ts.createSourceFile('panning.ts',readFileSync(new URL('../panning.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true),templates:ts.TemplateExpression[]=[];
  const visit=(node:ts.Node)=>{if(ts.isTemplateExpression(node)&&node.getText(source).includes('const probe=window.__quotumPan={'))templates.push(node);ts.forEachChild(node,visit);};
  visit(source);assert.equal(templates.length,1);
  const values:Record<string,string>={'JSON.stringify(initiator)':JSON.stringify(initiator),'JSON.stringify(period)':JSON.stringify(period),
    'panEvidenceScript(evidence?.timeline === true)':panEvidenceScript(true),'panTransactionsScript()':panTransactionsScript()};
  return templates[0].head.text+templates[0].templateSpans.map(span=>{const value=values[span.expression.getText(source)];assert.notEqual(value,undefined);return value+span.literal.text;}).join('');
}

test('native trace binds its actual sampler after both periods without reusing another family',async()=>{
  const f=traceFixture(),original=f.cdp.send,owners:{url:string;hash:string;scriptId:string}[]=[];
  f.cdp.send=(async(name:string,...args:unknown[])=>{
    if(name==='Debugger.enable')for(const event of [{url,hash,scriptId:'4'},...owners])f.emit('Debugger.scriptParsed',event);
    if(name==='Network.getResponseBody'){f.sent.push(name);return {body,base64Encoded:false};}
    return original(name,...args as [object]);
  }) as Cdp['send'];
  await tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    for(const [index,initiator]of ['activity','funds'].entries()){
      f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url}});
      const expected=[];owners.length=0;
      for(const [offset,period]of ['24h','30d'].entries()){
        const expression=nativeSampler(initiator,period),sourceHash=createHash('sha256').update(expression).digest('hex'),interval=index*2+offset+1;
        expected.push({interval,kind:'native-sampler',bytes:Buffer.byteLength(expression),sourceHash});owners.push({url:'',hash:sourceHash,scriptId:String(20+interval)});
        await cdp.evaluate(expression);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
        assert.equal(f.sent.filter(name=>name==='Debugger.enable').length,index);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
      }
      await cdp.evaluate(`document.getElementById('quotum-pan-layout')?.remove()`);
      const report=safeEvidence(f.files.get('source-family-'+(index+1))) as any;
      assert.equal(report.status,'complete');assert.equal(report.injected.status,'complete');assert.deepEqual(report.injected.expected,expected);
      assert.deepEqual(report.injected.owners.map((owner:any)=>[owner.scriptId,owner.intervals,owner.expectedHashMatches]),expected.map(value=>[20+value.interval,[value.interval],true]));
      assert.ok(f.sent.lastIndexOf('Debugger.enable')>f.sent.lastIndexOf('Tracing.end'));
      assert.doesNotMatch(JSON.stringify(report),/private-canary|scriptSource|__quotumPan/);
    }
    return {reports:[],problems:[]};
  },client);
  assert.equal(f.listeners.size,0);
  for(const method of ['Network.getResponseBody','Debugger.enable','Debugger.disable'])assert.equal(f.sent.filter(name=>name===method).length,2);
});

test('a failed native sampler installation preserves its error without remembering an owner',async()=>{
  const f=traceFixture(),error=new Error('sampler installation failed'),expression=nativeSampler('activity','24h');
  f.cdp.evaluate=(async()=>{throw error;}) as Cdp['evaluate'];
  await assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    await cdp.evaluate(expression);return {reports:[],problems:[]};
  },client),value=>value===error);
  assert.equal(f.files.has('source-injected-pending'),false);assert.deepEqual(f.sent,[]);assert.equal(f.listeners.size,0);
});

test('native postconditions remain in their original trace until the next setup command',async()=>{
  const f=traceFixture(),inputs:{method:string;params:object}[]=[],send=f.cdp.send;
  f.cdp.send=(async(method:string,params:object)=>{if(method.startsWith('Input.')||method.startsWith('Emulation.'))inputs.push({method,params});return send(method,params);}) as Cdp['send'];
  await tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    for(const id of [1,2]){
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      f.emit('Tracing.dataCollected',{value:[{name:'Paint',ph:'X',ts:id*10,dur:1}]});
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',deltaX:24,deltaY:0,modifiers:8});
      f.emit('Tracing.dataCollected',{value:[{name:'EventDispatch',ph:'X',ts:id*10+1,dur:1,args:{url:'private-canary'}}]});
      cdp.at?.('native/activity/'+(id===1?'24h':'30d')+'/complete');
      assert.equal(f.sent.filter(method=>method==='Tracing.end').length,id-1,'the synchronous boundary adds no command');
      await cdp.evaluate('next setup');
      f.emit('Tracing.dataCollected',{value:[{name:'Paint',ph:'X',ts:999,dur:1}]});
      assert.deepEqual(f.files.get('trace-'+id+'-trace').events.map((event:any)=>event.ts),[id*10,id*10+1]);
    }
    return {reports:[],problems:[]};
  });
  assert.deepEqual(inputs,[1,2].flatMap(()=>[
    {method:'Emulation.setCPUThrottlingRate',params:{rate:4}},
    {method:'Emulation.setCPUThrottlingRate',params:{rate:1}},
    {method:'Input.dispatchMouseEvent',params:{type:'mouseWheel',deltaX:24,deltaY:0,modifiers:8}},
  ]));
  assert.equal(f.listeners.size,0);assert.equal(f.sent.filter(method=>method==='Tracing.start').length,2);
  assert.doesNotMatch(JSON.stringify([...f.files.values()].map(value=>safeEvidence(value))),/private-canary/);
});

test('a failed native family binds its original sources after trace drain without replacing its error',async()=>{
  const f=traceFixture(),error=new Error('original held-wheel failure'),expression=nativeSampler('budget','30d'),probeHash=createHash('sha256').update(expression).digest('hex'),send=f.cdp.send;
  f.cdp.send=(async(method:string,...args:unknown[])=>{
    if(method==='Network.getResponseBody'){f.sent.push(method);return {body,base64Encoded:false};}
    if(method==='Debugger.enable')for(const event of [{url,hash,scriptId:'132'},{url:'',hash:probeHash,scriptId:'178'}])f.emit('Debugger.scriptParsed',event);
    return send(method,...args as [object]);
  }) as Cdp['send'];
  await assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url}});
    await cdp.evaluate(expression);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',deltaX:24,deltaY:0,modifiers:8});
    f.emit('Tracing.dataCollected',{value:[{name:'EventDispatch',ph:'X',ts:7,dur:1}]});
    throw error;
  },client),value=>value===error);
  const report=f.files.get('source-family-1');
  assert.equal(report?.stage,'after-failed-family');assert.equal(report?.status,'complete');assert.deepEqual(report?.intervals,[1]);
  assert.equal(report.injected.status,'complete');assert.deepEqual(report.injected.owners.map((owner:any)=>[owner.scriptId,owner.intervals,owner.expectedHashMatches]),[[178,[1],true]]);
  assert.deepEqual(f.files.get('trace-1-trace').events.map((event:any)=>event.ts),[7]);
  assert.ok(f.sent.indexOf('Debugger.enable')>f.sent.indexOf('Tracing.end'));
  assert.equal(f.sent.filter(method=>method==='Network.getResponseBody').length,1);
  assert.equal(f.listeners.size,0);assert.equal(f.files.has('source-injected-pending'),false);
  assert.doesNotMatch(JSON.stringify([...f.files.values()].map(value=>safeEvidence(value))),/private-canary|scriptSource|__quotumPan/);
});

for(const missing of ['Network.getResponseBody','Debugger.enable'])test(`failed-family ${missing} keeps its five-second deadline and original scenario error`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=traceFixture(),error=new Error('original held-wheel failure'),send=f.cdp.send;let reached=()=>{},aborted=false;
  const pending=new Promise<void>(resolve=>{reached=resolve;});
  f.cdp.send=(async(method:string,params:object,signal?:AbortSignal)=>{
    if(method!==missing)return send(method,params,signal);
    f.sent.push(method);reached();
    return new Promise((_,reject)=>signal!.addEventListener('abort',()=>{aborted=true;reject(signal!.reason);},{once:true}));
  }) as Cdp['send'];
  const outcome=assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url}});
    await cdp.evaluate(nativeSampler('budget','30d'));await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});throw error;
  },client),value=>value===error);
  await pending;t.mock.timers.tick(4999);assert.equal(aborted,false);t.mock.timers.tick(1);await outcome;
  assert.equal(aborted,true);assert.equal(f.sent.filter(method=>method===missing).length,1);
  const report=f.files.get('source-family-1');assert.equal(report.status,'unavailable');assert.equal(report.debuggerDisabled,true);
  assert.equal(report.injected.status,'unavailable');assert.equal(f.listeners.size,0);
});

for(const failed of [false,true])test(`an unconfirmed native trace drain prevents failed-family binding with ${failed?'an original input failure':'a boundary failure'}`,async()=>{
  const f=traceFixture(),error=new Error('original held-wheel failure'),send=f.cdp.send;let closed=0;
  f.cdp.send=(async(method:string,...args:unknown[])=>{
    if(method==='Tracing.end'){f.sent.push(method);throw new Error('trace drain failed');}
    return send(method,...args as [object]);
  }) as Cdp['send'];
  await assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{closed++;}},f.evidence,async cdp=>{
    f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url}});
    await cdp.evaluate(nativeSampler('budget','30d'));await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    if(failed)throw error;
    cdp.at?.('native/budget/30d/complete');await cdp.evaluate('next setup');
    assert.fail('a failed trace cannot enter the next setup');
  },client),value=>failed?value===error:value instanceof Error&&value.message==='diagnostic trace drain failed at end-command');
  assert.equal(closed,1);assert.equal(f.sent.includes('Debugger.enable'),false);assert.equal(f.sent.includes('Network.getResponseBody'),false);
  assert.equal(f.files.get('source-injected-pending').status,'unavailable');assert.equal(f.listeners.size,0);
});

test('failed-family debugger cleanup cannot retry the family or replace the original input failure',async()=>{
  const f=traceFixture(),error=new Error('original held-wheel failure'),send=f.cdp.send;
  f.cdp.send=(async(method:string,...args:unknown[])=>{
    if(method==='Debugger.disable'){f.sent.push(method);throw new Error('private-canary cleanup failure');}
    return send(method,...args as [object]);
  }) as Cdp['send'];
  await assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    f.emit('Network.responseReceived',{type:'Script',requestId:'private-canary',response:{url}});
    await cdp.evaluate(nativeSampler('budget','30d'));await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});throw error;
  },client),value=>value===error);
  assert.equal(f.sent.filter(method=>method==='Network.getResponseBody').length,1);
  assert.equal(f.sent.filter(method=>method==='Debugger.enable').length,1);assert.equal(f.sent.filter(method=>method==='Debugger.disable').length,2);
  assert.equal(f.files.get('source-family-1').debuggerDisabled,false);assert.equal(f.files.get('source-family-1').injected.status,'insufficient-evidence');
  assert.equal(f.files.has('source-injected-pending'),false);assert.equal(f.listeners.size,0);
  assert.doesNotMatch(JSON.stringify([...f.files.values()].map(value=>safeEvidence(value))),/private-canary/);
});
