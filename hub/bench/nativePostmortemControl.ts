import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchChrome,openTab,type Browser} from './cdp.js';
import type {LaunchReport} from './chrome.js';
import {clientIdentity,safeEvidence} from './evidence.js';
import {observeReversal} from './reversalDiagnostic.js';
import {RunOwner} from './runOwner.js';

/** An opt-in diagnostic qualification, never a benchmark verdict or a C3 reproducer. */
export async function nativePostmortemControl(source:string,expectedClient:string,chrome:string){
  const root=path.resolve(import.meta.dirname,'../..');
  const git=(args:string[])=>execFileSync('git',['-c','safe.directory='+root,...args],{cwd:root,encoding:'utf8',timeout:1000}).trim();
  assert.match(source,/^[a-f0-9]{40}$/);assert.equal(git(['rev-parse','HEAD']),source);assert.equal(git(['status','--porcelain']),'');
  assert.match(expectedClient,/^[a-f0-9]{64}$/);
  const client=clientIdentity();assert.ok(client.status==='available');assert.equal(client.sha256,expectedClient);
  assert.equal(process.platform,'linux');assert.equal(process.getuid?.(),65534);
  const receipts=new Map<string,unknown>();
  const owner=new RunOwner({save(name,value){receipts.set(name,safeEvidence(value));}});
  const cancel=()=>{void owner.close().catch(()=>{});};
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const result:{[key:string]:unknown}={kind:'native-postmortem-control',mode:'diagnostic',status:'failed',
    source:{sha:source,tree:git(['rev-parse','HEAD^{tree}'])},
    client:{status:client.status,name:client.name,bytes:client.bytes,clientHash:client.sha256},uid:process.getuid?.(),
    limits:{reproducesC3:false,executesAppClient:false,qualifiesForcedHelperFailures:false},phase:'startup'};
  let browser:Browser|undefined,observer:Awaited<ReturnType<typeof observeReversal>>|undefined;
  let native:Awaited<ReturnType<NonNullable<Browser['nativePostmortem']>>>|undefined;
  let primary:unknown,primaryAt=0,calls=0,passed=false;
  try{
    browser=await owner.start(signal=>launchChrome(chrome,false,signal));
    const tab=await openTab(browser),page=tab.cdp;
    assert.ok(browser.nativePostmortem);
    const capture=browser.nativePostmortem;
    browser.nativePostmortem=async(candidates,signal)=>{
      assert.ok(primary);calls++;
      native=await capture(candidates,signal);return native;
    };
    observer=await observeReversal(page,browser,{postmortem:true,closeTarget:tab.close});
    result.phase='command';page.at('native-postmortem-control');
    try{
      await observer.watch('native-postmortem-control',()=>page.evaluate('(()=>{for(;;){}})()').catch(error=>{
        primary=error;primaryAt=performance.now();result.originalCommand=page.snapshot();throw error;
      }));
    }catch(error){assert.ok(primary);assert.equal(error,primary);result.originalErrorPreserved=true;}
    result.collectionMs=performance.now()-primaryAt;
    const failure=page.snapshot().failure;
    assert.ok(failure);assert.equal(failure.method,'Runtime.evaluate');assert.equal(failure.deadline-failure.started,30_000);
    assert.equal(failure.reason,undefined);assert.ok(failure.elapsedMs>=29_900);
    assert.ok(primary instanceof Error&&primary.message.endsWith('no browser response in 30 s'));
    assert.ok(Number(result.collectionMs)<=7000);assert.equal(calls,1);
    const saved=[...receipts.values()].find(value=>value&&typeof value==='object'&&'command' in value) as {command?:{failure?:{id:number;method:string}}}|undefined;
    assert.equal(saved?.command?.failure?.id,failure.id);assert.equal(saved?.command?.failure?.method,failure.method);
    result.phase='native-capture';
    assert.ok(native);assert.equal(native.status,'observed');assert.equal(native.released,true);
    assert.equal(native.reaped,true);assert.equal(native.pipesClosed,true);
    const captured=native;
    assert.ok(captured.threads.some(thread=>thread.tid===captured.pid&&thread.frames.some(frame=>frame.symbol)));
    passed=true;result.phase='cleanup';
  }catch(error){result.failure=error instanceof Error?error.name:'unknown';}
  finally{
    result.native=native;result.nativeCalls=calls;result.receipts=[...receipts].map(([name,value])=>({name,value}));
    try{await observer?.close();}
    catch{passed=false;result.cleanup='incomplete';}
    try{await owner.close();}
    catch{passed=false;result.cleanup='incomplete';}
    result.launch=browser?.launchReport?.();result.ownerFailures=owner.failures;
    const cleanup=(result.launch as LaunchReport|undefined)?.cleanup;
    if(!cleanup||cleanup.status!=='closed'||!cleanup.reaped||!cleanup.pipesClosed||owner.failures.length)passed=false;
    result.status=passed?'qualified':'failed';
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  }
  console.log(JSON.stringify(safeEvidence(result)));
  return passed;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const [source,client,chrome]=process.argv.slice(2);
  try{
    if(!source||!client||!chrome)throw new Error('Missing control arguments');
    if(!await nativePostmortemControl(source,client,chrome))process.exitCode=1;
  }catch(error){
    console.log(JSON.stringify({kind:'native-postmortem-control',mode:'diagnostic',status:'failed',phase:'preflight',failure:error instanceof Error?error.name:'unknown'}));
    process.exitCode=1;
  }
}
