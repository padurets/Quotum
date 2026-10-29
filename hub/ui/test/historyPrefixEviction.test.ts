import assert from 'node:assert/strict';
import {test} from 'node:test';
import {tileOf,type Chunk} from '../../server/domain/history';
import {composeMeters} from '../../server/domain/meterHistory';
import {HistoryStore} from '../lib/history';
import {HistoryPool} from '../lib/historyPool';
import {HistoryTile} from '../lib/historyTiles';
import {drain,Preparations} from '../lib/prepare';

const CELL=7_200_000,DAY=86_400_000,NOW=1_793_231_751_478;
const LEFT=1_788_912_000_000,END=LEFT+60*CELL,CUT=END-CELL,RETURN=1_791_936_000_000;
const RANGE={from:1_789_343_751_478,to:1_791_935_751_478},known={work:0,sources:{}};
function input(from:number):Chunk {
  return {from,to:from+60*CELL,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],
    meterSeries:Array.from({length:12},(_,source)=>({source:`s${source}`,meter:'balance',kind:'balance',unit:'USD',role:'total',accounting:{spending:'unavailable',topups:'unavailable'},pointMode:'cell',semantics:null,
      cells:Array.from({length:60},(_,i)=>[i,String(9_007_199_254_740_993n+BigInt(i+source)),null,null,CELL,{semantics:{limit:null,resetAt:null,minutes:null,scope:null,label:`terms ${i}`}}])}))};
}
function tile(from:number) {
  const value=drain(new HistoryTile(from,CELL).staged(input(from),known));
  value.readFrom=value.nativeFrom=from;
  value.readTo=value.validTo=value.nativeTo=value.nativeValidTo=from+60*CELL;
  return value;
}
function fixture(preparations:Preparations|null=null) {
  let latest=RANGE.from;
  const queued:(()=>void)[]=[],pool=new HistoryPool(),edge=tile(LEFT),returned=tile(RETURN);
  const store=new HistoryStore({now:()=>NOW,visibleFrom:()=>latest,preparations,schedule:run=>queued.push(run),
    read:async()=>{throw Error('Eviction must not read history');},setTimeout:()=>({}),clearTimeout(){},dropTimeRange(){}},undefined,'budget',pool);
  store.open('b');store.hello('run');store.choose('30d',RANGE);
  const state=store as unknown as {grids:Map<number,Map<number,HistoryTile>>;reservations:Map<string,unknown>;composeOwner:object;plotOwner:object};
  state.grids.set(CELL,new Map([[tileOf(LEFT,CELL),edge],[tileOf(RETURN,CELL),returned]]));
  edge.shownAt=2;returned.shownAt=1;
  return {store,state,pool,edge,returned,latest:(from:number)=>{latest=from;},close(){store.close();preparations?.dispose();pool.unregister(store);}};
}

test('a visible monetary edge can release its never-requested prefix and retain an older visited tile',()=>{
  const h=fixture();
  try {
    const candidates=h.store.evictionCandidates(),prefix=candidates.find(candidate=>candidate.priority===0);
    assert.ok(prefix,'partial visibility must not pin every unvisited packed cell');
    assert.equal(candidates.filter(candidate=>candidate.priority!==0).length,1,'the previously visited return tile is still an ordinary victim');
    const before=h.edge.bytes,total=h.pool.estimatedBytes,published=h.edge.chunk(known),copy=structuredClone(published),returned=h.returned.chunk(known);
    const kept=composeMeters([{from:LEFT,meterSeries:published.meterSeries}],CELL,CUT,END);
    prefix.drop();
    assert.ok(before-h.edge.bytes>=3218,'reclaim exceeds the recorded CI pressure excess');
    assert.equal(total-h.pool.estimatedBytes,before-h.edge.bytes,'only physically removed packed storage reduces the estimate');
    assert.equal(h.pool.budget,15*1024*1024);
    assert.equal(h.edge.readFrom,CUT);assert.equal(h.edge.nativeFrom,CUT);assert.equal(h.edge.nativeTo,END);
    assert.deepEqual(composeMeters([{from:CUT,meterSeries:h.edge.chunk(known).meterSeries}],CELL,CUT,END),kept);
    assert.deepEqual(published,copy,'already decoded data remains unchanged');
    assert.deepEqual(h.returned.chunk(known),returned);
    assert.equal(h.state.grids.get(CELL)!.get(tileOf(RETURN,CELL)),h.returned);
  } finally {h.close();}
});

test('shared versions, outstanding borrowers, reserved writes and requested prefixes cannot be reclaimed',()=>{
  for(const kind of ['clone','activity','plans','decode','staging','reserved','visited'] as const) {
    const h=fixture();let work:Generator|undefined;
    try {
      if(kind==='clone')drain(h.edge.staged(input(LEFT),known));
      if(kind==='activity')h.edge.retireActivity();
      if(kind==='plans')h.edge.retirePlans(Infinity);
      if(kind==='decode'){work=h.edge.chunkPrepared(known);work.next();}
      if(kind==='staging'){work=h.edge.staged(input(LEFT),known);work.next();}
      if(kind==='reserved')h.state.reservations.set(`${CELL}:${tileOf(LEFT,CELL)}`,{});
      if(kind==='visited')h.store.choose('30d',{from:LEFT,to:LEFT+30*DAY});
      const bytes=h.edge.bytes;
      for(const candidate of h.store.evictionCandidates())if(candidate.priority===0)candidate.drop();
      assert.equal(h.edge.bytes,bytes,kind);assert.equal(h.edge.nativeFrom,LEFT,kind);
    } finally {work?.return(undefined);h.close();}
  }
});

test('prefix eviction cancels owned yielding decoders before releasing their input',()=>{
  let ticks=0;const tasks:(()=>void)[]=[],scheduler=new Preparations({now:()=>ticks++,post:run=>tasks.push(run)}),h=fixture(scheduler);
  try {
    scheduler.replace(h.state.composeOwner,h.edge.composeChunkPrepared(NOW,'all',new Set()),()=>true,()=>assert.fail('compose must be cancelled'));
    scheduler.replace(h.state.plotOwner,h.edge.chunkPrepared(known,true,NOW),()=>true,()=>assert.fail('plot must be cancelled'));
    tasks.shift()!();tasks.shift()!();assert.equal(scheduler.size,2);
    assert.equal(h.edge.discardPrefix(CUT),0,'an active decoder owns its packed input');
    h.store.evictionCandidates().find(candidate=>candidate.priority===0)!.drop();
    assert.equal(scheduler.size,0);assert.equal(h.edge.nativeFrom,CUT);
  } finally {h.close();}
});

test('a newly requested left boundary protects cells before this reader receives the selection or gesture',()=>{
  const h=fixture();
  try {
    const pending=h.store.evictionCandidates().find(candidate=>candidate.priority===0)!;
    h.latest(RANGE.from-CELL);
    pending.drop();assert.equal(h.edge.nativeFrom,LEFT,'the earlier candidate must recheck the latest request');
    h.store.evictionCandidates().find(candidate=>candidate.priority===0)!.drop();
    assert.equal(h.edge.nativeFrom,CUT-CELL,'the newly requested cell stays cached');
    h.store.choose('30d',{from:RANGE.from-CELL,to:RANGE.to-CELL});h.latest(RANGE.from);
    for(const candidate of h.store.evictionCandidates())if(candidate.priority===0)candidate.drop();
    assert.equal(h.edge.nativeFrom,CUT-CELL,'returning right cannot reclassify requested cells as unseen');
  } finally {h.close();}
});
