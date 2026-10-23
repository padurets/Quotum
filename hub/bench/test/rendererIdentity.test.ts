import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RunOwner} from '../runOwner.js';
import {rendererIdentity,rendererDocument,type RendererPage,type RendererBrowser} from '../rendererIdentity.js';
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

function documentProof(m:ReturnType<typeof mock>,commit=true){
  const proof=rendererDocument(m.cdp);
  m.emit('Page.frameStartedNavigating',{frameId:'frame',loaderId:'loader',navigationType:'differentDocument',url:'https://private-url-must-not-leak'});
  proof.pin({frameId:'frame',loaderId:'loader'});
  if(commit)m.emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'loader'}});
  return proof;
}
test('late binding uses the original session trace, owned birth and no renderer commands',async()=>{
  const m=mock(),proof=documentProof(m),h=await rendererIdentity(m.cdp,m.browser,undefined,proof);
  assert.equal(h.valid(),true);assert.equal(h.pid,101);assert.equal(h.birth,'1001');
  assert.deepEqual(m.calls,['Inspector.enable','Tracing.start','Tracing.end']);assert.ok(!JSON.stringify(h.evidence()).includes('private-url'));
  await h.dispose();assert.equal(m.listeners(),0);assert.equal(proof.valid(),false);await m.owner.close();
});
test('the initial original navigation needs observed start, matching reply and committed loader',async()=>{
  for(const mode of ['no-start','no-pin','no-commit','wrong-frame','wrong-loader','error-reply','missing-reply','commit-before-start','parent','duplicate-commit','duplicate-pin']){
    const m=mock(),proof=rendererDocument(m.cdp);
    const commit={frame:{id:'frame',loaderId:'loader',...(mode==='parent'?{parentId:'foreign'}:{})}};
    if(mode==='commit-before-start')m.emit('Page.frameNavigated',commit);
    if(mode!=='no-start')m.emit('Page.frameStartedNavigating',{frameId:'frame',loaderId:'loader',navigationType:'differentDocument'});
    if(mode!=='no-pin')proof.pin(mode==='missing-reply'?undefined:{frameId:mode==='wrong-frame'?'foreign':'frame',loaderId:mode==='wrong-loader'?'other':'loader',...(mode==='error-reply'?{errorText:'private-url'}:{})});
    if(mode==='duplicate-pin')proof.pin({frameId:'frame',loaderId:'loader'});
    if(mode!=='no-commit')m.emit('Page.frameNavigated',commit);
    if(mode==='duplicate-commit')m.emit('Page.frameNavigated',commit);
    const h=await rendererIdentity(m.cdp,m.browser,undefined,proof);
    assert.equal(h.valid(),false,mode);assert.equal(h.pid,null);assert.ok(!m.calls.includes('Tracing.start'),mode);await h.dispose();assert.equal(m.listeners(),0);await m.owner.close();
  }
});
test('any subsequent navigation start invalidates even matching same-document events',async()=>{
  for(const navigationType of ['sameDocument','historySameDocument']){
    const m=mock(),proof=documentProof(m),h=await rendererIdentity(m.cdp,m.browser,undefined,proof);
    m.emit('Page.frameStartedNavigating',{frameId:'frame',loaderId:'loader',navigationType});
    assert.equal(h.valid(),false);assert.equal(h.pid,null);await h.dispose();assert.equal(m.listeners(),0);await m.owner.close();
  }
  const cases:unknown[]=[null,{}, {frameId:'frame',loaderId:'loader',navigationType:'unknown'},
    ...['reload','reloadBypassingCache','restore','restoreWithPost','historyDifferentDocument','differentDocument'].map(navigationType=>({frameId:'frame',loaderId:'loader',navigationType})),
    {frameId:'foreign',loaderId:'loader',navigationType:'sameDocument'},{frameId:'frame',loaderId:'other',navigationType:'historySameDocument'}];
  for(const value of cases){
    const m=mock(),proof=documentProof(m),h=await rendererIdentity(m.cdp,m.browser,undefined,proof);
    assert.equal(h.valid(),true);m.emit('Page.frameStartedNavigating',value);assert.equal(h.valid(),false);assert.equal(h.pid,null);assert.equal(h.birth,null);assert.equal(h.evidence().status,'unknown');
    await h.dispose();assert.equal(m.listeners(),0);await m.owner.close();
  }
});
test('an inflight second navigation and a cross-document commit during the trace prevent publication',async()=>{
  for(const when of ['before-trace','during-trace']){
    const m=mock(),proof=documentProof(m),send=m.cdp.send.bind(m.cdp);
    const invalidate=()=>m.emit('Page.frameStartedNavigating',{frameId:'frame',loaderId:'other',navigationType:'reload'});
    if(when==='before-trace')invalidate();
    else m.cdp.send=async function<T>(name:string,params:object,signal?:AbortSignal):Promise<T>{const value=await send<T>(name,params,signal);if(name==='Tracing.end')invalidate();return value;};
    const h=await rendererIdentity(m.cdp,m.browser,undefined,proof);assert.equal(h.valid(),false,when);assert.equal(h.pid,null);await h.dispose();assert.equal(m.listeners(),0);await m.owner.close();
  }
});
test('a proof from a different CDP connection cannot bind another session',async()=>{
  const original=mock(),other=mock(),proof=documentProof(original),h=await rendererIdentity(other.cdp,other.browser,undefined,proof);
  assert.equal(h.valid(),false);assert.equal(h.pid,null);assert.ok(!other.calls.includes('Tracing.start'));await h.dispose();assert.equal(original.listeners(),0);assert.equal(other.listeners(),0);await original.owner.close();await other.owner.close();
});
for(const mode of ['wrong-pid','multiple-pid','omission','loss','changed-birth','start-fail','end-fail','cancel','drain-fail'])test('late binding preserves trace/ownership/cancellation rejection: '+mode,async()=>{
  const m=mock(mode),proof=documentProof(m),h=await rendererIdentity(m.cdp,m.browser,undefined,proof);
  assert.equal(h.valid(),false);assert.equal(h.pid,null);assert.equal(m.listeners(),0);await h.dispose();await m.owner.close().catch(()=>{});
});
