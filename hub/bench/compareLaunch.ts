/** Temporary, paired diagnostic. Its reports never substitute a canonical benchmark gate. */
import childProcess, {execFileSync,type ChildProcess} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {Demo,addressOf,prepare} from '../demo/index.js';
import {SETS} from '../demo/catalogue.js';
import {people} from '../demo/model.js';
import {panningSet} from './fixture.js';
import {panning} from './panning.js';
import {percentile} from './budget.js';
import {overviewCards,warmUntil} from './still.js';
import {findChrome,launchChrome,openTab,type Browser} from './cdp.js';

const baselineFile=process.env.QUOTUM_COMPARE_BASELINE;
if(!baselineFile)throw new Error('A frozen baseline launcher file is required');
const baseline=await import(pathToFileURL(path.resolve(baselineFile)).href) as {launchChrome:typeof launchChrome};
const chrome=findChrome(process.env);
if(!chrome)throw new Error('The runner must already have Chrome');
const original=childProcess.spawn;
type Native={pid:number;birth:string;name:string;ppid:number;pgrp:number;session:number;nice:number;state:string};
type Owned={child:ChildProcess;profile:string;detached:boolean;label:string;known:Map<number,Native>};
const owned:Owned[]=[];
let label='setup';
childProcess.spawn=((...args:unknown[])=>{
  const child=Reflect.apply(original,childProcess,args) as ChildProcess;
  if(args[0]===chrome){
    const values=args[1] as string[];
    owned.push({child,profile:values.find(value=>value.startsWith('--user-data-dir='))!.slice(16),detached:Boolean((args[2] as {detached?:boolean})?.detached),label,known:new Map()});
  }
  return child;
}) as typeof original;
syncBuiltinESMExports();
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const bounded=async<T>(task:Promise<T>,ms:number)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Diagnostic cleanup deadline')),ms);})]);}
  finally{clearTimeout(timer);}
};
const port=await new Promise<number>(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const value=(server.address() as {port:number}).port;server.close(()=>resolve(value));});});
const address=addressOf({QUOTUM_PORT:String(port),QUOTUM_BIND:'127.0.0.1'});
await prepare(address);
const set=panningSet(SETS[0]);
const demo=new Demo({set,scene:set.scene,still:true,idleAgents:true,money:false,address,onExit:code=>{if(code)process.exitCode=1;}});
const runs:unknown[]=[];
const digest=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
const result={baseline:process.env.QUOTUM_COMPARE_BASE_SHA,intendedHead:process.env.QUOTUM_COMPARE_HEAD_SHA,checkout:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),githubSha:process.env.GITHUB_SHA,node:process.version,cpu:os.cpus()[0]?.model,cpus:os.availableParallelism(),launcherHashes:{main:await digest(baselineFile),branch:await digest('bench/cdp.ts')},sequence:['main','branch','branch','main','branch','main','main','branch'],runs};
const save=async()=>writeFile('compare-launch.json',JSON.stringify(result,null,2)+'\n');
const stat=async(pid:number):Promise<Native|null>=>{
  const value=await readFile('/proc/'+pid+'/stat','utf8').catch(()=> '');
  if(!value)return null;
  const fields=value.slice(value.lastIndexOf(')')+2).trim().split(/\s+/);
  return {pid,birth:fields[19],name:value.slice(value.indexOf('(')+1,value.lastIndexOf(')')),state:fields[0],ppid:Number(fields[1]),pgrp:Number(fields[2]),session:Number(fields[3]),nice:Number(fields[16])};
};
const inventory=async()=>{
  const rows:Native[]=[];
  for(const value of await readdir('/proc'))if(/^\d+$/.test(value)){
    const current=await stat(Number(value));
    if(current&&/^chrome|^google-chrome/.test(current.name)&&current.state!=='Z')rows.push(current);
  }
  return rows;
};
const native=async(pid:number)=>{
  const value=await stat(pid);
  const group=await readFile('/proc/'+pid+'/autogroup','utf8').catch(()=> 'unavailable');
  return {...value,autogroup:group.trim()};
};
const snapshot=async(record:Owned)=>{
  if(record.child.exitCode!==null||record.child.signalCode!==null)return;
  const root=await stat(record.child.pid!);if(!root)return;
  const previous=record.known.get(root.pid);if(previous&&previous.birth!==root.birth)throw new Error('Owned root PID was replaced');
  record.known.set(root.pid,root);
  const queue=[root];
  for(let i=0;i<queue.length&&i<64;i++){
    const parent=queue[i];
    const text=await readFile('/proc/'+parent.pid+'/task/'+parent.pid+'/children','utf8').catch(()=> '');
    for(const value of text.trim().split(/\s+/)){
      const child=await stat(Number(value));
      const confirmed=await stat(parent.pid);
      if(!child||child.ppid!==parent.pid||confirmed?.birth!==parent.birth)continue;
      record.known.set(child.pid,child);if(queue.length<64&&!queue.some(p=>p.pid===child.pid))queue.push(child);
    }
  }
};
const emergency=async(record:Owned)=>{
  const child=record.child;
  if(child.exitCode===null&&child.signalCode===null){
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    if(record.detached){try{process.kill(-child.pid!,'SIGTERM');}catch{}}else child.kill('SIGTERM');
    const hard=setTimeout(()=>{if(record.detached){try{process.kill(-child.pid!,'SIGKILL');}catch{}}else child.kill('SIGKILL');},5000);
    const bound=await Promise.race([exited.then(()=>true),pause(7000).then(()=>false)]);clearTimeout(hard);
    if(!bound)throw new Error('Owned diagnostic browser did not exit');
  }
  child.stdout?.destroy();child.stderr?.destroy();child.unref();
  for(const remembered of record.known.values()){
    let current=await stat(remembered.pid);
    if(!current||current.birth!==remembered.birth||current.state==='Z')continue;
    try{process.kill(current.pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    const until=Date.now()+5000;
    while(current&&current.birth===remembered.birth&&current.state!=='Z'&&Date.now()<until){await pause(50);current=await stat(remembered.pid);}
    if(current&&current.birth===remembered.birth&&current.state!=='Z'){
      try{process.kill(current.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      await pause(100);current=await stat(remembered.pid);
      if(current&&current.birth===remembered.birth&&current.state!=='Z')throw new Error('Known diagnostic descendant remains alive');
    }
  }
  rmSync(record.profile,{recursive:true,force:true});
};
let active:Browser|undefined;
try{
  const stand=await demo.run(),ana=stand.people.get(people(set)[0].id)!,board=ana.personalBoard;
  for(let i=0;i<result.sequence.length;i++){
    const variant=result.sequence[i];label=i+':'+variant;
    let tab:Awaited<ReturnType<typeof openTab>>|undefined;
    const started=performance.now(),before=owned.length;
    const beforeInventory=await inventory();
    const run:Record<string,unknown>={index:i,variant,startedAt:new Date().toISOString(),observed:[],beforeInventory};runs.push(run);await save();
    let watch:ReturnType<typeof setInterval>|undefined,watching:Promise<void>|undefined;
    try{
      watch=setInterval(()=>{const record=owned.at(-1);if(record?.label===label&&!watching){watching=snapshot(record).catch(error=>{run.trackingError=String(error);}).finally(()=>{watching=undefined;});}},50);
      active=await(variant==='main'?baseline.launchChrome(chrome,false):launchChrome(chrome,false));
      run.launchMs=Math.round(performance.now()-started);
      const version=await fetch(active.endpoint+'/json/version',{signal:AbortSignal.timeout(5000),redirect:'error'}).then(response=>response.json()) as {Browser:string};
      run.commonReadyMs=Math.round(performance.now()-started);run.browser=version.Browser;
      const record=owned.at(-1)!;run.process=await native(record.child.pid!);run.parent=await native(process.pid);run.detached=record.detached;
      clearInterval(watch);await watching;await snapshot(record);
      tab=await openTab(active);const {cdp}=tab;
      await cdp.send('Page.enable');await cdp.send('Network.enable');await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
      const split=ana.cookie.indexOf('=');await cdp.send('Network.setCookie',{name:ana.cookie.slice(0,split),value:ana.cookie.slice(split+1),url:address.base,httpOnly:true,sameSite:'Lax'});
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('quotum.locale','en');"});
      await cdp.send('Page.navigate',{url:address.base+'/'});
      const until=Date.now()+30000;
      while(!await cdp.evaluate<number>("document.querySelectorAll('.card:not(.is-loading)').length")){if(Date.now()>until)throw new Error('Board did not appear');await pause(50);}
      const opened=Date.now();await pause(Math.max(0,warmUntil(await overviewCards(value=>ana.get(value),board),opened)-Date.now()));
      const observed=run.observed as unknown[];
      const measured={send:cdp.send.bind(cdp),evaluate:async<T>(expression:string):Promise<T>=>{
        const value=await cdp.evaluate<T>(expression);
        if(value&&typeof value==='object'&&Array.isArray((value as {frames?:unknown}).frames)&&Array.isArray((value as {latency?:unknown}).latency)){
          observed.push(value);await save();
        }
        return value;
      }};
      const outcome=await panning(measured);run.problems=outcome.problems;
      run.reports=outcome.reports.map(report=>({...report,frameP95Ms:percentile(report.frames,.95),frameP99Ms:percentile(report.frames,.99),inputP95Ms:percentile(report.latency,.95)}));
      console.log(JSON.stringify({index:i,variant,launchMs:run.launchMs,process:run.process,problems:outcome.problems,reports:outcome.reports.map(report=>({period:report.period,frameP95Ms:percentile(report.frames,.95),frameP99Ms:percentile(report.frames,.99),inputP95Ms:percentile(report.latency,.95)}))}));
    }catch(error){run.error=String(error);console.error(JSON.stringify({index:i,variant,error:String(error)}));await save();}
    finally{
      try{
        clearInterval(watch);await watching;
        for(const record of owned.slice(before))await snapshot(record);
        if(tab)await bounded(tab.close(),10000).catch(error=>{run.tabCleanupError=String(error);});
        if(active)await bounded(active.close(),10000).catch(error=>{run.browserCleanupError=String(error);});active=undefined;
        for(const record of owned.slice(before)){await emergency(record);run.owned=[...record.known.values()];}
        run.afterInventory=await inventory();
        const leftovers=(run.afterInventory as Native[]).filter(current=>!beforeInventory.some(old=>old.pid===current.pid&&old.birth===current.birth));
        if(leftovers.length){run.contaminated=true;run.untrackedChrome=leftovers;}
      }catch(error){run.cleanupError=String(error);run.contaminated=true;}
      finally{await save();}
    }
    if(run.contaminated)throw new Error('Later trials would be contaminated; preserved all readings without an absence claim');
  }
}finally{
  if(active)await bounded(active.close(),10000).catch(()=>undefined);
  try{for(const record of owned)await emergency(record);}
  finally{await demo.stop();await save();childProcess.spawn=original;syncBuiltinESMExports();}
}
