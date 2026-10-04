import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bounded,observeReversal} from '../reversalDiagnostic.js';
import {Cdp,attachedChrome} from '../cdp.js';

test('diagnostic waiting is bounded independently of a silent page response',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const failed=assert.rejects(bounded('page pause',new Promise(()=>{})),/page pause: diagnostic deadline/);
  t.mock.timers.tick(5000);await failed;
});

test('a responsive diagnostic preserves its result or error and releases its deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  assert.deepEqual(await bounded('browser',Promise.resolve({responded:true})),{responded:true});
  const error=new Error('original failure');await assert.rejects(bounded('browser',Promise.reject(error)),candidate=>candidate===error);
  t.mock.timers.tick(5000);
});

test('the original stalled page is diagnosed without pre-enabling V8 and a recovered input cannot pass',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://fixture.invalid'})));
  let controlClosed=false;
  const control={send:async()=>({processInfo:[{type:'renderer',id:1,cpuTime:1}]}),close:()=>{controlClosed=true;}};
  t.mock.method(Cdp,'connect',async()=>control as unknown as Cdp);
  const messages:unknown[]=[],commands:string[]=[];
  t.mock.method(console,'error',(message:unknown)=>{messages.push(message);});
  let paused:((event:{callFrames:[]})=>void)|undefined,releaseInput!:()=>void;
  const input=new Promise<void>(resolve=>{releaseInput=resolve;});
  const page={on:(_method:string,listener:typeof paused)=>{paused=listener;},send:async(method:string)=>{
    commands.push(method);
    if(method==='Debugger.pause')paused?.({callFrames:[]});
    if(method==='Profiler.stop'){releaseInput();return {profile:{nodes:[],samples:[],timeDeltas:[]}};}
    return {};
  }};
  const observer=await observeReversal(page as unknown as Cdp,attachedChrome('http://fixture.invalid'),false);
  assert.equal(commands.length,0,'the canonical input must start before any V8 diagnostics');
  const failed=assert.rejects(observer.watch('repeat wheel',()=>input),/response required diagnostic intervention/);
  t.mock.timers.tick(5000);await failed;await observer.close();
  assert.ok(commands.includes('Debugger.pause'));
  assert.ok(messages.some(message=>String(message).includes('"activation":"after stall"')));
  assert.equal(controlClosed,true);
});
