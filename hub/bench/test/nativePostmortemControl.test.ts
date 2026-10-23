import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {RunOwner} from '../runOwner.js';
import {safeEvidence} from '../evidence.js';

const file=ts.createSourceFile('control.ts',readFileSync(new URL('../nativePostmortemControl.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='nativePostmortemControl')!;
const code=ts.transpileModule(declaration.getText(file).replace('import.meta.dirname',"'/fixture/hub/bench'")+'\nglobalThis.run=nativePostmortemControl;',{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
type Fault='early rejection'|'changed error'|'wrong saved id'|'native unavailable'|'still traced'|'unreaped'|'open pipes'|'wrong main tid'|'observer close'|'browser close'|'dirty source'|'wrong source'|'wrong client'|'wrong uid';

/** Leaf IO is synthetic; this tests that qualification refuses false positives and drains its owner. */
async function run(fault?:Fault){
  const source='1'.repeat(40),hash='2'.repeat(64),logs:string[]=[],listeners=new Map<string,()=>void>();
  const started=8727.003492;
  const failure={id:196,method:'Runtime.evaluate',started,deadline:started+30_000,elapsedMs:fault==='early rejection'?1:30_000,
    reason:fault==='early rejection'?'rejected':undefined};
  const original=new Error('control: Runtime.evaluate: no browser response in 30 s');
  let browserClosed=0,launched=0,owner:RunOwner|undefined;
  const native={status:fault==='native unavailable'?'unavailable':'observed',pid:101,
    released:fault!=='still traced',reaped:fault!=='unreaped',pipesClosed:fault!=='open pipes',
    threads:[{tid:fault==='wrong main tid'?102:101,frames:[{symbol:true}]}]};
  const browser={owned:true,endpoint:'fixture',close:async()=>{browserClosed++;if(fault==='browser close')throw Error('close failed');},
    launchReport:()=>({cleanup:{status:'closed',reaped:true,pipesClosed:true}}),nativePostmortem:async()=>native};
  const page={at(){},snapshot:()=>({failure}),evaluate:async()=>{throw original;}};
  class Owner extends RunOwner{constructor(evidence:ConstructorParameters<typeof RunOwner>[0]){super(evidence);owner=this;}}
  const context={exports:{},assert,path,Error,execFileSync:(_file:string,args:string[])=>args.includes('status')?(fault==='dirty source'?' M bench/cdp.ts':''):args.includes('HEAD')?(fault==='wrong source'?'3'.repeat(40):source):'4'.repeat(40),
    clientIdentity:()=>({status:'available',sha256:fault==='wrong client'?'3'.repeat(64):hash}),safeEvidence,RunOwner:Owner,
    process:{platform:'linux',getuid:()=>fault==='wrong uid'?1001:65534,once:(name:string,callback:()=>void)=>listeners.set(name,callback),removeListener:(name:string)=>listeners.delete(name)},
    performance:{now:()=>30_000},console:{log:(line:string)=>logs.push(line)},
    launchChrome:async()=>{launched++;return browser;},openTab:async()=>({cdp:page,close:async()=>{}}),
    observeReversal:async()=>({watch:async(_label:string,work:()=>Promise<unknown>)=>{
      try{await work();}catch(error){
        await browser.nativePostmortem();
        owner!.evidence!.save('cdp-1',{command:{failure:{...failure,id:fault==='wrong saved id'?197:failure.id}}});
        throw fault==='changed error'?new Error('replacement error'):error;
      }
    },close:async()=>{if(fault==='observer close')throw Error('observer close failed');}}),
  };
  runInNewContext(code,context);
  let result:boolean|undefined,error:unknown;
  try{result=await (context as unknown as {run:(s:string,h:string,c:string)=>Promise<boolean>}).run(source,hash,'fixture');}catch(value){error=value;}
  return {result,error,launched,browserClosed,listeners,report:logs.length?JSON.parse(logs.at(-1)!):undefined};
}

test('native qualification accepts preserved timeout evidence and closes its owned browser',async()=>{
  const r=await run();assert.equal(r.error,undefined);assert.equal(r.result,true);
  assert.equal(r.report.status,'qualified');assert.equal(r.report.originalErrorPreserved,true);
  assert.equal(r.report.client.clientHash,'2'.repeat(64));
  assert.equal(r.browserClosed,1);assert.equal(r.listeners.size,0);
});
for(const fault of ['early rejection','changed error','wrong saved id','native unavailable','still traced','unreaped','open pipes','wrong main tid','observer close','browser close'] as const)test('native qualification refuses '+fault+' and drains the browser',async()=>{
  const r=await run(fault);assert.equal(r.error,undefined);assert.equal(r.result,false);
  assert.equal(r.report.status,'failed');assert.equal(r.browserClosed,1);assert.equal(r.listeners.size,0);
  const phase=['early rejection','changed error','wrong saved id'].includes(fault)?'command':['observer close','browser close'].includes(fault)?'cleanup':'native-capture';
  assert.equal(r.report.phase,phase);
});
for(const fault of ['dirty source','wrong source','wrong client','wrong uid'] as const)test('native qualification refuses '+fault+' before launch',async()=>{
  const r=await run(fault);assert.ok(r.error);assert.equal(r.launched,0);assert.equal(r.listeners.size,0);
});
