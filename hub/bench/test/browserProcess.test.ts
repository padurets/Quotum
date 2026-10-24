import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {processIdentity, type ProcessCleanup} from '../browserProcess.js';

test('ownership counters preserve proc units without exporting a process name or malformed counters',()=>{
  const fields=Array.from({length:50},(_,i)=>String(i));fields[0]='D';
  const stat=()=>`99 (private path ) secret-canary) ${fields.join(' ')}`;
  assert.deepEqual(processIdentity(99,stat()),{pid:99,state:'D',parent:1,group:2,session:3,birth:'19',
    minorFaults:7,majorFaults:9,userTicks:11,systemTicks:12,blockIoTicks:39});
  fields[9]='secret-canary';fields[39]='9007199254740992';
  const identity=processIdentity(99,stat());
  assert.equal(identity?.majorFaults,null);assert.equal(identity?.blockIoTicks,null);
  assert.doesNotMatch(JSON.stringify(identity),/private|secret-canary|path/);
  fields[19]='invalid';
  assert.equal(processIdentity(99,stat()),null,'malformed birth grants no process identity');
  assert.equal(processIdentity(99,''),null);
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Run the actual module with a stalled filesystem and an explicit monotonic timer queue. */
function cleanupFixture(block: 'directory'|'stat'|null) {
  let now=0,nextTimer=0,release=()=>{},held=false;
  const timers=new Map<number,{callback:()=>void;at:number}>(),signals:{pid:number;signal:string}[]=[];
  const setTimeout=(callback:()=>void,ms:number)=>{timers.set(++nextTimer,{callback,at:now+ms});return nextTimer;};
  const fields=Array<string>(50).fill('0');fields[0]='S';fields[1]='1';fields[2]=fields[3]='91';fields[19]='123';
  const stat='91 (fixture) '+fields.join(' ');
  const pending=()=>new Promise<string|string[]>(resolve=>{held=true;release=()=>resolve(block==='directory'?['91']:stat);});
  const io={readdir:async()=>block==='directory'?pending():['91'],readFile:async()=>block==='stat'?pending():stat};
  const compile=(file:string,require:(name:string)=>unknown)=>{
    const exports:Record<string,unknown>={};
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    runInNewContext(code,{exports,require,AbortController,performance:{now:()=>now},setTimeout,clearTimeout:(id:number)=>timers.delete(id),
      process:{platform:'linux',kill:(pid:number,signal:string)=>signals.push({pid,signal})}});
    return exports;
  };
  const deadlines=compile('../deadline.ts',()=>{throw Error('unexpected dependency');});
  const module=compile('../browserProcess.ts',name=>{
    if(name==='node:fs/promises')return io;
    if(name==='node:child_process')return {spawn};
    if(name==='./deadline.js')return deadlines;
    throw Error('unexpected dependency');
  }) as unknown as typeof import('../browserProcess.js');
  const child=Object.assign(new EventEmitter(),{pid:91,exitCode:null as number|null,signalCode:null,stdout:{destroy(){}},stderr:{destroy(){}},unref(){}});
  const owner=module.browserProcess(child as unknown as import('node:child_process').ChildProcess,true);
  return {owner,child,signals,held:()=>held,release:()=>release(),timers,
    advance:async(ms:number)=>{now+=ms;for(const [id,timer]of timers)if(timer.at<=now){timers.delete(id);timer.callback();}await flush();}};
}

for(const block of ['directory','stat'] as const)test(`cleanup bounds a stalled ${block} read and cannot signal after its deadline`,async()=>{
  const f=cleanupFixture(block);let result:ProcessCleanup|undefined;
  const closing=f.owner.close();closing.then(value=>{result=value;});
  assert.equal(f.owner.close(),closing,'cleanup is owned once');
  await flush();assert.equal(f.held(),true);
  await f.advance(7000);
  assert.equal(result?.status,'residual','a deadline is not confirmation of process exit');
  assert.equal(result?.elapsedMs,7000);assert.equal(result?.reaped,false);
  assert.equal(result?.term,false);assert.equal(result?.kill,false);
  const saved=JSON.stringify(result);
  f.release();await flush();
  assert.equal(f.signals.length,0,'a late identity cannot authorize TERM or KILL');
  assert.equal(JSON.stringify(result),saved,'late reads cannot revise the returned receipt');
  assert.equal(f.timers.size,0);await closing;
});

test('a confirmed process and pipe exit still completes cleanup before the deadline',async()=>{
  const f=cleanupFixture(null);f.child.exitCode=0;f.child.emit('exit',0,null);f.child.emit('close',0,null);
  const result=await f.owner.close();
  assert.equal(result.status,'closed');assert.equal(result.elapsedMs,0);
  assert.equal(result.reaped,true);assert.equal(result.pipesClosed,true);
  assert.equal(f.signals.length,0);assert.equal(f.timers.size,0);
});
