import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RunOwner} from '../runOwner.js';
import {rendererIdentity,rendererDocument,historyRendererIdentity,networkRendererProfile,type RendererPage,type RendererBrowser,type RendererResolution} from '../rendererIdentity.js';
import type {ProcessIdentity} from '../browserProcess.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {deadline} from '../deadline.js';
import {accountingPath} from '../accountingTraffic.js';
import {HISTORY_ATTEMPT_HEADER} from '../historyProxy.js';
import {safeEvidence} from '../evidence.js';

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

// Execute the production producer with controlled OS reads and a monotonic host clock.
function networkFixture(mode='ok'){
  const m=mock(),proof=documentProof(m),source=ts.createSourceFile('rendererIdentity.ts',readFileSync(new URL('../rendererIdentity.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='historyRendererIdentity')!;
  let now=10,scans=0,links=0,finishScan!:(rows:ProcessIdentity[])=>void;const linkPaths:string[]=[];
  const rows:ProcessIdentity[]=[{pid:100,parent:1,group:100,session:100,birth:'1000',state:'S',minorFaults:null,majorFaults:null,userTicks:null,systemTicks:null,blockIoTicks:null},
    {pid:101,parent:100,group:100,session:100,birth:'1001',state:'S',minorFaults:null,majorFaults:null,userTicks:null,systemTicks:null,blockIoTicks:null}];
  m.browser.launchReport=()=>({pid:100,version:mode==='wrong-version'?'Chrome/155.0.8059.40':'Chrome/155.0.8059.39',sourceRevisionHash:mode==='wrong-revision'?'f'.repeat(40):'3ff7ac5a9224be9156d7f8703a06e22890aafd34'});
  m.browser.observeProcesses=async()=>{scans++;if(mode==='scan-failure')throw Error('private-canary');if(mode==='scan-pending')return new Promise(resolve=>{finishScan=resolve;});return rows.map(row=>({...row}));};
  const create=runInNewContext(ts.transpileModule(declaration.getText(source).replace(/^export /,'')+'\nhistoryRendererIdentity;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {AbortController,AbortSignal,URL,performance:{now:()=>++now},deadline,networkRendererProfile,accountingPath,HISTORY_ATTEMPT_HEADER,
      readlink:async(file:string)=>{links++;linkPaths.push(file);if(mode==='namespace-missing')throw Error('private-canary');return mode==='namespace-mismatch'&&links===2?'pid:[2]':'pid:[1]';}}) as typeof historyRendererIdentity;
  const provider=create(m.cdp,m.browser,proof,'https://fixture.invalid',()=> 'b1');
  const event={requestId:'101.1',type:'Fetch',frameId:'frame',loaderId:'loader',request:{url:'https://fixture.invalid/api/boards/private-canary/period',method:'POST',headers:{[HISTORY_ATTEMPT_HEADER]:'b1:1'},postData:'private-canary'}};
  const emit=(value:unknown=event)=>m.emit('Network.requestWillBeSent',value);
  const setup=async()=>{await provider.before();provider.setupSent();provider.setupComplete();};
  const context=():RendererResolution=>({browserPid:100,failedStart:++now,after:{status:'observed',fromMs:++now,toMs:++now,omitted:0,processes:rows.map(row=>({...row}))}});
  return {...m,eventEmit:m.emit,proof,provider,event,emit,setup,context,rows,linkPaths,finishScan:()=>finishScan(rows),now:()=>++now,scans:()=>scans,links:()=>links};
}

test('only the two source-qualified version/revision pairs admit the network PID contract',()=>{
  for(const [version,sourceRevisionHash] of [['Chrome/155.0.8059.39','3ff7ac5a9224be9156d7f8703a06e22890aafd34'],['Chrome/155.0.8059.12','384c82079f60e0b79cdca6e49efd5cfceefa5b74']]){
    assert.equal(networkRendererProfile({version,sourceRevisionHash}),true);
    for(const bad of [{version},{sourceRevisionHash},{version:version+'0',sourceRevisionHash},{version,sourceRevisionHash:sourceRevisionHash.toUpperCase()},{version,sourceRevisionHash:'private-canary'}])assert.equal(networkRendererProfile(bad),false);
  }
  assert.equal(networkRendererProfile(undefined),false);assert.equal(networkRendererProfile(null),false);
});

test('a qualified cold witness survives successful cold input and a later HTTP-free warm failure',async()=>{
  const f=networkFixture();await f.setup();f.provider.input('cohort/cold scroll',f.now());f.provider.input('cohort/cold/request wait',f.now());f.emit();
  // Returning successfully does not resolve, consume or reset the document witness.
  f.provider.input('cohort/warm/cached return',f.now());const context=f.context(),h=await f.provider.resolve(new AbortController().signal,context);
  assert.equal(h.valid(),true);assert.equal(h.pid,101);assert.equal(h.birth,'1001');assert.equal(f.scans(),1);assert.equal(f.links(),2);assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.linkPaths,['/proc/self/ns/pid','/proc/100/ns/pid']);
  const receipt=safeEvidence(h.evidence()) as any;assert.equal(receipt.mechanism,'network-document');assert.equal(receipt.loss,null);assert.equal(receipt.namespaceEqual,true);
  assert.equal(receipt.witness.input.scenario,'cohort/cold scroll');assert.ok(receipt.witness.input.started<context.failedStart!);assert.ok(receipt.witness.received<context.failedStart!);
  assert.equal(receipt.failedCommand.started,context.failedStart);assert.equal(receipt.after.fromMs,context.after.fromMs);assert.equal(receipt.profile,true);
  assert.doesNotMatch(JSON.stringify(receipt),/private-canary|https:|pid:\[/);
  await f.provider.dispose();assert.equal(h.valid(),false);assert.equal(h.signal?.aborted,true);f.proof.dispose();await f.owner.close();assert.equal(f.listeners(),0);
});

test('an unfinished BEFORE scan consumes at most its one-second window and cannot publish a late reply',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=networkFixture('scan-pending'),before=f.provider.before();
  await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(1000);await before;f.finishScan();await new Promise<void>(resolve=>setImmediate(resolve));
  f.provider.setupSent();f.provider.setupComplete();f.provider.input('cold',f.now());f.emit();const h=await f.provider.resolve(new AbortController().signal,f.context());
  assert.equal(h.valid(),false);assert.equal((h.evidence() as any).before.status,'unavailable');assert.deepEqual(f.calls,[]);await f.provider.dispose();f.proof.dispose();await f.owner.close();
});

for(const mode of ['wrong-version','wrong-revision','namespace-missing','namespace-mismatch','scan-failure'])test('network binding fails closed without affecting page commands: '+mode,async()=>{
  const f=networkFixture(mode);await f.setup();f.provider.input('cold',f.now());f.emit();const h=await f.provider.resolve(new AbortController().signal,f.context());
  assert.equal(h.valid(),false);assert.equal(h.pid,null);assert.deepEqual(f.calls,[]);await f.provider.dispose();f.proof.dispose();await f.owner.close();
});

for(const mode of ['missing-frame','missing-loader','foreign-frame','foreign-loader','worker','keepalive','redirect','bad-pid','unsafe-pid','bad-counter','wrong-attempt','missing-attempt','get','conflict'])test('actual request producer rejects non-witness events: '+mode,async()=>{
  const f=networkFixture();await f.setup();f.provider.input('cold',f.now());
  const event=structuredClone(f.event) as any;
  if(mode==='missing-frame')delete event.frameId;if(mode==='missing-loader')delete event.loaderId;
  if(mode==='foreign-frame')event.frameId='foreign';if(mode==='foreign-loader')event.loaderId='foreign';
  if(mode==='worker'){event.frameId='';event.loaderId='';}if(mode==='keepalive')event.loaderId=event.requestId;
  if(mode==='redirect')event.redirectResponse={url:'https://private-canary.invalid'};
  if(mode==='bad-pid')event.requestId='0.1';if(mode==='unsafe-pid')event.requestId='9007199254740992.1';if(mode==='bad-counter')event.requestId='101.0';
  if(mode==='wrong-attempt')event.request.headers[HISTORY_ATTEMPT_HEADER]='b2:1';if(mode==='missing-attempt')event.request.headers={};if(mode==='get')event.request.method='GET';
  if(mode==='conflict'){f.emit();event.requestId='102.2';}f.emit(event);
  const h=await f.provider.resolve(new AbortController().signal,f.context());assert.equal(h.valid(),false);assert.equal(h.pid,null);assert.equal(f.provider.signal.aborted,true);
  await f.provider.dispose();f.proof.dispose();await f.owner.close();
});

for(const boundary of ['seed-only','before-scan','before-setup-ack','failed-setup','queued-old-reply','reused-birth','root-birth','root-missing','root-mismatch','after-omitted','after-unavailable','late-event','crash','detach','navigation','disposal','cancel'])test('actual producer keeps continuity and lifetime fail-closed: '+boundary,async()=>{
  const f=networkFixture();
  if(boundary==='seed-only'||boundary==='before-scan'){f.emit();f.provider.input('stale input',f.now());}
  if(boundary==='queued-old-reply')f.provider.setupSent();
  await f.provider.before();if(boundary!=='queued-old-reply')f.provider.setupSent();
  if(boundary==='before-setup-ack'){f.provider.input('queued input',f.now());f.emit();}
  if(boundary!=='failed-setup')f.provider.setupComplete();
  if(!['seed-only','before-scan','before-setup-ack'].includes(boundary)){f.provider.input('cold',f.now());f.emit();}
  const context=f.context();
  if(boundary==='reused-birth')context.after.processes![1].birth='999';if(boundary==='root-birth')context.after.processes![0].birth='999';
  if(boundary==='root-missing')context.after.processes!.shift();if(boundary==='root-mismatch')context.browserPid=99;
  if(boundary==='after-omitted')context.after.omitted=1;if(boundary==='after-unavailable')context.after.status='unavailable';
  if(boundary==='late-event')context.after.fromMs=1;
  if(boundary==='crash'||boundary==='detach'||boundary==='navigation'){
    const name=boundary==='crash'?'Inspector.targetCrashed':boundary==='detach'?'Inspector.detached':'Page.frameStartedNavigating';
    f.eventEmit(name,{});assert.equal(f.provider.signal.aborted,true,name);
  }
  if(boundary==='disposal')await f.provider.dispose();
  const pending=new AbortController();if(boundary==='cancel')pending.abort();
  const h=await f.provider.resolve(pending.signal,context);assert.equal(h.valid(),false,boundary);assert.equal(h.pid,null);assert.equal(h.birth,null);assert.equal(f.provider.signal.aborted,true);
  assert.equal((await f.provider.resolve(new AbortController().signal,f.context())).valid(),false);
  await f.provider.dispose();f.proof.dispose();await f.owner.close();assert.equal(f.listeners(),0);
});
