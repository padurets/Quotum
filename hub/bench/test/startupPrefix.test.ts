import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const sha='a'.repeat(40),clientHash='b'.repeat(64),tree='c'.repeat(40);
const expected={QUOTUM_BENCH_SOURCE_SHA:sha,QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:clientHash};
const keys=['QUOTUM_C1_REAL_CHROME','QUOTUM_C1_TRIAL','QUOTUM_C1_RECEIPT',...Object.keys(expected)];
const json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));

async function fixture(){
  const directory=mkdtempSync(path.join(tmpdir(),'quotum-startup-prefix-'));
  try{
    const workflow=readFileSync(path.join(repository,'.github/workflows/ci.yml'),'utf8');
    const helper=workflow.match(/^          cat > "\$RUNNER_TEMP\/quotum-c1-aba\.mjs" <<'JS'\n([\s\S]*?)^          JS$/m);
    const sequence=workflow.match(/      - name: Observe the fixed ABA sequence with fresh benchmark preparation\n[\s\S]*?        run: \|\n([\s\S]*?)(?=      - name:)/);
    assert.ok(helper);assert.ok(sequence);
    const module=path.join(directory,'actual.mjs'),shell=path.join(directory,'sequence.sh');
    writeFileSync(module,helper[1].replace(/^          /gm,''));
    let command=sequence[1].replace(/^          /gm,'');
    for(const [before,after]of [
      ['c1_node="$(command -v node)"','c1_node="$C1_TEST_NODE"'],
      ['c1_worker="$RUNNER_TEMP/quotum-c1-aba.mjs"','c1_worker="$C1_TEST_WORKER"'],
      ['c1_rollup="$c1_worker"','c1_rollup="$C1_TEST_ROLLUP"'],
    ]){assert.equal(command.split(before).length,2);command=command.replace(before,after);}
    writeFileSync(shell,command);
    return{directory,module,shell,api:await import(pathToFileURL(module).href) as any};
  }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}

function environment(){
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,expected);
  return()=>{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];};
}
function services(f:any,directory:string,fault='none',client?:any){
  const order:string[]=[],abort=new AbortController(),report:any={stage:'ready'};let closed=false,stopped=false,launches=0;
  class Owner{
    signal=abort.signal;failures:unknown[]=[];
    async start(run:(signal:AbortSignal)=>Promise<any>){this.signal.throwIfAborted();return run(this.signal);}
    async close(){if(closed)return;closed=true;abort.abort();order.push('browser-close');report.cleanup={status:'closed',reaped:true,pipesClosed:true};}
  }
  const deps={Owner,pins:f.api.sourcePins(repository,()=>({status:'available',sha256:clientHash}),(args:string[])=>args[0]==='status'?(fault==='dirty'?' M file':''):args[1]==='HEAD'?sha:tree),
    preparePrefix:async()=>{order.push('prefix');if(client)await client.Person.signUp('http://fixture.invalid',{email:'fixture',name:'Fixture',password:'fixture'},{setupCode:'fixture'});
      if(fault==='cancel')process.emit('SIGHUP');return{evidence:{prepared:true},stop:async()=>{if(stopped)return;assert.equal(closed,true);stopped=true;order.push('prefix-stop');client?.haltRequests();}};},
    launch:async(shim:string,visible:boolean,signal:AbortSignal)=>{launches++;order.push('launch');assert.equal(shim,path.join(f.directory,'shim'));assert.equal(visible,false);assert.equal(signal,abort.signal);
      assert.equal(process.env.QUOTUM_C1_REAL_CHROME,path.join(f.directory,'chrome'));assert.equal(process.env.QUOTUM_C1_RECEIPT,path.join(directory,'shim-first.json'));
      writeFileSync(path.join(directory,'shim-first.json'),JSON.stringify({phase:'exec-ready'}));return{launchReport:()=>report};}};
  return{deps,order,launches:()=>launches,args:[repository,'A1',path.join(f.directory,'chrome'),path.join(f.directory,'shim'),directory]};
}

test('the actual worker restores flags and listeners and rejects dirty source or cancellation',async()=>{
  const f=await fixture(),restore=environment();
  try{for(const fault of ['none','dirty','cancel']){
    const directory=path.join(f.directory,fault),h=services(f,directory,fault),before=keys.map(key=>process.env[key]),signals=['SIGINT','SIGTERM','SIGHUP'];
    const listeners=signals.map(signal=>process.listenerCount(signal)),out=await f.api.workerMain(h.args,h.deps);
    assert.equal(out.code,fault==='none'?0:2);assert.equal(h.launches(),fault==='none'?1:0);
    assert.deepEqual(keys.map(key=>process.env[key]),before);assert.deepEqual(signals.map(signal=>process.listenerCount(signal)),listeners);
    if(fault==='dirty')assert.deepEqual(h.order,[]);else assert.ok(h.order.indexOf('prefix-stop')>h.order.indexOf('browser-close'));
    assert.equal(json(path.join(directory,'worker-first.json')).code,out.code);
  }}finally{restore();rmSync(f.directory,{recursive:true,force:true});}
});

test('actual demo HTTP halt state forbids a second prefix in the same process',async t=>{
  const f=await fixture(),restore=environment(),client=await import(pathToFileURL(path.join(repository,'hub/demo/client.ts')).href+'?startup-prefix-test');
  t.mock.method(globalThis,'fetch',async(_uri:any,options:any)=>{options.signal.throwIfAborted();return new Response(JSON.stringify({user:{id:'fixture'},boards:[{id:'fixture',personal:true}]}),{headers:{'content-type':'application/json','set-cookie':'session=fixture'}});});
  try{
    const a=services(f,path.join(f.directory,'A1'),'none',client),b=services(f,path.join(f.directory,'B'),'none',client);
    assert.equal((await f.api.workerMain(a.args,a.deps)).code,0);
    const out=await f.api.workerMain(b.args,b.deps);assert.equal(out.code,2);assert.equal(b.launches(),0);assert.equal(out.result.canonicalFixturePreparation,false);
  }finally{restore();rmSync(f.directory,{recursive:true,force:true});}
});

function standin(f:any,hold:boolean){
  const file=path.join(f.directory,'standin.mjs');
  writeFileSync(file,`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync,writeSync} from 'node:fs';import path from 'node:path';
import {workerEntry,sourcePins} from ${JSON.stringify(pathToFileURL(f.module).href)};
import {Person,haltRequests} from ${JSON.stringify(pathToFileURL(path.join(repository,'hub/demo/client.ts')).href)};
const [repo,trial,chrome,shim,directory]=process.argv.slice(2),abort=new AbortController(),report={stage:trial==='A2'?'spawn':'ready'},order=[];let closed=false,stopped=false;
globalThis.fetch=async(_uri,options)=>{options.signal.throwIfAborted();return new Response(JSON.stringify({user:{id:'fixture'},boards:[{id:'fixture',personal:true}]}),{headers:{'content-type':'application/json','set-cookie':'session=fixture'}});};
class Owner{signal=abort.signal;failures=[];async start(run){this.signal.throwIfAborted();return run(this.signal);}async close(){if(closed)return;closed=true;abort.abort();order.push('browser-close');report.cleanup={status:'closed',reaped:true,pipesClosed:true};}}
await workerEntry([repo,trial,chrome,shim,directory],{Owner,
 pins:sourcePins(repo,()=>({status:'available',sha256:${JSON.stringify(clientHash)}}),args=>args[0]==='status'?'':args[1]==='HEAD'?${JSON.stringify(sha)}:${JSON.stringify(tree)}),
 preparePrefix:async()=>{await Person.signUp('http://fixture.invalid',{email:'fixture',name:'Fixture',password:'fixture'},{setupCode:'fixture'});order.push('prefix');setInterval(()=>{},1000);return{evidence:{prepared:true},stop:async()=>{if(stopped)return;assert.equal(closed,true);stopped=true;order.push('prefix-stop');haltRequests();writeFileSync(path.join(directory,'order.json'),JSON.stringify(order));}};},
 launch:async(value,visible,signal)=>{assert.equal(value,shim);assert.equal(visible,false);assert.equal(signal,abort.signal);order.push('launch');writeFileSync(path.join(directory,'shim-first.json'),JSON.stringify({phase:'exec-ready'}));
 if(${hold}&&trial==='A1'){
  const pending=new Promise((_resolve,reject)=>{const stop=()=>{writeFileSync(path.join(directory,'launch-aborted.json'),JSON.stringify({pid:process.pid}));reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
  const stat=readFileSync('/proc/self/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/);
  writeSync(1,JSON.stringify({kind:'held-launch-ready',pid:process.pid,birth:fields[19],group:Number(fields[2])})+'\\n');return await pending;
 }if(trial==='A2'){report.failure='original-deadline';throw Object.assign(new Error('original-startup'),{report});}return{launchReport:()=>report};}});
`);return file;
}

function sequence(f:any,hold=false){
  const child=spawn('/bin/bash',[f.shell],{cwd:path.join(repository,'hub'),detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...expected,
    GITHUB_WORKSPACE:repository,RUNNER_TEMP:f.directory,QUOTUM_C1_REAL_CHROME:'/synthetic/chrome',QUOTUM_BENCH_DIAGNOSTICS_DIR:f.directory,GITHUB_OUTPUT:path.join(f.directory,'output'),
    C1_TEST_NODE:process.execPath,C1_TEST_WORKER:standin(f,hold),C1_TEST_ROLLUP:f.module}});
  let closed=false,marker:any,stdout='',stderr='',partial='',yes!:(value:any)=>void,no!:(error:Error)=>void;
  const ready=new Promise<any>((resolve,reject)=>{yes=resolve;no=reject;});void ready.catch(()=>{});
  const sameWorker=()=>{try{const stat=readFileSync('/proc/'+marker.pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);return fields[19]===marker.birth&&Number(fields[2])===child.pid;}catch{return false;}};
  const stop=()=>{if(child.pid&&(!closed||marker&&sameWorker()))try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  const timer=setTimeout(stop,5000); // Only a failure watchdog; assertions use the explicit launch barrier.
  const complete=new Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string}>((resolve,reject)=>{
    child.once('error',error=>{no(error);reject(error);});
    child.stdout.on('data',data=>{stdout+=data;partial+=data;if(stdout.length>65536)stop();const lines=partial.split('\n');partial=lines.pop()!;for(const line of lines)try{const value=JSON.parse(line);if(value.kind==='held-launch-ready'){marker=value;yes(value);}}catch{}});
    child.stderr.on('data',data=>{stderr+=data;if(stderr.length>16384)stop();});
    child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);if(hold&&!marker)no(Error('Worker exited before launch barrier: '+stderr));resolve({code,signal,stderr});});
  });void complete.catch(()=>{});
  return{child,ready,complete,sameWorker,stop:async()=>{stop();await complete.catch(()=>{});}};
}

test('the actual sequence reaps three fresh workers and retains a clean original startup failure', {skip:process.platform!=='linux'},async()=>{
  const f=await fixture(),restore=environment(),run=sequence(f);
  try{
    const out=await run.complete;assert.equal(out.code,1,out.stderr);assert.equal(out.signal,null);const pids:number[]=[];
    for(const trial of ['A1','B','A2']){
      const directory=path.join(f.directory,'probe',trial),result=json(path.join(directory,'result-first.json')),exit=json(path.join(directory,'worker-exit-first.json'));
      assert.equal(exit.status,'reaped');assert.equal(exit.exit,0);assert.equal(exit.pid,result.workerPid);pids.push(exit.pid);
      assert.equal(result.clean,true);assert.equal(result.shimReceipt.phase,'exec-ready');assert.deepEqual(json(path.join(directory,'order.json')),['prefix','launch','browser-close','prefix-stop']);
    }
    assert.equal(new Set(pids).size,3);const result=json(path.join(f.directory,'probe/result-first.json'));
    assert.equal(result.historyReady,true);assert.equal(result.canonicalPass,false);assert.equal(result.C1RepairProven,false);
    assert.equal(result.trials[2].first.status,'failed');assert.equal(result.trials[2].first.report.failure,'original-deadline');
    assert.equal(json(path.join(f.directory,'probe/A2/startup-first.json')).report.failure,'original-deadline');assert.equal(readFileSync(path.join(f.directory,'output'),'utf8'),'history_ready=true\n');
    for(const fault of ['source','pid','deadline','shim']){
      const directory=path.join(f.directory,'probe/B'),file=path.join(directory,'result-first.json'),value=json(file),original=readFileSync(file,'utf8');
      if(fault==='source')value.sourceAfter={...value.source,sha:'d'.repeat(40)};if(fault==='pid')value.workerPid=result.trials[0].workerPid;if(fault==='deadline')value.originalStartupDeadlineMs=25000;if(fault==='shim')value.shimReceipt.phase='unknown';
      writeFileSync(file,JSON.stringify(value));rmSync(path.join(f.directory,'probe/result-first.json'));assert.equal(f.api.rollup(path.join(f.directory,'probe')).historyReady,false);writeFileSync(file,original);
    }
  }finally{await run.stop();restore();rmSync(f.directory,{recursive:true,force:true});}
});

test('the actual sequence forwards TERM, joins owned cleanup and starts no next arm', {skip:process.platform!=='linux'},async()=>{
  const f=await fixture(),run=sequence(f,true);
  try{
    const marker=await run.ready;assert.equal(marker.group,run.child.pid);assert.equal(run.sameWorker(),true);assert.equal(run.child.kill('SIGTERM'),true);
    const out=await run.complete;assert.equal(out.code,130,out.stderr);assert.equal(out.signal,null);assert.equal(run.sameWorker(),false);
    const directory=path.join(f.directory,'probe/A1'),result=json(path.join(directory,'result-first.json'));
    assert.equal(result.workerPid,marker.pid);assert.equal(result.cancelled,true);assert.equal(result.clean,false);assert.equal(json(path.join(directory,'launch-aborted.json')).pid,marker.pid);
    assert.deepEqual(json(path.join(directory,'order.json')),['prefix','launch','browser-close','prefix-stop']);
    for(const file of ['probe/B','probe/A2','probe/result-first.json','output'])assert.equal(existsSync(path.join(f.directory,file)),false);
  }finally{await run.stop();rmSync(f.directory,{recursive:true,force:true});}
});
