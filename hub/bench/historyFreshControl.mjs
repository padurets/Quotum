import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Evidence} from './evidence.ts';
import {browserProcess} from './browserProcess.ts';

const ROUNDS=6, LIMIT=1024*1024;

/** A zero exit alone cannot qualify a partial run or an unconfirmed browser release. */
export function qualifyPrefix(directory,env){
  const entries=readdirSync(directory);assert.equal(entries.length,1);
  assert.match(entries[0],/^[a-f0-9-]{36}$/);
  const root=path.join(directory,entries[0]);
  const read=name=>{const file=path.join(root,name);assert.ok(statSync(file).size<=LIMIT);return readFileSync(file);};
  const manifest=JSON.parse(read('manifest.json'));
  assert.equal(manifest.id,entries[0]);assert.match(manifest.identity.tree,/^[a-f0-9]{40}$/);
  assert.equal(manifest.status,'diagnostic');assert.equal(manifest.phase,'cleanup');assert.deepEqual(manifest.errors,[]);
  assert.equal(manifest.identity.sha,env.QUOTUM_BENCH_SOURCE_SHA);assert.equal(manifest.identity.dirty,false);
  assert.equal(manifest.identity.client.sha256,env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256);
  assert.ok(manifest.files.length>0&&manifest.files.length<=128);
  let bytes=0;const pins=new Map();
  for(const pin of manifest.files){
    assert.match(pin.name,/^[a-zA-Z0-9_-]+\.json$/);assert.equal(pin.truncated,false);assert.ok(!pins.has(pin.name));
    const body=read(pin.name);bytes+=body.length;assert.ok(bytes<=20*LIMIT);
    assert.equal(body.length,pin.bytes);assert.equal(createHash('sha256').update(body).digest('hex'),pin.sha256);
    pins.set(pin.name,JSON.parse(body));
  }
  const result=pins.get('result.json'),traffic=result?.historyTraffic;
  assert.equal(result?.mode,'diagnostic');assert.equal(result.kind,'history-first-native-prefix');assert.equal(result.canonicalPass,false);
  assert.equal(result.status,'observations-completed');assert.deepEqual(result.problems,[]);
  assert.equal(traffic.reports.length,24);assert.deepEqual(traffic.invalidated,[]);
  assert.equal(traffic.cancellations.reports.length,6);assert.deepEqual(traffic.cancellations.invalidated,[]);
  assert.deepEqual(traffic.native.invalidated,[]);assert.deepEqual(traffic.native.problems,[]);
  const cohort='suffix/1/history/browser/1d/history/0ms/0.5/take1/';
  assert.deepEqual(traffic.native.reports.map(report=>report.name).sort(),['all-accounting','budget','budget','quota'].map(scope=>cohort+scope));
  assert.equal(traffic.nativeCancellations,null);
  const cleanup=pins.get('cleanup.json'),browser=cleanup?.browser;
  assert.deepEqual(cleanup?.failures,[]);assert.equal(browser?.cleanup?.status,'closed');
  assert.equal(browser.cleanup.reaped,true);assert.equal(browser.cleanup.pipesClosed,true);
  assert.ok(Number.isSafeInteger(browser.pid)&&browser.pid>0);assert.equal(browser.ownedGroup,true);
  assert.equal(pins.get('scroll-control-disposition.json')?.status,'noC3Observed');
  return {id:manifest.id,pid:browser.pid,sha:manifest.identity.sha,tree:manifest.identity.tree,clientHash:manifest.identity.client.sha256};
}

export async function executePrefix(env,signal,spawnChild=spawn){
  signal.throwIfAborted();
  const child=spawnChild(process.execPath,['--import','tsx',path.join(import.meta.dirname,'index.ts'),'--ci','--scope','history'],{env,stdio:'inherit',detached:true});
  const owner=browserProcess(child,true);let failed=false,release;
  const cancelled=new Promise(resolve=>{release=resolve;});
  const closed=new Promise(resolve=>{child.once('error',()=>{failed=true;});child.once('close',resolve);});
  const cancel=()=>{void owner.close().then(release);};
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  try{
    await Promise.race([closed,cancelled]);
    const cleanup=await owner.close();
    return {code:child.exitCode,signal:child.signalCode,failed,cleanup};
  }finally{signal.removeEventListener('abort',cancel);}
}

/** Each child owns its entire fixture, browser, profile and cleanup. Never retry a failure. */
export async function freshHistoryControl({env=process.env,signal,execute=executePrefix}){
  assert.equal(env.QUOTUM_BENCH_HISTORY_SCROLL_CONTROL,'1');
  assert.ok(env.QUOTUM_BENCH_DIAGNOSTICS_DIR);assert.match(env.QUOTUM_BENCH_SOURCE_SHA??'',/^[a-f0-9]{40}$/);
  assert.match(env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256??'',/^[a-f0-9]{64}$/);
  assert.ok(!env.QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX&&!env.QUOTUM_BENCH_HISTORY_FIRST_NATIVE&&!env.QUOTUM_C3_CHROME);
  const root=path.join(env.QUOTUM_BENCH_DIAGNOSTICS_DIR,'fresh-'+randomUUID());mkdirSync(root,{recursive:true,mode:0o700});
  const evidence=new Evidence(root),rounds=[],pids=new Set();let code=1,status='inconclusive';
  try{
    for(let round=1;round<=ROUNDS;round++){
      signal.throwIfAborted();
      const directory=path.join(root,'round-'+round);
      const childEnv={...env,QUOTUM_BENCH_DIAGNOSTICS_DIR:directory,QUOTUM_BENCH_HISTORY_FIRST_NATIVE:'1'};
      delete childEnv.QUOTUM_BENCH_HISTORY_SCROLL_CONTROL;delete childEnv.QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX;
      console.error(`bench: fresh browser prefix ${round}/${ROUNDS}; diagnostic only`);
      const exit=await execute(childEnv,signal);rounds.push({round,...exit});
      evidence.save('fresh-history-rounds',{mode:'diagnostic',canonicalPass:false,expected:ROUNDS,rounds});
      if(signal.aborted||exit.failed||exit.signal||exit.code!==0||exit.cleanup?.status!=='closed'){code=Number.isInteger(exit.code)&&exit.code>0?exit.code:1;return code;}
      const receipt=qualifyPrefix(directory,env);assert.ok(!pids.has(receipt.pid),'browser PID reused');pids.add(receipt.pid);
      Object.assign(rounds.at(-1),receipt);evidence.save('fresh-history-rounds',{mode:'diagnostic',canonicalPass:false,expected:ROUNDS,rounds});
    }
    signal.throwIfAborted();status='noC3Observed';code=0;return code;
  }finally{
    evidence.save('fresh-history-result',{mode:'diagnostic',canonicalPass:false,status:signal.aborted?'cancelled':status,completed:rounds.filter(round=>round.id).length,expected:ROUNDS});
    evidence.finish(signal.aborted?'cancelled':code?'failed':'diagnostic',{status:rounds.length&&rounds.every(round=>round.id)?'verified-prefix-cleanup':'unconfirmed'});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const cancellation=new AbortController(),cancel=()=>cancellation.abort();
  const signals=['SIGINT','SIGTERM','SIGHUP'];for(const signal of signals)process.on(signal,cancel);
  try{process.exitCode=await freshHistoryControl({signal:cancellation.signal});}
  catch{console.error('bench: fresh history control inconclusive; inspect retained round evidence');process.exitCode=1;}
  finally{for(const signal of signals)process.off(signal,cancel);}
}
