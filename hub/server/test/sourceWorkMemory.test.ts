import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceWorkCurves,sourceWorkTape,mergeSourceWorkTape,type SourceWorkTape} from '../domain/periodCurves.js';
import {HistoryTiles} from '../history.js';
import type {Store} from '../store/store.js';
import {HistoryPool} from '../../ui/lib/historyPool.js';

const H=3_600_000,limited=new Error('history_limit');
const changes=()=>Array.from({length:20_000},(_,i)=>[i,i%2?-1:1]).flat();
const tape=(pattern:number[]):SourceWorkTape=>({version:1,from:0,cut:H,patterns:[pattern],sources:[{id:'codex:test',knownFrom:0,blocks:[0,0]}]});
function staged(initial:number,free:number){
  const pool=new HistoryPool(),flight={role:'visible' as const},pinned=pool.budget-initial-free;
  pool.register({estimatedBytes:pinned,evictionCandidates:()=>[]});assert.ok(pool.reserve(flight,initial));let bytes=initial;
  return {pool,flight,pinned,get bytes(){return bytes;},add:(size:number)=>{if(!pool.reserve(flight,bytes+size))throw limited;bytes+=size;},drop:(size:number)=>{bytes-=size;assert.ok(bytes>=initial);assert.ok(pool.reserve(flight,bytes));}};
}

test('source decoding refuses pattern and block scratch before reading their entries and releases staging',()=>{
  for(const kind of ['pattern','blocks'] as const){
    let reads=0;const watch=(values:number[])=>new Proxy(values,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
    const input=kind==='pattern'?tape(watch(changes())):tape([0,1,1,-1]);
    if(kind==='blocks')input.sources[0].blocks=watch(Array.from({length:720},(_,hour)=>[hour,0]).flat());
    const initial=JSON.stringify(input).length*3,memory=staged(initial,1024);reads=0;
    assert.throws(()=>sourceWorkCurves(input,memory.add,undefined,memory.drop),error=>error===limited);
    assert.equal(reads,0,kind+' scratch must be admitted before the first numeric entry');
    assert.equal(memory.bytes,initial);assert.equal(memory.pool.estimatedBytes,memory.pinned+initial);memory.pool.release(memory.flight);
  }
});

test('source export admits growing values and dictionary keys before materializing them',()=>{
  const curves=sourceWorkCurves(tape(changes())),originalPush=Array.prototype.push,originalJoin=Array.prototype.join;
  let pushes=0,joins=0,watch=false;
  Array.prototype.push=function<T>(this:T[],...items:T[]){if(watch&&items.length===2&&typeof items[0]==='number'&&Math.abs(Number(items[1]))===1)pushes++;return Reflect.apply(originalPush,this,items);};
  Array.prototype.join=function<T>(this:T[],separator?:string){if(watch&&this.length===40_000)joins++;return Reflect.apply(originalJoin,this,[separator]);};
  try{for(const free of [1024,1024*1024]){
    const tiles=new HistoryTiles({} as Store),pin=tiles.reservation(),growth=tiles.reservation();pin.add(32*1024*1024-free);pushes=0;joins=0;
    try{
      watch=true;assert.throws(()=>sourceWorkTape(curves,0,H,new Map([['codex:test',0]]),growth.add,growth.remove),/history_limit/);
      watch=false;
      if(free===1024)assert.ok(pushes<100,'refusal stops before expanding the complete pattern');
      assert.equal(joins,0,'a dictionary key must not be created before its reservation');
      assert.doesNotThrow(()=>growth.add(free),'failed export released every scratch charge');growth.remove(free);
    }finally{watch=false;growth.close();pin.close();}
  }}finally{Array.prototype.push=originalPush;Array.prototype.join=originalJoin;}
});

test('source merging refuses before cloning the retained directory and releases rejected staging',()=>{
  let clones=0;const before:SourceWorkTape={version:1,from:0,cut:H,patterns:[],sources:Array.from({length:2000},(_,i)=>({id:'codex:'+i,get knownFrom(){clones++;return 0;},blocks:[]}))};
  const patch:SourceWorkTape={version:1,from:0,cut:H,replaceFrom:0,replaceTo:0,patterns:[],sources:[]},initial=JSON.stringify(patch).length*3,memory=staged(initial,128);
  assert.throws(()=>mergeSourceWorkTape(before,patch,memory.add,memory.drop),error=>error===limited);
  assert.equal(clones,0);assert.equal(memory.bytes,initial);memory.pool.release(memory.flight);
});

test('partial replacements share identical source patterns without pinning released duplicate arrays',()=>{
  const before=tape(Array.from({length:4000},(_,i)=>[i*100,i%2?-1:1]).flat());
  before.sources=Array.from({length:40},(_,i)=>({id:'codex:'+i,knownFrom:0,blocks:[0,0]}));
  const patch:SourceWorkTape={version:1,from:0,cut:H,replaceFrom:100_000,replaceTo:200_000,patterns:[],sources:[]};
  const initial=JSON.stringify(before).length*3+JSON.stringify(patch).length*3,memory=staged(initial,1300*1024),original=Map.prototype.set;
  let references:Map<readonly number[],number>|undefined,unaccounted=0;
  Map.prototype.set=function<K,V>(this:Map<K,V>,key:K,value:V){if(Array.isArray(key)&&typeof value==='number')references=this as unknown as Map<readonly number[],number>;return Reflect.apply(original,this,[key,value]);};
  try{
    const release=(size:number)=>{
      memory.drop(size);let duplicateCells=0;const seen=new Set<number>();
      for(const [values,id] of references??[]){if(seen.has(id))duplicateCells+=values.length;else seen.add(id);}
      unaccounted=Math.max(unaccounted,duplicateCells*16-(memory.bytes-initial));
    };
    const merged=mergeSourceWorkTape(before,patch,memory.add,release);
    assert.equal(unaccounted,0,'released scratch must not remain pinned by a pattern-reference cache');
    assert.equal(merged.sources.length,40);assert.equal(merged.patterns.length,1);
    const expected=sourceWorkCurves(before).groups.source.get('codex:0')!.read({from:0,to:H},true)-50_000;
    assert.equal(sourceWorkCurves(merged).groups.source.get('codex:39')!.read({from:0,to:H},true),expected);
  }finally{Map.prototype.set=original;memory.pool.release(memory.flight);}
});

test('shared source patterns release duplicate scratch while preserving exact work and partial replacements',()=>{
  const input=tape(Array.from({length:200},(_,i)=>[i*1000,i%2?-1:1]).flat());input.cut=24*H;input.sources[0].blocks=Array.from({length:24},(_,hour)=>[hour,0]).flat();
  const curves=sourceWorkCurves(input);let bytes=0,peak=0;
  const add=(size:number)=>{assert.ok(bytes+size<=64*1024,'duplicate patterns must release temporary values and keys');bytes+=size;peak=Math.max(peak,bytes);};
  const drop=(size:number)=>{bytes-=size;assert.ok(bytes>=0);};
  const exported=sourceWorkTape(curves,0,24*H,new Map([['codex:test',0]]),add,drop);
  assert.equal(exported.patterns.length,1);assert.equal(exported.sources[0].blocks.length,48);assert.ok(peak>bytes);bytes=0;
  const patch:SourceWorkTape={version:1,from:0,cut:24*H,replaceFrom:50_000,replaceTo:70_000,patterns:[],sources:[]};
  const merged=mergeSourceWorkTape(exported,patch,add,drop),result=sourceWorkCurves(merged).groups.source.get('codex:test')!;
  assert.equal(result.read({from:0,to:24*H},true),curves.groups.source.get('codex:test')!.read({from:0,to:24*H},true)-10_000);
  assert.equal(exported.patterns.length,1,'merging never mutates the retained tape');
});
