import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Cdp} from '../cdp.js';
import {CaptionAssets,captionControl,patchCaption} from '../captionControl.js';

test('caption replacement uses UTF16 offsets and preserves all surrounding code',()=>{
  const prefix='😀'.repeat(552_592)+'x',before='i??(e?al(e):fl(dl(t)))',suffix='; unchanged();';
  assert.equal(prefix.length,1_105_185);
  const changed=patchCaption(prefix+before+suffix);
  assert.ok(changed.startsWith(prefix));assert.ok(changed.endsWith(suffix));
  assert.ok(changed.includes("frame?.input!=='wheel'"));
  assert.ok(changed.includes('const computed=('+before+')'));
  assert.throws(()=>patchCaption(prefix+'wrong expression'+suffix),/expression mismatch/);
});

function fixture(body='unrecognized client',failDisable=false) {
  const listeners=new Map<string,Set<(event:unknown)=>void>>(),commands:{method:string;params:unknown}[]=[];
  const cdp={
    on:(method:string,listener:(event:unknown)=>void)=>{let set=listeners.get(method);if(!set)listeners.set(method,set=new Set());set.add(listener);},
    off:(method:string,listener:(event:unknown)=>void)=>{listeners.get(method)?.delete(listener);if(!listeners.get(method)?.size)listeners.delete(method);},
    send:async(method:string,params:unknown)=>{commands.push({method,params});if(method==='Fetch.getResponseBody')return{body,base64Encoded:false};if(method==='Fetch.disable'&&failDisable)throw new Error('disable failed');return{};},
    evaluate:async()=>undefined,
  } as unknown as Cdp;
  const abort=new AbortController(),assets=new CaptionAssets(cdp,'http://fixture.invalid',true,abort.signal);
  const pause=()=>{for(const listener of listeners.get('Fetch.requestPaused')??[])listener({requestId:'own',request:{url:'http://fixture.invalid/assets/index-Dh2ec57X.js'},responseStatusCode:200});};
  return{cdp,assets,listeners,commands,abort,pause};
}

test('a mismatched received body releases the paused response and cannot bind or fulfill',async()=>{
  const f=fixture();await f.assets.install();f.pause();
  await assert.rejects(f.assets.bind(),/upstream identity mismatch/);
  assert.ok(f.commands.some(row=>row.method==='Fetch.failRequest'));
  assert.ok(!f.commands.some(row=>row.method==='Fetch.fulfillRequest'||row.method==='Debugger.getScriptSource'));
  assert.deepEqual(f.assets.received,[]);assert.equal(f.assets.ready,false);
  await f.assets.close(f.abort.signal);assert.equal(f.listeners.size,0);
  assert.equal(f.commands.at(-1)?.method,'Fetch.disable');
});

test('an unconfirmed Fetch disable still removes target listeners and remains a failure',async()=>{
  const f=fixture('',true);await f.assets.install();
  await assert.rejects(f.assets.close(f.abort.signal),/disable failed/);
  assert.equal(f.listeners.size,0);assert.equal(f.assets.ready,false);
});

test('asynchronous page exceptions stay bounded and cleanup preserves the first setup failure',async t=>{
  const f=fixture(),send=f.cdp.send.bind(f.cdp);
  t.mock.method(console,'log',()=>{});
  t.mock.method(f.cdp,'send',async<T>(method:string,params:object={})=>{
    if(method==='Browser.getVersion')return {product:'Chrome/test',revision:'test',jsVersion:'test'} as T;
    if(method==='Runtime.enable')for(let i=0;i<9;i++)for(const listener of f.listeners.get('Runtime.exceptionThrown')??[])listener({timestamp:i,exceptionDetails:{lineNumber:1,columnNumber:2,executionContextId:3,get text(){throw Error('private canary must not be read');}}});
    if(method==='Page.reload')throw Error('controlled setup failure');
    return send<T>(method,params);
  });
  t.mock.method(f.cdp,'evaluate',async<T>(expression:string)=>{
    if(expression.includes('url:location.href'))return {prefs:null,locale:null,url:'http://fixture.invalid/'} as T;
    return 'auto' as T;
  });
  f.cdp.at=()=>{};f.cdp.snapshot=()=>({}) as ReturnType<Cdp['snapshot']>;
  const result=await captionControl(f.cdp,'http://fixture.invalid',{save:()=>{}},'0c166f884d27deac577f54b7a4ec32e2eb8c13ddb87968f6f486c0cdef715e63');
  assert.equal(result.status,'insufficient-evidence');assert.equal(result.arms.length,1);
  const arm=result.arms[0];assert.equal(arm.exceptionCount,9);assert.equal(arm.exceptions.length,8);assert.equal(arm.omittedExceptions,1);
  assert.equal(arm.reason,'controlled setup failure');assert.doesNotMatch(JSON.stringify(arm.exceptions),/canary|"text"|"stack"/);
  assert.equal(f.listeners.size,0);assert.ok(f.commands.some(row=>row.method==='Runtime.disable'));
  assert.ok(f.commands.some(row=>row.method==='Fetch.disable'));
});
