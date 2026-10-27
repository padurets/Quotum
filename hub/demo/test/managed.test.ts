import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {SETS} from '../catalogue.js';
import {addressOf, Demo} from '../index.js';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Live,type Stand} from '../setup.js';
import {accountOf,cards,liveStep,type DemoSet} from '../model.js';
import {audited, deadline, partial, signalOptions, start} from '../../server/test/shutdownHarness.js';

test('a supplied demo directory stays owned by its caller on stop', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-demo-owned-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const sentinel = path.join(dir, 'foreign-sentinel');
  writeFileSync(sentinel, 'keep');
  const demo = new Demo({set: SETS[0], scene: SETS[0].scene, still: true, address: addressOf({}), dataDir: dir, onExit: () => {}});
  await demo.stop();
  assert.equal(existsSync(sentinel), true);
});

test('a demo removes a temporary directory it created itself', async () => {
  const demo = new Demo({set: SETS[0], scene: SETS[0].scene, still: true, address: addressOf({}), onExit: () => {}});
  assert.equal(existsSync(demo.dir), true);
  await demo.stop();
  assert.equal(existsSync(demo.dir), false);
});

test('the demo watchdog lets its busy child reach the hub shutdown deadline', signalOptions, async t => {
  const hub = await start(t, false, 'busy');
  await partial(t, hub.port);
  const demo = new Demo({set: SETS[0], scene: SETS[0].scene, still: true, address: addressOf({}), dataDir: hub.dir, onExit: () => {}});
  // Exercise the real parent stop with an owned child, without seeding a full board.
  Object.assign(demo, {hub: hub.child});
  await deadline(demo.stop(), 6500);
  assert.deepEqual(await hub.exited, {code: 0, signal: null}, 'the parent did not SIGKILL before finalization');
  audited(hub.dir);
});

test('accepted scheduled Demo reports retain real invocation receipts across the captured timer boundary',async t=>{
  const first=1_793_093_725_000;let now=first,accepted=true,blocked:Promise<void>|undefined;
  t.mock.method(Date,'now',()=>now);
  const timers=new Map<object,{run:()=>void;ms:number}>();
  t.mock.method(globalThis,'setTimeout',((run:()=>void,ms:number)=>{const token={};timers.set(token,{run,ms});return token;}) as unknown as typeof setTimeout);
  t.mock.method(globalThis,'clearTimeout',((token:object)=>{timers.delete(token);}) as typeof clearTimeout);
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-demo-receipt-'));t.after(()=>{timers.clear();rmSync(dir,{recursive:true,force:true});});
  const card={...cards(SETS[0]).find(card=>card.id==='antigravity')!,machines:['laptop'],agents:[]};
  const set:DemoSet={id:'tick-receipts',about:'',scene:SETS[0].scene,entries:[{kind:'machine',id:'laptop',expect:[]},card]};
  const demo=new Demo({set,scene:set.scene,still:true,idleAgents:true,address:addressOf({}),dataDir:dir,start:first-60_000,onExit:()=>{}});
  const sent:number[]=[],stand={set,start:demo.start,agents:new Map([['laptop',{clientSessionCount:0,sessions:async(sessions:object[],at:number)=>{sent.push(at);await blocked;return {accepted:accepted?sessions.length:0};}}]])} as unknown as Stand;
  // Execute the actual Live publisher callback and serialized scheduler, without starting or seeding a hub.
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),from=source.indexOf('      const live = new Live('),to=source.indexOf('      await tick();',from);
  assert.ok(from>=0&&to>from);
  const context={Live,stand,set,still:true,cards,accountOf,liveStep,TICK:15_000,Date,setTimeout,console:{error(){}},install:null as unknown as (this:Demo)=>void};
  runInNewContext(ts.transpileModule(`globalThis.install=function(){${source.slice(from,to)}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);context.install.call(demo);
  const runtime=demo as unknown as {tick:(manual?:boolean)=>Promise<void>;reporting:Promise<void>;reports:Set<(machine:string,at:number)=>void>};
  const seen:ReturnType<Demo['reportReceipt']>[]=[];runtime.reports.add((machine,at)=>seen.push(demo.reportReceipt(machine,at)));
  const fire=async()=>{const timer=[...timers].find(([,timer])=>timer.ms<=15_000);assert.ok(timer);timers.delete(timer[0]);timer[1].run();await runtime.reporting;};
  const initial=demo.nextReport('laptop');await runtime.tick();assert.equal(await initial,first);
  for(const delta of [14999,30000,45000]){now=first+delta;const next=demo.nextReport('laptop');await fire();assert.equal(await next,now);}
  assert.deepEqual(sent,[first,first+14999,first+30000,first+45000]);
  assert.deepEqual(seen.map(row=>row.ordinal),[1,2,3,4]);assert.ok(seen.every(row=>row.manual===false));
  assert.deepEqual(seen.slice(1).map((row,i)=>row.at-seen[i].at),[14999,15001,15000]);
  assert.deepEqual(seen.slice(1).map((row,i)=>Math.floor((row.at-demo.start)/15000)-Math.floor((seen[i].at-demo.start)/15000)),[0,2,1]);
  const copy=demo.reportReceipt('laptop',now);Object.assign(copy,{ordinal:999});assert.equal(demo.reportReceipt('laptop',now).ordinal,4);
  assert.throws(()=>demo.reportReceipt('missing',now));assert.throws(()=>demo.reportReceipt('laptop',now-1));
  accepted=false;now=first+60000;await fire();assert.equal(seen.length,4,'rejected session counts cannot publish a receipt');assert.throws(()=>demo.reportReceipt('laptop',now));
  accepted=true;now++;assert.equal(await demo.reportNow('laptop'),now);assert.deepEqual(seen.at(-1),{at:now,ordinal:6,manual:true});
  let release!:()=>void;blocked=new Promise<void>(resolve=>{release=resolve;});
  const scheduled=runtime.tick();await Promise.resolve();const manual=runtime.tick(true);release();await Promise.all([scheduled,manual]);
  assert.deepEqual(seen.slice(-2).map(row=>row.manual),[false,true],'a queued manual writer cannot relabel the active scheduled invocation');
  assert.deepEqual(seen.slice(-2).map(row=>row.ordinal),[7,8]);
});
