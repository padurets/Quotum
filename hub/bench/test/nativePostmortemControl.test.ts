import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {setTimeout} from 'node:timers/promises';
import {nativeWaitFixture} from '../nativePostmortemControl.js';
import {deadline} from '../deadline.js';
import {RunOwner} from '../runOwner.js';
import {safeEvidence} from '../evidence.js';

const file=ts.createSourceFile('control.ts',readFileSync(new URL('../nativePostmortemControl.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='nativePostmortemControl')!;
const code=ts.transpileModule(declaration.getText(file).replace('import.meta.dirname',"'/fixture/hub/bench'")+'\nglobalThis.run=nativePostmortemControl;',{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
type Fault='early rejection'|'changed error'|'wrong saved id'|'native unavailable'|'still traced'|'unreaped'|'open pipes'|'wrong main tid'|'observer close'|'browser close'|'dirty source'|'wrong source'|'wrong client'|'wrong uid'|'missing held request'|'fixture release'|'non-condition main'|'missing native locations'|'wrong location tid'|'short native chain'|'invalid native caller'|'unknown renderer'|'renderer invalidated'|'wrong renderer pid'|'wrong renderer birth'|'multiple renderer candidates'|'late unknown'|'late wrong pid'|'late wrong birth'|'late invalidated';

/** Leaf IO is synthetic; this tests that qualification refuses false positives and drains its owner. */
async function run(fault?:Fault){
  const source='1'.repeat(40),hash='2'.repeat(64),logs:string[]=[],listeners=new Map<string,()=>void>();
  const started=8727.003492;
  const failure={id:196,method:'Runtime.evaluate',started,deadline:started+30_000,elapsedMs:fault==='early rejection'?1:30_000,
    reason:fault==='early rejection'?'rejected':undefined};
  const original=new Error('control: Runtime.evaluate: no browser response in 30 s');
  let browserClosed=0,launched=0,fixtureClosed=false,identityDisposed=false,identityChecks=0,owner:RunOwner|undefined,capturedCandidates:unknown,documentCreated=false,documentPinned=false,documentDisposed=false,lateDisposed=false,lateCalls=0,nativeCalls=0;
  const native={status:fault==='native unavailable'?'unavailable':'observed',pid:fault==='wrong renderer pid'?102:101,birth:fault==='wrong renderer birth'?'201':'200',candidateCount:1,
    released:fault!=='still traced',reaped:fault!=='unreaped',pipesClosed:fault!=='open pipes',
    threads:[{tid:fault==='wrong main tid'?102:101,frames:[{symbol:true,kind:fault==='non-condition main'?'poll':'condition'}]}],
    mainLocations:{status:fault==='missing native locations'?'unavailable':'observed',tid:fault==='wrong location tid'?102:101,
      frames:Array.from({length:fault==='short native chain'?3:4},(_,index)=>({index,status:fault==='invalid native caller'&&index===3?'unknown':'file-location'}))}};
  const browser={owned:true,endpoint:'fixture',close:async()=>{browserClosed++;if(fault==='browser close')throw Error('close failed');},
    launchReport:()=>({cleanup:{status:'closed',reaped:true,pipesClosed:true}}),nativePostmortem:async(candidates?:unknown,_signal?:AbortSignal)=>{nativeCalls++;capturedCandidates=candidates;return native;}};
  const pageEvents=new Map<string,()=>void>();
  const page={at(){},snapshot:()=>({failure}),
    on:(name:string,listener:()=>void)=>pageEvents.set(name,listener),off:(name:string)=>pageEvents.delete(name),
    send:async(method:string)=>{assert.ok(documentCreated,'proof installed before first page command');if(method==='Page.navigate'){pageEvents.get('Page.loadEventFired')?.();return{frameId:'frame',loaderId:'loader'};}},
    evaluate:async(expression:string)=>{if(expression==='location.origin')return 'http://fixture';throw original;}};
  class Owner extends RunOwner{constructor(evidence:ConstructorParameters<typeof RunOwner>[0]){super(evidence);owner=this;}}
  const context={exports:{},assert,path,Error,execFileSync:(_file:string,args:string[])=>args.includes('status')?(fault==='dirty source'?' M bench/cdp.ts':''):args.includes('HEAD')?(fault==='wrong source'?'3'.repeat(40):source):'4'.repeat(40),
    clientIdentity:()=>({status:'available',sha256:fault==='wrong client'?'3'.repeat(64):hash}),safeEvidence,RunOwner:Owner,deadline,
    nativeWaitFixture:async(value:RunOwner)=>{value.resource(async()=>{fixtureClosed=true;});return {url:'http://fixture',
      requests:()=>({received:fault==='missing held request'?0:1,active:fixtureClosed&&fault!=='fixture release'?0:1})};},
    rendererDocument:(target:unknown)=>{assert.equal(target,page);documentCreated=true;return{pin(reply:unknown){assert.deepEqual(JSON.parse(JSON.stringify(reply)),{frameId:'frame',loaderId:'loader'});documentPinned=true;},dispose(){documentDisposed=true;}};},
    rendererIdentity:async(target:unknown,_browser:unknown,signal?:AbortSignal,document?:unknown)=>{
      assert.equal(target,page);assert.ok(documentPinned);
      if(document){lateCalls++;assert.ok(signal&&!signal.aborted);assert.notEqual(signal,owner!.signal);return{pid:fault==='late wrong pid'?102:101,birth:fault==='late wrong birth'?'201':'200',
        valid:()=>!signal!.aborted&&fault!=='late unknown'&&(fault!=='late invalidated'||nativeCalls===0),evidence:()=>({status:fault==='late unknown'?'unknown':'known',pid:101,birth:'200'}),dispose:async()=>{lateDisposed=true;}};}
      return({pid:101,birth:'200',valid:()=>fault!=='unknown renderer'&&(fault!=='renderer invalidated'||++identityChecks===1),
      evidence:()=>({status:fault==='unknown renderer'?'unknown':'known',pid:101,birth:'200'}),dispose:async()=>{identityDisposed=true;}});},
    process:{platform:'linux',getuid:()=>fault==='wrong uid'?1001:65534,once:(name:string,callback:()=>void)=>listeners.set(name,callback),removeListener:(name:string)=>listeners.delete(name)},
    performance:{now:()=>30_000},console:{log:(line:string)=>logs.push(line)},
    launchChrome:async()=>{launched++;return browser;},openTab:async()=>({cdp:page,close:async()=>{}}),
    observeReversal:async()=>({watch:async(_label:string,work:()=>Promise<unknown>)=>{
      try{await work();}catch(error){
        const candidates=[{pid:101,cpuTime:1},{pid:102,cpuTime:100}];
        if(fault==='multiple renderer candidates')candidates.push({pid:101,cpuTime:2});
        const child=new AbortController();
        try{await browser.nativePostmortem(candidates,child.signal);}catch{/* Diagnostic failure retains the original rejection. */}
        finally{child.abort();}
        owner!.evidence!.save('cdp-1',{command:{failure:{...failure,id:fault==='wrong saved id'?197:failure.id}}});
        throw fault==='changed error'?new Error('replacement error'):error;
      }
    },close:async()=>{if(fault==='observer close')throw Error('observer close failed');}}),
  };
  runInNewContext(code,context);
  let result:boolean|undefined,error:unknown;
  try{result=await (context as unknown as {run:(s:string,h:string,c:string)=>Promise<boolean>}).run(source,hash,'fixture');}catch(value){error=value;}
  return {result,error,launched,browserClosed,identityDisposed,documentPinned,documentDisposed,lateDisposed,lateCalls,nativeCalls,capturedCandidates,listeners,report:logs.length?JSON.parse(logs.at(-1)!):undefined};
}

test('native qualification accepts preserved timeout evidence and closes its owned browser',async()=>{
  const r=await run();assert.equal(r.error,undefined);assert.equal(r.result,true);
  assert.equal(r.report.status,'qualified');assert.equal(r.report.originalErrorPreserved,true);
  assert.equal(r.report.client.clientHash,'2'.repeat(64));
  assert.equal(r.browserClosed,1);assert.equal(r.listeners.size,0);
  assert.equal(r.identityDisposed,true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.capturedCandidates)),[{pid:101,cpuTime:1,birth:'200'}]);
});
for(const fault of ['early rejection','changed error','wrong saved id','native unavailable','still traced','unreaped','open pipes','wrong main tid','observer close','browser close','missing held request','fixture release','non-condition main','missing native locations','wrong location tid','short native chain','invalid native caller','unknown renderer','renderer invalidated','wrong renderer pid','wrong renderer birth','multiple renderer candidates'] as const)test('native qualification refuses '+fault+' and drains the browser',async()=>{
  const r=await run(fault);assert.equal(r.error,undefined);assert.equal(r.result,false);
  assert.equal(r.report.status,'failed');assert.equal(r.browserClosed,1);assert.equal(r.listeners.size,0);
  const phase=fault==='unknown renderer'?'renderer-identity':['early rejection','changed error','wrong saved id','missing held request'].includes(fault)?'command':['observer close','browser close','fixture release'].includes(fault)?'cleanup':'native-capture';
  assert.equal(r.report.phase,phase);
});
for(const fault of ['dirty source','wrong source','wrong client','wrong uid'] as const)test('native qualification refuses '+fault+' before launch',async()=>{
  const r=await run(fault);assert.ok(r.error);assert.equal(r.launched,0);assert.equal(r.listeners.size,0);
});

test('the native wait fixture holds an actual HTTP reply and its owner releases the socket',async()=>{
  const owner=new RunOwner();
  const fixture=await nativeWaitFixture(owner);
  const abort=new AbortController();
  let settled=false;
  try{
    const page=await fetch(fixture.url);
    assert.equal(page.headers.get('cache-control'),'no-store');
    assert.match(await page.text(),/Native wait fixture/);
    const held=fetch(fixture.url+'/wait',{signal:abort.signal}).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
    await deadline(1000,async signal=>{
      while(fixture.requests().active!==1)await setTimeout(5,undefined,{signal});
    });
    assert.equal(settled,false);
    assert.deepEqual(fixture.requests(),{received:1,active:1});
    await owner.close();
    assert.ok(await held instanceof Error);
    assert.deepEqual(owner.failures,[]);
    assert.equal(fixture.requests().active,0);
    await assert.rejects(fetch(fixture.url,{signal:AbortSignal.timeout(1000)}));
  }finally{abort.abort();await owner.close();}
});

test('cancelling the native fixture during startup drains its pending listener',async()=>{
  const owner=new RunOwner();
  const pending=nativeWaitFixture(owner);
  const rejected=assert.rejects(pending);
  await owner.close();
  await rejected;
  assert.deepEqual(owner.failures,[]);
});

test('a cancelled owner refuses to create a native wait listener',async()=>{
  const owner=new RunOwner();await owner.close();
  await assert.rejects(nativeWaitFixture(owner),/benchmark cancelled/);
});

test('native qualification compares postfailure identity to the independent pre-input oracle',async()=>{
  const r=await run();assert.equal(r.result,true);assert.equal(r.documentPinned,true);assert.equal(r.documentDisposed,true);
  assert.equal(r.lateCalls,1);assert.equal(r.nativeCalls,1);assert.equal(r.lateDisposed,true);
  assert.equal(r.report.rendererIdentityLate.status,'known');assert.equal(r.report.rendererIdentityLateAfterCapture.status,'known');
});
for(const fault of ['late unknown','late wrong pid','late wrong birth','late invalidated'] as const)test('native qualification refuses postfailure '+fault,async()=>{
  const r=await run(fault);assert.equal(r.error,undefined);assert.equal(r.result,false);assert.equal(r.report.status,'failed');
  assert.equal(r.documentDisposed,true);assert.equal(r.identityDisposed,true);assert.equal(r.lateDisposed,true);assert.equal(r.browserClosed,1);
  assert.equal(r.nativeCalls,fault==='late invalidated'?1:0);assert.equal(r.listeners.size,0);
});
