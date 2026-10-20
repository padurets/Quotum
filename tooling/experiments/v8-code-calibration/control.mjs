import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, readdir, readlink, open, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';

// This is a method calibration, never a dashboard acceptance run.
const root=process.env.GITHUB_WORKSPACE, out=process.env.QUOTUM_CALIBRATION_DIR;
assert(root&&out&&process.env.CI==='true'&&process.platform==='linux'&&process.arch==='x64');
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=async(name,value)=>{const b=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(b.length<=8*1024*1024);await writeFile(path.join(out,name+'.json'),b,{flag:'wx'});};
await mkdir(out,{recursive:true});
const [{launchChrome},{RunOwner},{openTab,findChrome},{processIdentity},{deadline}]=await Promise.all(
  ['chrome','runOwner','cdp','browserProcess','deadline'].map(name=>import(pathToFileURL(path.join(root,'hub/bench',name+'.ts')))));
const owner=new RunOwner(), results={mode:'method-calibration',status:'insufficient-evidence',limits:[
  'No dashboard performance or historical cause proof',
  'Function-code container only, not inlining leaf or exclusive function CPU',
  'Code metadata logging overhead is unqualified; not application admission',
  'No independent complete deletion ledger; synthetic collection only']};
let browser,cdp,helper,helperExit,helperPid,helperEnded=false,invalidated=false,fixture,pageUrl,assetUrl,armed=false;
const fixtureAbort=new AbortController();let fixtureListen;
const rows=[],waiters=[],helperRaw=[],helperErr=[];let bytes=0,partial='',helperFailure;
let cancelled=false,codeActive=false,codeStopRequested=false,codeDone,codeListener,codeComplete;
const monotonic=()=>{
  const value=execFileSync('python3',['-c','import time;print(time.clock_gettime_ns(time.CLOCK_MONOTONIC))'],{encoding:'utf8',timeout:1000,maxBuffer:64}).trim();
  assert(/^[1-9]\d*$/.test(value));return value;
};
const cancel=()=>{
  cancelled=true;invalidated=true;helper?.stdin.destroy();
  fixtureAbort.abort();
  for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(Error('control-cancelled'));}
  void owner.close().catch(()=>{});
};
process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
const outerDeadline=setTimeout(cancel,90000);
const event=(name,timeout=2000)=>new Promise((resolve,reject)=>{
  const ready=rows.find(row=>!row.used&&row.kind===name);
  if(ready){ready.used=true;resolve(ready);return;}
  const item={name,resolve,reject,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(item),1);reject(Error('helper-'+name+'-deadline'));},timeout)};
  waiters.push(item);
});
const receive=row=>{
  if(row.kind==='boot'){assert(Number.isInteger(row.pid)&&row.pid>1);helperPid=row.pid;}
  if(row.kind==='error'){helperFailure=row;for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(Error('helper-'+row.stage));}}
  const item=waiters.find(item=>item.name===row.kind);
  if(item){clearTimeout(item.timer);waiters.splice(waiters.indexOf(item),1);item.resolve(row);}
  else rows.push(row);
};
const source=`window.__nativeCalibration = (()=>{
  function calibrationA(ms) {
    const until=performance.now()+ms; let x=173,s=0;
    do { for(let i=0;i<8192;i++){x=(Math.imul(x^i,1664525)+1013904223)|0;s=(s+x)|0;} } while(performance.now()<until);
    window.__nativeSink=s; return {value:s,done:true};
  }
  function calibrationB(ms) {
    const until=performance.now()+ms; let x=281,s=0;
    do { for(let i=0;i<8192;i++){x=(Math.imul(x+i,1103515245)^12345)|0;s=(s^x)|0;} } while(performance.now()<until);
    window.__nativeSink=s; return {value:s,done:true};
  }
  return {A:calibrationA,B:calibrationB};
})();`;
const contexts=new Map(),invalidations=[];
const invalidate=kind=>{invalidated=true;invalidations.push(kind);};
function nativeMain(events,pid){
  const names=events.filter(e=>e.name==='thread_name'&&e.pid===pid&&e.args?.name==='CrRendererMain');
  assert.equal(names.length,1);assert.equal(names[0].tid,pid);
  assert(events.filter(e=>e.name==='thread_name'&&e.pid===pid&&e.tid===pid).every(e=>e.args?.name==='CrRendererMain'));
  return names[0].tid;
}
const readIdentity=async pid=>{
  const value=processIdentity(pid,await readFile(`/proc/${pid}/stat`,'utf8'));assert(value);return value;
};
async function identity(pid,group,mainTid){
  const before=await readIdentity(pid), status=await readFile(`/proc/${pid}/status`,'utf8');
  assert(before.group===group&&before.session===group&&before.state!=='Z');
  const uid=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);assert(uid&&uid.slice(1).every(x=>Number(x)===process.getuid()));
  assert(Number(status.match(/^Tgid:\s+(\d+)$/m)?.[1])===pid);
  assert((await readlink(`/proc/${pid}/ns/pid`))===await readlink('/proc/self/ns/pid'));
  assert.equal(mainTid,pid);
  const task=processIdentity(mainTid,await readFile(`/proc/${pid}/task/${mainTid}/stat`,'utf8'));assert(task&&task.birth===before.birth);
  const taskStatus=await readFile(`/proc/${pid}/task/${mainTid}/status`,'utf8');assert(Number(taskStatus.match(/^Tgid:\s+(\d+)$/m)?.[1])===pid);
  const after=await readIdentity(pid);assert.equal(after.birth,before.birth);
  return {pid,group,session:before.session,birth:before.birth,mainTid,taskBirth:task.birth,uid:process.getuid(),namespaceEqual:true};
}
async function trace(stage){
  const events=[];let size=0,complete;
  const done=new Promise(resolve=>{complete=resolve;});
  const collected=payload=>{for(const value of payload.value??[]){size+=Buffer.byteLength(JSON.stringify(value));if(size<=4*1024*1024&&events.length<20000)events.push(value);else invalidate('trace-cap');}};
  cdp.on('Tracing.dataCollected',collected);cdp.on('Tracing.tracingComplete',complete);
  try{
    await cdp.send('Tracing.start',{categories:'-*,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'},owner.signal);
    await wait(100,undefined,{signal:owner.signal});await cdp.send('Tracing.end',{},owner.signal);
    await Promise.race([done,wait(2000).then(()=>{throw Error('trace-drain-deadline');})]);
  }finally{cdp.off('Tracing.dataCollected',collected);cdp.off('Tracing.tracingComplete',complete);}
  await save('trace-'+stage,events);
  const tree=await cdp.send('Page.getFrameTree',{},owner.signal), frame=tree.frameTree?.frame;assert(frame?.id&&frame.url===pageUrl);
  const frames=events.filter(e=>e.name==='TracingStartedInBrowser').flatMap(e=>e.args?.data?.frames??[])
    .filter(f=>f.frame===frame.id&&f.isOutermostMainFrame===true&&f.isInPrimaryMainFrame===true);
  assert.equal(frames.length,1);assert(Number.isSafeInteger(frames[0].processId)&&frames[0].processId>1);
  return {frame:frame.id,loader:frame.loaderId??null,pid:frames[0].processId,mainTid:nativeMain(events,frames[0].processId)};
}
async function startCodeTrace(){
  const config=JSON.parse(await readFile(new URL('./trace-config-first.json',import.meta.url),'utf8'));
  assert(config.configSha256==='653e6fa9c8449984948580ef1d8754b7e6b320782a5f64d080e8127f577b4b34');
  assert.equal(hash(Buffer.from(config.perfettoConfig,'base64')),config.configSha256);
  codeDone=new Promise(resolve=>{codeComplete=resolve;});
  codeListener=payload=>{if(!codeStopRequested)invalidate('premature-code-trace-stop');codeComplete(payload);};
  cdp.on('Tracing.tracingComplete',codeListener);
  await cdp.send('Tracing.start',{tracingBackend:'chrome',transferMode:'ReturnAsStream',streamFormat:'proto',perfettoConfig:config.perfettoConfig},owner.signal);
  codeActive=true;
}
async function stopCodeTrace(){
  assert(codeActive&&!codeStopRequested);codeStopRequested=true;
  let stream,primary;
  try{
    await deadline(2000,async signal=>{
      await cdp.send('Tracing.end',{},signal);
      const receipt=await codeDone;stream=receipt.stream;
      await save('code-trace-completion',{streamType:typeof stream,dataLossOccurred:typeof receipt.dataLossOccurred==='boolean'?receipt.dataLossOccurred:null,
        format:['json','proto'].includes(receipt.streamFormat)?receipt.streamFormat:'other-or-missing',
        compression:['none','gzip'].includes(receipt.streamCompression)?receipt.streamCompression:'other-or-missing',
        checks:{stream:typeof stream==='string',noLoss:receipt.dataLossOccurred===false,proto:receipt.streamFormat==='proto',uncompressed:!receipt.streamCompression||receipt.streamCompression==='none'}});
      assert(typeof stream==='string'&&receipt.dataLossOccurred===false&&receipt.streamFormat==='proto'&&(!receipt.streamCompression||receipt.streamCompression==='none'));
      const chunks=[];let total=0;
      for(;;){
        const row=await cdp.send('IO.read',{handle:stream,size:65536},signal);
        assert(typeof row.data==='string'&&(row.base64Encoded===true||(row.eof&&row.data==='')));
        const bytes=Buffer.from(row.data,'base64');assert(bytes.length<=65536);total+=bytes.length;assert(total<=2*1024*1024);chunks.push(bytes);
        if(row.eof)break;
      }
      const bytes=Buffer.concat(chunks);assert(bytes.length>0);
      await writeFile(path.join(out,'code-trace.pftrace'),bytes,{flag:'wx'});
      results.codeTrace={bytes:bytes.length,sha256:hash(bytes),dataLossOccurred:false,streamFormat:'proto',complete:true};
    },owner.signal);
  }catch(error){primary=error;}
  finally{
    try{
      if(stream)await deadline(1000,signal=>cdp.send('IO.close',{handle:stream},signal),owner.signal);
    }catch(error){
      results.codeTraceCleanup='stream-close-failed';primary??=error;
    }finally{cdp.off('Tracing.tracingComplete',codeListener);codeActive=false;}
  }
  if(primary)throw primary;
}

try{
  const requests={page:0,script:0,other:0};
  fixture=createServer((request,response)=>{
    if(request.url==='/calibration.js'){requests.script++;response.setHeader('Content-Type','text/javascript; charset=utf-8');response.end(source);}
    else if(request.url==='/'){requests.page++;response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><script src="/calibration.js"></script>');}
    else{requests.other++;response.statusCode=404;response.end();}
  });
  fixtureListen=new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.once('close',()=>reject(Error('fixture-closed-before-listen')));fixture.listen({port:0,host:'127.0.0.1',signal:fixtureAbort.signal},resolve);});
  await deadline(1000,async()=>fixtureListen,owner.signal);
  pageUrl='http://127.0.0.1:'+fixture.address().port+'/';assetUrl=pageUrl+'calibration.js';
  const chrome=findChrome(process.env);assert(chrome&&path.isAbsolute(chrome));
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const wrapper=path.join(out,'chrome-wrapper.sh');
  await writeFile(wrapper,'#!/bin/sh\nexec '+quote(chrome)+' '+quote('--js-flags=--perfetto-code-logger')+' "$@"\n',{flag:'wx',mode:0o700});
  browser=await owner.start(signal=>launchChrome(wrapper,false,signal));
  const launched=browser.launchReport();assert(launched.ownedGroup&&launched.pid>1);
  ({cdp}=await openTab(browser));
  const runtime=await cdp.send('Browser.getVersion',{},owner.signal);
  assert(runtime.product==='Chrome/155.0.8059.39'&&runtime.jsVersion==='15.5.35.20'&&runtime.revision.replace(/^@/,'')==='3ff7ac5a9224be9156d7f8703a06e22890aafd34');
  cdp.on('Runtime.executionContextCreated',e=>{if(contexts.size>=16)invalidate('context-cap');else contexts.set(e.context.id,e.context);});
  cdp.on('Runtime.executionContextDestroyed',e=>{contexts.delete(e.executionContextId);if(armed)invalidate('context-destroyed');});
  cdp.on('Runtime.executionContextsCleared',()=>{contexts.clear();if(armed)invalidate('contexts-cleared');});
  for(const name of ['Page.frameNavigated','Page.frameDetached','Inspector.detached','Inspector.targetCrashed'])cdp.on(name,()=>{if(armed)invalidate(name);});
  await cdp.send('Page.enable',{},owner.signal);await cdp.send('Runtime.enable',{},owner.signal);
  const responses=[];cdp.on('Network.responseReceived',e=>{if(e.type==='Script'&&e.response?.url===assetUrl){if(responses.length>=4)invalidate('response-cap');else responses.push({requestId:e.requestId,status:e.response.status,url:e.response.url});}});
  cdp.on('Network.requestWillBeSent',e=>{if(e.request?.url===assetUrl&&e.redirectResponse)invalidate('script-redirect');});
  await cdp.send('Network.enable',{},owner.signal);
  await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true},owner.signal);
  let loaded,navigation;const loads=[],loading=new Promise(resolve=>{loaded=resolve;});
  const onLoad=e=>{if(e.name!=='load')return;if(loads.length>=16)invalidate('load-cap');else loads.push(e);if(navigation&&e.loaderId===navigation.loaderId&&e.frameId===navigation.frameId)loaded();};
  cdp.on('Page.lifecycleEvent',onLoad);
  try{
    await deadline(5000,async signal=>{
      navigation=await cdp.send('Page.navigate',{url:pageUrl},signal);assert(navigation.frameId&&navigation.loaderId&&!navigation.errorText);
      if(loads.some(e=>e.loaderId===navigation.loaderId&&e.frameId===navigation.frameId))loaded();
      await loading;
    },owner.signal);
  }finally{cdp.off('Page.lifecycleEvent',onLoad);}
  assert(await cdp.evaluate('Boolean(window.__nativeCalibration)',owner.signal));armed=true;
  const first=await trace('before'), expected=await identity(first.pid,launched.pid,first.mainTid);
  const own=await browser.observeProcesses(owner.signal);assert(own.some(p=>p.pid===first.pid&&p.birth===expected.birth));
  await startCodeTrace();
  // Identical fixed warmup, outside either sampling window.
  await cdp.evaluate('window.__nativeCalibration.A(100);window.__nativeCalibration.B(100);true',owner.signal);
  const collectionFrom=monotonic();
  owner.signal.throwIfAborted();assert(!cancelled&&!invalidated);
  helper=spawn('sudo',['-n','--',path.join(out,'perf-sample'),String(first.pid),String(process.getuid()),String(process.getgid()),String(launched.pid),expected.birth],{stdio:['pipe','pipe','pipe']});
  helper.stdin.on('error',()=>{
    helperFailure={kind:'error',stage:'stdin'};
    for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(Error('helper-stdin'));}
  });
  helperExit=new Promise(resolve=>{helper.once('exit',(code,signal)=>resolve({code,signal}));helper.once('error',()=>resolve({code:null,signal:'spawn-error'}));});
  helper.stdout.on('data',chunk=>{
    try{bytes+=chunk.length;assert(bytes<=2*1024*1024);helperRaw.push(chunk);partial+=chunk.toString('utf8');
      let end;while((end=partial.indexOf('\n'))>=0){const line=partial.slice(0,end);partial=partial.slice(end+1);if(line)receive(JSON.parse(line));}
    }catch{helperFailure={kind:'error',stage:'reader'};helper.stdin.destroy();}
  });
  let stderrBytes=0;helper.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes<=8192)helperErr.push(chunk);else helper.stdin.destroy();});
  const boot=await event('boot'),ready=await event('ready');assert.equal(boot.pid,ready.pid);assert.equal(ready.target,first.pid);assert.equal(ready.uid,process.getuid());
  assert(/^[0-9a-f]+$/.test(ready.attrHex)&&ready.attrHex.length%2===0);
  const attr=Buffer.from(ready.attrHex,'hex');assert(attr.length>=96&&attr.length<=256&&attr.readUInt32LE(4)===attr.length);
  assert.equal(attr.readUInt32LE(0),1);assert.equal(attr.readBigUInt64LE(8),1n);
  assert.equal(attr.readBigUInt64LE(16),250000n);assert.equal(attr.readBigUInt64LE(24),263n);
  assert.equal(attr.readBigUInt64LE(32),19n);assert.equal(attr.readBigUInt64LE(40),0x2000061n);
  assert.equal(attr.readUInt32LE(48),1);assert.equal(attr.readInt32LE(92),1);
  assert(attr.subarray(52,92).every(x=>x===0)&&attr.subarray(96).every(x=>x===0));
  results.helper={boot,ready};results.phases=[];
  for(const phase of ['A','B']){
    assert(!invalidated&&!helperFailure);helper.stdin.write('start'+phase+'\n');const started=await event('started');assert.equal(started.phase,phase);
    const value=await cdp.evaluate('window.__nativeCalibration.'+phase+'(400)',owner.signal);assert(value.done&&Number.isInteger(value.value));
    helper.stdin.write('stop'+phase+'\n');const stopped=await event('stopped');assert.equal(stopped.phase,phase);
    results.phases.push({phase,value,started,stopped});
  }
  helper.stdin.end('end\n');const ended=await event('end');const exit=await helperExit;helperEnded=true;assert.deepEqual(exit,{code:0,signal:null});assert(!helperFailure&&!partial);assert.equal(stderrBytes,0);
  assert.equal(ended.lost,0);assert.equal(ended.throttled,0);assert.equal(ended.overflow,0);results.helper.end=ended;
  const collectionTo=monotonic();
  await stopCodeTrace();
  results.codeTrace.collection={from:collectionFrom,to:collectionTo,clock:'CLOCK_MONOTONIC',perfettoClockId:3,ordering:'trace-start-ack < clock-from < helper-spawn/enabled/stopped/reaped < clock-to < trace-end-request'};
  const last=await trace('after');assert.deepEqual(last,first);assert.deepEqual(await identity(first.pid,launched.pid,last.mainTid),expected);assert(!invalidated);
  assert.equal(responses.length,1);assert.equal(requests.script,1);assert.equal(requests.page,1);
  assert.equal(responses[0].status,200);assert.equal(responses[0].url,assetUrl);
  const body=await cdp.send('Network.getResponseBody',{requestId:responses[0].requestId},owner.signal);assert.equal(body.base64Encoded,false);assert.equal(body.body,source);
  const parsed=[];cdp.on('Debugger.scriptParsed',e=>{if(e.url===assetUrl)parsed.push(e);});
  await cdp.send('Debugger.enable',{},owner.signal);assert.equal(parsed.length,1);assert.equal(parsed[0].hash.toLowerCase(),hash(source));
  const mainContext=contexts.get(parsed[0].executionContextId);assert(mainContext?.auxData?.isDefault===true&&mainContext.auxData.frameId===first.frame);
  const received=await cdp.send('Debugger.getScriptSource',{scriptId:parsed[0].scriptId},owner.signal);assert.equal(received.scriptSource,source);
  const locations={};
  for(const phase of ['A','B']){
    const fn=await cdp.send('Runtime.evaluate',{expression:'window.__nativeCalibration.'+phase,objectGroup:'native-calibration-location'},owner.signal);
    assert(fn.result?.objectId);
    const properties=await cdp.send('Runtime.getProperties',{objectId:fn.result.objectId,ownProperties:true},owner.signal);
    const location=properties.internalProperties?.find(p=>p.name==='[[FunctionLocation]]')?.value?.value;
    assert(location?.scriptId===parsed[0].scriptId&&Number.isInteger(location.lineNumber)&&Number.isInteger(location.columnNumber));
    locations[phase]={line:location.lineNumber+1,column:location.columnNumber+1};
  }
  await cdp.send('Runtime.releaseObjectGroup',{objectGroup:'native-calibration-location'},owner.signal);
  await cdp.send('Debugger.disable',{},owner.signal);
  results.binding={runtime,frame:first,process:expected,source:{url:assetUrl,bytes:Buffer.byteLength(source),sha256:hash(source),receivedHash:hash(body.body),requests,parsed,locations},codeTrace:results.codeTrace};
  const samples=rows.filter(r=>r.kind==='sample');assert(samples.length<=8192);assert.equal(samples.length,ended.samples);await save('samples',samples);
  await save('mapping-input',{binding:results.binding,phases:results.phases});
  const mapped=execFileSync('python3',[new URL('./map_samples.py',import.meta.url).pathname,out],{encoding:'utf8',timeout:5000,maxBuffer:8192});
  const mapping=JSON.parse(mapped);assert(mapping.status==='qualified-synthetic-container-mapping');
  results.mapping=mapping;
  for(const phase of ['A','B']){
    const p=results.phases.find(row=>row.phase===phase),counter=p.stopped,bucket=mapping.phases.find(row=>row.phase===phase);
    assert(bucket&&bucket.total===counter.samples&&bucket.known>=20&&bucket.wrong===0);
    assert.equal(counter.lost,0);assert.equal(counter.throttled,0);assert.equal(counter.overflow,0);
    assert(BigInt(counter.enabled)>0n&&BigInt(counter.running)===BigInt(counter.enabled));
    p.mapping=bucket;
  }
  results.status='qualified-function-container-calibration';
}catch(error){results.failure={message:typeof error?.message==='string'?error.message.slice(0,200):'unknown',helper:helperFailure??null};}
finally{
  if(helper&&!helperEnded){helper.stdin.destroy();const exit=await Promise.race([helperExit,wait(11000).then(()=>null)]);results.helperCleanup={exit,pid:helperPid??null};if(!exit)results.status='cleanup-unconfirmed';}
  for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(Error('control-cleanup'));}
  if(codeActive&&!codeStopRequested){try{await stopCodeTrace();}catch{results.codeTraceCleanup='incomplete';}}
  if(codeListener)cdp?.off('Tracing.tracingComplete',codeListener);
  try{await owner.close();results.browserCleanup=browser?.launchReport();}catch{results.status='cleanup-unconfirmed';results.browserCleanup={failures:owner.failures};}
  if(fixture){try{
    fixtureAbort.abort();
    await deadline(1500,async()=>{
      await fixtureListen?.catch(()=>{});
      const stopped=new Promise((resolve,reject)=>fixture.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));
      fixture.closeAllConnections();await stopped;
    });
    assert(!fixture.listening);results.fixtureCleanup='closed';
  }catch{results.status='cleanup-unconfirmed';results.fixtureCleanup='unknown';}}
  clearTimeout(outerDeadline);process.off('SIGTERM',cancel);process.off('SIGINT',cancel);
  if(helper){await writeFile(path.join(out,'helper-raw.log'),Buffer.concat(helperRaw),{flag:'wx'});await writeFile(path.join(out,'helper-stderr.log'),Buffer.concat(helperErr),{flag:'wx'});}
  if(cancelled)results.status='cancelled';
  results.invalidations=invalidations;results.helperRows=rows.filter(r=>r.kind!=='sample');
  await save('result',results);
}
console.log(JSON.stringify({status:results.status,failure:results.failure??null}));
process.exitCode=results.status==='qualified-function-container-calibration'?0:1;
