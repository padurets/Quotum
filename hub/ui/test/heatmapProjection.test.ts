import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarWindow,calendarLevel,type CalendarReading} from '../lib/workCalendar';
import {heatmapBasisPrepared,heatmapCivilPrepared,heatmapCivilCovers,heatmapProjection,heatmapProjectionChangesAt,heatProjectionCellAt,heatProjectionPaintAt,heatmapLayout,type HeatmapBasis,type HeatmapView} from '../lib/heatmap';
import {calendarCells,type CalendarProof} from '../../server/domain/workCalendar';
import {sourceWorkCurves} from '../../server/domain/periodCurves';
import {drain} from '../../server/domain/prepare';
import type {Stretch} from '../../server/domain/work';

const M=60_000,H=60*M,D=24*H;
const row=(from:number,to:number):Stretch=>({session:1,source:null,device:'d',user:'u',origin:'terminal',project:null,folder:null,startedAt:from,from,to});
function fixture(now:number,periodMs:number,rows:Stretch[],zone='UTC'){
  const window=calendarWindow(now,zone,{mode:'live',periodMs}),from=window.range.from-2*D,cut=now+2*D;
  const changes=new Map<number,Map<number,number>>();
  for(const value of rows)for(let block=Math.floor(value.from/H);block<Math.ceil(value.to/H);block++){
    let events=changes.get(block);if(!events)changes.set(block,events=new Map());
    const start=Math.max(0,value.from-block*H),end=Math.min(H,value.to-block*H);
    events.set(start,(events.get(start)??0)+1);events.set(end,(events.get(end)??0)-1);
  }
  const patterns:number[][]=[],blocks:number[]=[];
  for(const [block,events] of [...changes].sort(([a],[b])=>a-b)){blocks.push(block,patterns.length);patterns.push([...events].sort(([a],[b])=>a-b).flat());}
  const proof:CalendarProof={version:1,from,cut,retentionMs:90*D,periodMs,patterns,sources:[{id:'work',knownFrom:from,blocks}]};
  const curve=sourceWorkCurves(proof).groups.source.get('work')!;
  let through=now;
  const reading:CalendarReading={window,basis:null,loading:false,error:null,value:{zone,edges:window.edges,cells:[],cursor:'',availableFrom:from,retainedFrom:from},integral:{proof,curve,bytes:0,stamp:{watch:'w',seq:1,authority:'a',at:now},through:()=>through}};
  return {reading,rows,setThrough:(at:number)=>{through=at;}};
}
function oracle(basis:HeatmapBasis,rows:Stretch[],item:ReturnType<typeof heatmapProjection>['cells'][number],now:number){
  const {reading}=basis,{integral,value}=reading,period=reading.window.range.to-reading.window.range.from,nominal=item.nominal!;
  return drain(calendarCells(rows,[nominal.from,nominal.to],[0],Math.min(now,integral!.through()),value!.availableFrom,Math.max(value!.retainedFrom,now-integral!.proof.retentionMs),integral!.proof.retentionMs,{from:Math.max(now-period,integral!.proof.from),to:now},period))[0][1];
}
function verify(basis:HeatmapBasis,rows:Stretch[],now:number,width:number,view:HeatmapView,height=0,civil=basis.civil){
  const layout=heatmapProjection(basis,now,width,view,'en-GB',height,civil);
  assert.ok(layout.cells.length>0);
  for(const item of layout.cells){
    assert.deepEqual(item.cell,oracle(basis,rows,item,now),item.key);
    assert.ok(item.from>=now-(basis.reading.window.range.to-basis.reading.window.range.from));
    assert.ok(item.to<=now);assert.ok(item.width>0&&item.height>0);
    assert.ok(item.x>=0&&item.x+item.width<=Math.max(width,100)+.001);
    assert.ok(item.y>=0&&item.y+item.height<=layout.height+.001);
  }
  return layout;
}

test('live UI projection clips fractional boundaries and parallel work against independent calendar integration',()=>{
  const at=Date.UTC(2034,8,10,12,23,45,123),period=2*H;
  const f=fixture(at,period,[row(at-period-10*M,at-period+17*M+19),row(at-period+101,at-456),row(at-22*M,at+H)]);
  for(const view of ['matrix','calendar'] as const){
    const basis=drain(heatmapBasisPrepared(f.reading,view,538));
    for(const offset of [0,1,123,17_321,M+123,11*M+999]){
      const now=at+offset;f.setThrough(now-37);
      const layout=verify(basis,f.rows,now,538,view);
      const first=layout.cells[0],instant=heatProjectionCellAt(basis,first,now+13);
      assert.equal(instant.from,now+13-period);
      assert.deepEqual(instant.cell,oracle(basis,f.rows,instant,now+13));
      assert.ok(layout.cells.at(-1)!.partial,'the unconfirmed right tail stays explicitly partial');
    }
  }
});

test('31/32 current dates choose the current 1h/2h resolution at width 355 and height 268',()=>{
  const at=Date.UTC(2034,8,10),period=31*D,f=fixture(at,period,[row(at-period,at)]),basis=drain(heatmapBasisPrepared(f.reading,'matrix',355,268));
  const before=verify(basis,f.rows,at,355,'matrix',268),after=verify(basis,f.rows,at+1,355,'matrix',268);
  assert.equal(new Set(before.cells.map(c=>c.date)).size,31);assert.equal(new Set(after.cells.map(c=>c.date)).size,32);
  assert.equal(before.span,2*H);assert.equal(after.span,H);assert.equal(before.height,after.height);
  for(const now of [at,at+1,at+14*H]){
    const window=calendarWindow(now,'UTC',{mode:'live',periodMs:period}),reference=heatmapLayout({...f.reading,integral:undefined,window,value:null},355,'matrix','en-GB',268),actual=heatmapProjection(basis,now,355,'matrix','en-GB',268);
    assert.equal(actual.span,reference.span);assert.equal(actual.kind,reference.kind);
    assert.deepEqual(actual.labels,reference.labels);
  }
});

test('a short UTC-aligned bucket crossing local midnight retains its first visible fraction',()=>{
  const at=Date.parse('2034-09-10T16:32:15.123Z'),period=D-2*H,f=fixture(at,period,[row(at-period,at)],'Asia/Kathmandu'),basis=drain(heatmapBasisPrepared(f.reading,'matrix',538));
  for(const now of [at,at+2*H,at+2*H+M]){
    f.setThrough(now);const layout=verify(basis,f.rows,now,538,'matrix');
    assert.equal(layout.cells[0].from,now-period);
    assert.equal(layout.cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),Math.max(0,at-(now-period)));
  }
});

test('current civil buckets preserve 23/25-hour and Lord Howe days, local zones, and exact work',()=>{
  for(const [from,to,zone,hours,count] of [
    ['2026-03-08T05:00Z','2026-03-09T04:00Z','America/New_York',23,23],
    ['2026-11-01T04:00Z','2026-11-02T05:00Z','America/New_York',25,25],
    ['2026-10-03T13:30Z','2026-10-04T13:00Z','Australia/Lord_Howe',23.5,24],
    ['2026-04-04T13:00Z','2026-04-05T13:30Z','Australia/Lord_Howe',24.5,25],
    ['2026-10-19T18:15Z','2026-10-20T18:15Z','Asia/Kathmandu',24,24],
  ] as const){
    const start=Date.parse(from),end=Date.parse(to),f=fixture(end+3*D,14*D,[row(start,end)],zone),basis=drain(heatmapBasisPrepared(f.reading,'matrix',1138));
    const layout=verify(basis,f.rows,end+3*D+123,1138,'matrix'),date=calendarWindow(end,zone,{mode:'range',from:start,to:end}).dates[0],cells=layout.cells.filter(c=>c.date===date);
    assert.equal(cells.length,count,zone+' '+from);assert.equal(cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),hours*H);
    assert.equal(new Set(cells.map(c=>c.key)).size,count,'repeated local hours keep different stable keys');
    if(hours===25)assert.equal(cells.filter(c=>c.repeated).length,2);
  }
});

test('quiet overnight and long sleeps extend only civil preparation, with exact current known zero',()=>{
  const at=Date.UTC(2034,8,10,23,59,59,987),f=fixture(at,31*D,[row(at-2*H,at-H)]),basis=drain(heatmapBasisPrepared(f.reading,'matrix',1138));
  const before=verify(basis,f.rows,at,1138,'matrix'),later=at+M;f.setThrough(later);
  const overnight=verify(basis,f.rows,later,1138,'matrix');
  const surviving=new Map(before.cells.map(c=>[c.key,c]));
  for(const cell of overnight.cells)if(surviving.has(cell.key))assert.equal(cell.rowKey,surviving.get(cell.key)!.rowKey,'surviving dates keep their React row identity');
  const slept=at+45*D;f.setThrough(slept);
  assert.equal(heatmapCivilCovers(basis.civil,f.reading,slept),false);
  const extended=drain(heatmapCivilPrepared(f.reading,slept,'matrix',1138)),current=verify(basis,f.rows,slept,1138,'matrix',0,extended);
  assert.equal(heatmapCivilCovers(extended,f.reading,slept),true);
  assert.ok(current.cells.every(c=>c.cell.agentMs===0),'fresh quiet evidence confirms current zero without old work leaking');
  assert.equal(new Set(current.cells.map(c=>c.date)).size,32);
  assert.ok(heatmapProjectionChangesAt(basis,slept)>slept);
});

test('a replacement owns new work while clock reads reuse civil preparation and never visit fine payload',t=>{
  const at=Date.UTC(2034,8,10,12,23,45,123),f=fixture(at,D,[row(at-D,at)]);
  Object.defineProperty(f.reading.value!,'cells',{get(){throw new Error('clock visited fine work');}});
  const first=drain(heatmapBasisPrepared(f.reading,'matrix',538));
  let formatted=0;const original=Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype,'formatToParts',function(this:Intl.DateTimeFormat,...args:Parameters<typeof original>){formatted++;return original.apply(this,args);});
  for(const offset of [1,17,M+123,2*H+71])verify(first,f.rows,at+offset,538,'matrix');
  assert.equal(formatted,0,'clock geometry consumes prepared civil groups, never the fine civil partition');
  const replacement=fixture(at,D,[row(at-D,at),row(at-H,at)]);formatted=0;
  const next=drain(heatmapBasisPrepared(replacement.reading,'matrix',538));
  assert.equal(next.civil,first.civil,'same-geometry replacements borrow only the civil basis');
  assert.equal(formatted,0);
  const oldTotal=verify(first,f.rows,at,538,'matrix').cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),newTotal=verify(next,replacement.rows,at,538,'matrix').cells.reduce((n,c)=>n+(c.cell.agentMs??0),0);
  assert.equal(newTotal-oldTotal,H);
});

test('closed paint has no clock while a moving fractional contribution changes at its exact threshold',()=>{
  const at=Date.UTC(2034,8,10,12,45),start=at-D,f=fixture(at,D,[row(start-101,start+123)]),basis=drain(heatmapBasisPrepared(f.reading,'matrix',538));
  const layout=verify(basis,f.rows,at,538,'matrix'),first=layout.cells[0],closed=layout.cells.find(c=>c.from>start&&c.to<at)!;
  assert.equal(heatProjectionPaintAt(basis,closed,layout.span,at),null);
  assert.equal(heatProjectionPaintAt(basis,first,layout.span,at),at+123);
  assert.equal(heatProjectionCellAt(basis,first,at+122).cell.agentMs,1);
  assert.equal(heatProjectionCellAt(basis,first,at+123).cell.agentMs,0);
  assert.ok(heatmapProjectionChangesAt(basis,at)-at>=M,'detail clock does not wake the whole plot');
});

test('closed boundary paint ignores slope changes that leave its appearance unchanged',()=>{
  const at=Date.UTC(2034,8,10,12,38,5),rows=[row(at-D+7*M,at-D+7*M+10_000),row(at-5*M,at-5*M+10_000),...[25_000,85_000].flatMap(offset=>[row(at-D+offset,at-D+offset+1000),row(at+offset,at+offset+1000)])];
  const f=fixture(at,D,rows);f.setThrough(at+3*M);const basis=drain(heatmapBasisPrepared(f.reading,'matrix',1000));
  for(const offset of [0,55_000]){
    const layout=heatmapProjection(basis,at+offset,1000,'matrix','en-GB');
    for(const item of [layout.cells[0],layout.cells.at(-1)!]){
      assert.equal(heatProjectionPaintAt(basis,item,layout.span,at+offset),null,'the plot already owns its next minute');
      for(const elapsed of [0,25_000,26_000,55_000]){
        const projected=heatProjectionCellAt(basis,item,at+offset+elapsed);
        assert.equal(projected.cell.agentMs===null?-1:calendarLevel(projected.cell.agentMs,layout.span),1);
        assert.equal(projected.partial,false);
      }
    }
  }
});

for(const period of [D,30*D])test(`boundary paint preserves exact expiry and future work before the ${period/D}d plot deadline`,()=>{
  const at=Date.UTC(2034,8,10,12,38,5),left=at-period;
  const expired=fixture(at,period,[row(left-101,left+123)]);expired.setThrough(at+3*M);
  const oldBasis=drain(heatmapBasisPrepared(expired.reading,'matrix',538)),oldLayout=heatmapProjection(oldBasis,at,538,'matrix','en-GB'),first=oldLayout.cells[0];
  assert.equal(heatProjectionPaintAt(oldBasis,first,oldLayout.span,at),at+123);
  assert.equal(heatProjectionCellAt(oldBasis,first,at+122).cell.agentMs,1);assert.equal(heatProjectionCellAt(oldBasis,first,at+123).cell.agentMs,0);
  const future=fixture(at,period,[row(at+60_001,at+61_001)]);future.setThrough(at+3*M);
  const basis=drain(heatmapBasisPrepared(future.reading,'matrix',538));let now=at,paint:number|null=null;
  for(let count=0;count<3&&paint===null;count++){
    const layout=heatmapProjection(basis,now,538,'matrix','en-GB'),item=layout.cells.at(-1)!;
    const due=heatProjectionPaintAt(basis,item,layout.span,now),parent=heatmapProjectionChangesAt(basis,now);
    if(due!==null){assert.ok(due<parent);paint=due;}else now=parent;
  }
  assert.equal(paint,at+60_002,'the first positive millisecond gets its own wake');
  const layout=heatmapProjection(basis,at,538,'matrix','en-GB'),last=layout.cells.at(-1)!;
  assert.equal(heatProjectionCellAt(basis,last,at+60_001).cell.agentMs,0);assert.equal(heatProjectionCellAt(basis,last,at+60_002).cell.agentMs,1);
});

test('long/short civil cache transitions match independent fresh Kathmandu selections in both directions',()=>{
  const at=Date.UTC(2037,5,14,12,17),zone='Asia/Kathmandu';
  const prepare=(period:number,width:number,zoneName=zone)=>{
    const f=fixture(at,period,[],zoneName);return drain(heatmapBasisPrepared(f.reading,'matrix',width));
  };
  // The production cache has two entries. Independent zones evict both entries
  // without exposing a test-only cache reset or changing either tested selection.
  const evict=()=>{prepare(D,538,'UTC');prepare(D,538,'Pacific/Honolulu');};
  for(const [name,seedPeriod,seedWidth,period,width] of [
    ['long to short',3*D,1138,D,538],
    ['short to long',D,538,D+H,1138],
  ] as const){
    evict();prepare(seedPeriod,seedWidth);
    const reused=prepare(period,width),actual=heatmapProjection(reused,at,width,'matrix','en-GB');
    evict();const independent=prepare(period,width),expected=heatmapProjection(independent,at,width,'matrix','en-GB');
    assert.equal(actual.span,H);assert.equal(expected.span,H);
    assert.equal(actual.cells.length,expected.cells.length,name+' bucket count');
    const identity=(cell:typeof actual.cells[number])=>({key:cell.key,from:cell.from,to:cell.to,nominal:cell.nominal});
    for(let i=0;i<actual.cells.length;i++)assert.deepEqual(identity(actual.cells[i]),identity(expected.cells[i]),name+' bucket '+i);
    if(period<=D)assert.ok(actual.cells.every(cell=>cell.nominal!.from%H===0),'short strips retain UTC hour boundaries');
    else assert.ok(actual.cells.some(cell=>cell.nominal!.from%H===15*M),'long civil hours retain Kathmandu boundaries');
  }
});
