import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchChrome,openTab,type Browser} from './cdp.js';
import type {LaunchReport} from './chrome.js';
import {clientIdentity,safeEvidence} from './evidence.js';
import {observeReversal} from './reversalDiagnostic.js';
import {RunOwner} from './runOwner.js';
import {deadline} from './deadline.js';
import {rendererIdentity,rendererDocument,type RendererIdentity} from './rendererIdentity.js';

/** An unanswered own HTTP request keeps sync XHR in a native condition wait. */
export async function nativeWaitFixture(owner:RunOwner){
  owner.signal.throwIfAborted();
  let received=0,active=0;
  let heldClosed=Promise.resolve();
  const server=createServer((request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if(request.url==='/wait'){
      received++;
      if(received!==1){response.writeHead(409);response.end();return;}
      active++;heldClosed=new Promise<void>(resolve=>response.once('close',()=>{active--;resolve();}));
    }else if(request.url==='/')response.end('<!doctype html><title>Native wait fixture</title>');
    else{response.writeHead(404);response.end();}
  });
  const close=owner.resource(async()=>{
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>
      error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));
    await heldClosed;
  });
  try{
    await owner.operation(async()=>{
      const ready=once(server,'listening',{signal:owner.signal});
      server.listen({port:0,host:'127.0.0.1',signal:owner.signal});
      await ready;
    });
    owner.signal.throwIfAborted();
    const address=server.address();assert.ok(address&&typeof address!=='string');
    return {url:'http://127.0.0.1:'+address.port,requests:()=>({received,active})};
  }catch(error){await close();throw error;}
}

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
  let fixture:Awaited<ReturnType<typeof nativeWaitFixture>>|undefined;
  let identity:RendererIdentity|undefined,lateIdentity:RendererIdentity|undefined;
  let primary:unknown,primaryAt=0,calls=0,passed=false,lateCaptureVerified=false;
  try{
    browser=await owner.start(signal=>launchChrome(chrome,false,signal));
    const tab=await openTab(browser),page=tab.cdp;
    const document=rendererDocument(page);owner.resource(async()=>document.dispose());
    result.phase='fixture';fixture=await nativeWaitFixture(owner);
    await page.send('Page.enable');
    const url=fixture.url;
    await deadline(5000,async signal=>{
      let complete!:()=>void,reject!: (error:unknown)=>void;
      const loaded=new Promise<void>((resolve,failed)=>{complete=resolve;reject=failed;});
      const cancel=()=>reject(signal.reason);
      page.on('Page.loadEventFired',complete);signal.addEventListener('abort',cancel,{once:true});
      try{
        if(signal.aborted)cancel();
        const [,navigation]=await Promise.all([loaded,page.send<{frameId:string;loaderId?:string;errorText?:string}>('Page.navigate',{url},signal)]);
        document.pin(navigation);
      }finally{page.off('Page.loadEventFired',complete);signal.removeEventListener('abort',cancel);reject(new Error('fixture navigation ended'));}
    },owner.signal);
    assert.equal(await page.evaluate('location.origin'),url);
    result.phase='renderer-identity';identity=await rendererIdentity(page,browser);
    result.rendererIdentity=identity.evidence();
    assert.ok(identity.valid());
    const rendererPid=identity.pid,rendererBirth=identity.birth;
    assert.ok(typeof rendererPid==='number');assert.ok(typeof rendererBirth==='string');
    assert.ok(browser.nativePostmortem);
    const capture=browser.nativePostmortem;
    browser.nativePostmortem=async(candidates,signal)=>{
      assert.ok(primary);calls++;
      result.rendererIdentityAtCapture=identity!.evidence();assert.ok(identity!.valid());
      const selected=candidates.filter(candidate=>candidate.pid===rendererPid);assert.equal(selected.length,1);
      lateIdentity=await rendererIdentity(page,browser!,signal,document);result.rendererIdentityLate=lateIdentity.evidence();
      assert.ok(lateIdentity.valid());assert.equal(lateIdentity.pid,rendererPid);assert.equal(lateIdentity.birth,rendererBirth);
      native=await capture([{...selected[0],birth:rendererBirth}],signal);
      result.rendererIdentityLateAfterCapture=lateIdentity.evidence();assert.ok(lateIdentity.valid());
      assert.equal(lateIdentity.pid,rendererPid);assert.equal(lateIdentity.birth,rendererBirth);lateCaptureVerified=true;return native;
    };
    observer=await observeReversal(page,browser,{postmortem:true,closeTarget:tab.close});
    result.phase='command';page.at('native-postmortem-control');
    try{
      await observer.watch('native-postmortem-control',()=>page.evaluate('(()=>{const request=new XMLHttpRequest();request.open("GET","/wait",false);request.send();})()').catch(error=>{
        primary=error;primaryAt=performance.now();result.originalCommand=page.snapshot();throw error;
      }));
    }catch(error){assert.ok(primary);assert.equal(error,primary);result.originalErrorPreserved=true;}
    result.collectionMs=performance.now()-primaryAt;
    const failure=page.snapshot().failure;
    assert.ok(failure);assert.equal(failure.method,'Runtime.evaluate');assert.equal(failure.deadline,failure.started+30_000);
    assert.equal(failure.reason,undefined);assert.ok(failure.elapsedMs>=29_900);
    assert.ok(primary instanceof Error&&primary.message.endsWith('no browser response in 30 s'));
    assert.ok(Number(result.collectionMs)<=7000);assert.equal(calls,1);
    result.fixture={kind:'sync-xhr-native-wait',...fixture.requests()};
    assert.equal(fixture.requests().received,1);assert.equal(fixture.requests().active,1);
    const saved=[...receipts.values()].find(value=>value&&typeof value==='object'&&'command' in value) as {command?:{failure?:{id:number;method:string}}}|undefined;
    assert.equal(saved?.command?.failure?.id,failure.id);assert.equal(saved?.command?.failure?.method,failure.method);
    result.phase='native-capture';
    assert.ok(native);assert.equal(native.status,'observed');assert.equal(native.released,true);
    assert.equal(native.reaped,true);assert.equal(native.pipesClosed,true);
    assert.ok(identity.valid());assert.ok(lateCaptureVerified);assert.equal(native.pid,rendererPid);assert.equal(native.birth,rendererBirth);
    assert.equal(native.candidateCount,1);
    const captured=native;
    assert.ok(captured.threads.some(thread=>thread.tid===captured.pid&&thread.frames.some(frame=>frame.symbol)));
    assert.ok(captured.threads.some(thread=>thread.tid===captured.pid&&thread.frames.some(frame=>frame.kind==='condition')));
    assert.equal(captured.mainLocations.status,'observed');assert.equal(captured.mainLocations.tid,captured.pid);
    assert.ok(captured.mainLocations.frames.length>=4);
    assert.ok(captured.mainLocations.frames.slice(0,4).every((frame,index)=>frame.index===index&&frame.status==='file-location'));
    passed=true;result.phase='cleanup';
  }catch(error){result.failure=error instanceof Error?error.name:'unknown';}
  finally{
    result.rendererIdentityBeforeCleanup=identity?.evidence();
    result.fixture??=fixture?{kind:'sync-xhr-native-wait',...fixture.requests()}:undefined;
    result.native=native;result.nativeCalls=calls;result.receipts=[...receipts].map(([name,value])=>({name,value}));
    try{await observer?.close();}
    catch{passed=false;result.cleanup='incomplete';}
    try{await lateIdentity?.dispose();}
    catch{passed=false;result.cleanup='incomplete';}
    try{await identity?.dispose();}
    catch{passed=false;result.cleanup='incomplete';}
    try{await owner.close();}
    catch{passed=false;result.cleanup='incomplete';}
    result.fixtureAfterCleanup=fixture?.requests();
    if(fixture&&fixture.requests().active!==0)passed=false;
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
