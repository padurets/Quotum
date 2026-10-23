import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RunOwner} from '../runOwner.js';
import {rendererIdentity,type RendererPage,type RendererBrowser} from '../rendererIdentity.js';
import type {ProcessIdentity} from '../browserProcess.js';

function mock(mode='ok'){
  const owner=new RunOwner(),events=new Map<string,Set<(value:unknown)=>void>>(),calls:string[]=[];let reads=0;
  const emit=(name:string,value:unknown)=>{for(const f of [...(events.get(name)??[])])f(value);};
  const cdp:RendererPage={on<T>(name:string,f:(value:T)=>void){if(!events.has(name))events.set(name,new Set());events.get(name)!.add(f as (value:unknown)=>void);},off<T>(name:string,f:(value:T)=>void){events.get(name)?.delete(f as (value:unknown)=>void);},
    async send<T>(name:string,_params:object,signal?:AbortSignal):Promise<T>{
      signal?.throwIfAborted();calls.push(name);
      if(mode==='cancel'&&name==='Tracing.start'){queueMicrotask(()=>{void owner.close().catch(()=>{});});return new Promise<T>((_,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));}
      if(mode==='start-fail'&&name==='Tracing.start')throw Error('private-url-must-not-leak');
      if(mode==='end-fail'&&name==='Tracing.end')throw Error('end failed');
      if(name==='Page.getFrameTree')return {frameTree:{frame:{id:mode==='changed-frame'&&++reads>1?'changed':'frame',loaderId:'loader'}}} as T;
      if(name==='Tracing.end'){
        const row={frame:mode==='wrong-frame'?'foreign':'frame',processId:mode==='wrong-pid'?999:101,isOutermostMainFrame:true,isInPrimaryMainFrame:mode!=='nonprimary',url:'https://private-url-must-not-leak'};
        const frames=mode==='multiple-pid'?[row,{...row,processId:102}]:mode==='omission'?Array(33).fill(row):[row];
        emit('Tracing.dataCollected',{value:[{name:'TracingStartedInBrowser',args:{data:{frames}}}]});
        if(mode==='navigation')emit('Page.frameNavigated',{});
        if(mode!=='drain-fail')emit('Tracing.tracingComplete',mode==='missing-loss'?{}:{dataLossOccurred:mode==='loss'});
      }
      return {} as T;
    }};
  const browser:RendererBrowser={owned:true,owner,launchReport:()=>({pid:100}),observeProcesses:async():Promise<ProcessIdentity[]>=>[
    {pid:101,birth:mode==='changed-birth'&&++reads>1?'2002':'1001',group:mode==='foreign-group'?99:100,session:100,state:'S',parent:100,minorFaults:null,majorFaults:null,userTicks:null,systemTicks:null,blockIoTicks:null}]};
  return {owner,cdp,browser,emit,calls,listeners:()=>[...events.values()].reduce((n,s)=>n+s.size,0)};
}

test('unique primary owned mapping pins birth and keeps only passive lifetime invalidation',async()=>{
  const m=mock(),h=await rendererIdentity(m.cdp,m.browser);assert.equal(h.valid(),true);assert.equal(h.pid,101);assert.equal(h.birth,'1001');
  assert.equal(m.calls.filter(x=>x==='Tracing.start').length,1);assert.equal(m.calls.filter(x=>x==='Tracing.end').length,1);
  assert.equal(JSON.stringify(h.evidence()).includes('private-url'),false);await h.dispose();assert.equal(h.pid,null);assert.equal(m.listeners(),0);await m.owner.close();
});
for(const mode of ['wrong-frame','wrong-pid','multiple-pid','nonprimary','omission','loss','missing-loss','navigation','changed-frame','changed-birth','foreign-group','start-fail','end-fail'])test('UNKNOWN without fallback: '+mode,async()=>{
  const m=mock(mode),h=await rendererIdentity(m.cdp,m.browser);assert.equal(h.valid(),false);assert.equal(h.pid,null);assert.equal(m.listeners(),0);
  assert.equal(JSON.stringify(h.evidence()).includes('private-url'),false);if(mode==='start-fail')assert.equal(m.calls.includes('Tracing.end'),false);
  await h.dispose();await m.owner.close().catch(()=>{});
});
test('cancellation never ends an unconfirmed start or publishes a late mapping',async()=>{
  const m=mock('cancel'),h=await rendererIdentity(m.cdp,m.browser);assert.equal(h.valid(),false);assert.equal(h.evidence().mustCloseOwner,true);assert.equal(m.calls.includes('Tracing.end'),false);assert.equal(m.listeners(),0);await m.owner.close().catch(()=>{});
});
test('missing trace drain exhausts the same two-second budget and removes listeners',async()=>{
  const m=mock('drain-fail'),start=performance.now(),h=await rendererIdentity(m.cdp,m.browser);assert.equal(h.valid(),false);assert.ok(performance.now()-start<2300);assert.equal(h.evidence().mustCloseOwner,true);assert.equal(m.listeners(),0);await m.owner.close().catch(()=>{});
});
test('navigation or crash after success invalidates the binding until disposal',async()=>{
  for(const event of ['Page.frameNavigated','Page.frameDetached','Inspector.targetCrashed','Inspector.detached']){
    const m=mock(),h=await rendererIdentity(m.cdp,m.browser);assert.equal(h.valid(),true);m.emit(event,{});assert.equal(h.valid(),false);assert.equal(h.pid,null);await h.dispose();assert.equal(m.listeners(),0);await m.owner.close();
  }
});
test('cancellation after publication removes every listener and exposes no current PID',async()=>{
  const m=mock(),abort=new AbortController(),h=await rendererIdentity(m.cdp,m.browser,abort.signal);
  assert.equal(h.valid(),true);abort.abort();await h.dispose();assert.equal(h.pid,null);assert.equal(m.listeners(),0);await m.owner.close();
});
