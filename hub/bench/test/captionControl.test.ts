import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Cdp} from '../cdp.js';
import {CaptionAssets,captionControl,loadCaptionBaseline} from '../captionControl.js';

test('rollback files require both the production byte count and digest',()=>{
  const folder=mkdtempSync(path.join(os.tmpdir(),'quotum-caption-test-'));
  try{
    const file=path.join(folder,'index-Dh2ec57X.js');
    writeFileSync(file,'wrong size');assert.throws(()=>loadCaptionBaseline(folder),/client identity mismatch/);
    writeFileSync(file,Buffer.alloc(1_172_081));assert.throws(()=>loadCaptionBaseline(folder),/client identity mismatch/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

function fixture(body='unrecognized client',failDisable=false,candidate=true) {
  const listeners=new Map<string,Set<(event:unknown)=>void>>(),commands:{method:string;params:unknown}[]=[];
  const cdp={
    on:(method:string,listener:(event:unknown)=>void)=>{let set=listeners.get(method);if(!set)listeners.set(method,set=new Set());set.add(listener);},
    off:(method:string,listener:(event:unknown)=>void)=>{listeners.get(method)?.delete(listener);if(!listeners.get(method)?.size)listeners.delete(method);},
    send:async(method:string,params:unknown)=>{commands.push({method,params});if(method==='Fetch.getResponseBody')return{body,base64Encoded:false};if(method==='Fetch.disable'&&failDisable)throw new Error('disable failed');return{};},
    evaluate:async()=>undefined,
  } as unknown as Cdp;
  const abort=new AbortController(),assets=new CaptionAssets(cdp,'http://fixture.invalid',candidate,abort.signal,{client:'unrecognized baseline',style:'unrecognized baseline'});
  const pause=()=>{for(const listener of listeners.get('Fetch.requestPaused')??[])listener({requestId:'own',request:{url:'http://fixture.invalid/assets/index-B3XdTJFg.js'},responseStatusCode:200});};
  return{cdp,assets,listeners,commands,abort,pause};
}

test('a mismatched received body releases the paused response and cannot bind or fulfill',async()=>{
  for(const candidate of [false,true]){
    const f=fixture(undefined,false,candidate);await f.assets.install();f.pause();
    await assert.rejects(f.assets.bind(),/upstream identity mismatch/);
    assert.ok(f.commands.some(row=>row.method==='Fetch.failRequest'));
    assert.ok(!f.commands.some(row=>row.method==='Fetch.fulfillRequest'||row.method==='Debugger.getScriptSource'));
    assert.deepEqual(f.assets.received,[]);assert.equal(f.assets.ready,false);
    await f.assets.close(f.abort.signal);assert.equal(f.listeners.size,0);
    assert.equal(f.commands.at(-1)?.method,'Fetch.disable');
  }
});

test('an unconfirmed Fetch disable still removes target listeners and remains a failure',async()=>{
  const f=fixture('',true);await f.assets.install();
  await assert.rejects(f.assets.close(f.abort.signal),/disable failed/);
  assert.equal(f.listeners.size,0);assert.equal(f.assets.ready,false);
});

test('an unexpected candidate identity is rejected before baseline or target access',async()=>{
  const f=fixture();
  await assert.rejects(captionControl(f.cdp,'http://fixture.invalid',{save:()=>{}},'0c166f884d27deac577f54b7a4ec32e2eb8c13ddb87968f6f486c0cdef715e63'),/exact candidate client/);
  assert.deepEqual(f.commands,[]);assert.equal(f.listeners.size,0);
});

test('a missing baseline directory never starts the target or reads unrelated fixtures',async()=>{
  const previous=process.env.QUOTUM_BENCH_CAPTION_BASELINE_DIR,f=fixture();
  delete process.env.QUOTUM_BENCH_CAPTION_BASELINE_DIR;
  try{
    await assert.rejects(captionControl(f.cdp,'http://fixture.invalid',{save:()=>{}},'16ead23988b0712c6b064794792a708637c10d2d1008c7ebcf6bf6a2a46c6dd4'),/baseline assets directory required/);
    assert.deepEqual(f.commands,[]);assert.equal(f.listeners.size,0);
  }finally{
    if(previous===undefined)delete process.env.QUOTUM_BENCH_CAPTION_BASELINE_DIR;
    else process.env.QUOTUM_BENCH_CAPTION_BASELINE_DIR=previous;
  }
});
