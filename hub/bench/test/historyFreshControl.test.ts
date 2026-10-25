import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';

const {freshHistoryControl,qualifyPrefix,executePrefix}=await import(new URL('../historyFreshControl.mjs',import.meta.url).href);
const sha='1'.repeat(40),client='2'.repeat(64),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const closed={status:'closed',reaped:true,pipesClosed:true};
function retained(directory:string,pid:number,patch:(files:Record<string,any>)=>void=()=>{}){
  const root=path.join(directory,id);mkdirSync(root,{recursive:true});
  const files:Record<string,any>={
    'result.json':{mode:'diagnostic',kind:'history-first-native-prefix',canonicalPass:false,status:'observations-completed',problems:[],
      historyTraffic:{reports:Array(24).fill({}),invalidated:[],cancellations:{reports:Array(6).fill({}),invalidated:[]},
        native:{reports:['all-accounting','budget','budget','quota'].map(scope=>({name:'suffix/1/history/browser/1d/history/0ms/0.5/take1/'+scope})),invalidated:[],problems:[]},nativeCancellations:null}},
    'cleanup.json':{failures:[],browser:{pid,ownedGroup:true,cleanup:{status:'closed',reaped:true,pipesClosed:true}}},
    'scroll-control-disposition.json':{status:'noC3Observed'},
  };
  patch(files);
  const pins=Object.entries(files).map(([name,value])=>{const body=JSON.stringify(value);writeFileSync(path.join(root,name),body);return{name,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),truncated:false};});
  writeFileSync(path.join(root,'manifest.json'),JSON.stringify({id,status:'diagnostic',phase:'cleanup',errors:[],identity:{sha,tree:sha,dirty:false,client:{sha256:client}},files:pins}));
}
test('fresh control uses six separate children and evidence directories with ordinary renderer binding',async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'quotum-fresh-control-')),cancel=new AbortController(),seen:string[]=[];
  try{
    const env={QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:'1',QUOTUM_BENCH_SOURCE_SHA:sha,QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:client,QUOTUM_BENCH_DIAGNOSTICS_DIR:directory};
    const code=await freshHistoryControl({env,signal:cancel.signal,execute:async(childEnv:Record<string,string>)=>{
      assert.equal(childEnv.QUOTUM_BENCH_HISTORY_FIRST_NATIVE,'1');assert.equal(childEnv.QUOTUM_BENCH_HISTORY_SCROLL_CONTROL,undefined);assert.equal(childEnv.QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX,undefined);
      const round=childEnv.QUOTUM_BENCH_DIAGNOSTICS_DIR;assert.ok(!seen.includes(round));seen.push(round);retained(round,100+seen.length);return{code:0,signal:null,failed:false,cleanup:closed};
    }});
    assert.equal(code,0);assert.equal(seen.length,6);
    const parent=path.dirname(seen[0]),summary=readdirSync(parent).find(name=>name!==path.basename(seen[0])&&!name.startsWith('round-'))!;
    const result=JSON.parse(readFileSync(path.join(parent,summary,'fresh-history-result.json'),'utf8'));
    assert.deepEqual(result,{mode:'diagnostic',canonicalPass:false,status:'noC3Observed',completed:6,expected:6});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('first child failure, bad evidence, duplicate browser and cancellation stop later launches',async()=>{
  for(const fault of ['exit','signal','missing','cleanup','duplicate','cancel','owner-residual']){
    const directory=mkdtempSync(path.join(os.tmpdir(),'quotum-fresh-control-')),cancel=new AbortController();let runs=0;
    try{
      const env={QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:'1',QUOTUM_BENCH_SOURCE_SHA:sha,QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:client,QUOTUM_BENCH_DIAGNOSTICS_DIR:directory};
      const work=freshHistoryControl({env,signal:cancel.signal,execute:async(childEnv:Record<string,string>)=>{
        runs++;if(fault==='cancel')cancel.abort();
        if(fault==='missing')return{code:0,signal:null,cleanup:closed};
        retained(childEnv.QUOTUM_BENCH_DIAGNOSTICS_DIR,100,files=>{if(fault==='cleanup')files['cleanup.json'].browser.cleanup.reaped=false;});
        return{code:fault==='exit'?17:0,signal:fault==='signal'?'SIGTERM':null,cleanup:fault==='owner-residual'?{status:'residual'}:closed};
      }});
      if(['missing','cleanup','duplicate'].includes(fault))await assert.rejects(work);
      else assert.equal(await work,fault==='exit'?17:1);
      assert.equal(runs,fault==='duplicate'?2:1);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});
test('cancellation reaps a real TERM-ignoring child within the existing process-owner cleanup bound',{skip:process.platform!=='linux',timeout:12_000},async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'quotum-fresh-child-')),marker=path.join(directory,'ready'),cancel=new AbortController();
  let child:ReturnType<typeof spawn>|undefined;
  const work=executePrefix({...process.env},cancel.signal,(_file:string,_args:string[],options:any)=>{
    child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",marker],options);return child;
  });
  try{
    const until=performance.now()+4000;while(!existsSync(marker)&&performance.now()<until)await pause(10);
    assert.ok(existsSync(marker));cancel.abort();
    const result=await work;assert.equal(result.signal,'SIGKILL');assert.equal(result.cleanup.status,'closed');
    assert.equal(result.cleanup.kill,true);assert.equal(result.cleanup.reaped,true);assert.equal(result.cleanup.pipesClosed,true);
    assert.ok(result.cleanup.elapsedMs<7500);assert.throws(()=>process.kill(child!.pid!,0),{code:'ESRCH'});
  }finally{cancel.abort();await work;rmSync(directory,{recursive:true,force:true});}
});
test('prefix qualification rejects incomplete work and changed or unpinned evidence',()=>{
  const env={QUOTUM_BENCH_SOURCE_SHA:sha,QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:client};
  for(const fault of ['models','cancellations','native','canonical','tamper','pin']){
    const directory=mkdtempSync(path.join(os.tmpdir(),'quotum-fresh-prefix-'));
    try{
      retained(directory,100,files=>{const result=files['result.json'];
        if(fault==='models')result.historyTraffic.reports.pop();
        if(fault==='cancellations')result.historyTraffic.cancellations.invalidated.push({});
        if(fault==='native')result.historyTraffic.native.reports.push({});
        if(fault==='canonical')result.canonicalPass=true;
      });
      if(fault==='tamper')writeFileSync(path.join(directory,id,'cleanup.json'),'{}');
      if(fault==='pin')env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256='3'.repeat(64);
      assert.throws(()=>qualifyPrefix(directory,env));env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256=client;
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});
