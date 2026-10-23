import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {WorkCalendar} from '../../ui/lib/workCalendar';
import {evaluatedRange,type PeriodSelection} from '../../server/domain/period';
import {calendarCells} from '../../server/domain/workCalendar';
import {calendarProof} from '../../server/domain/calendarWork';
import {drain} from '../../server/domain/prepare';
import {historyPoolReceiptScript} from '../historyPoolReceipt';

const H=3_600_000,DAY=24*H,NOW=Date.UTC(2035,1,10,12),live={mode:'live' as const,periodMs:H};
function fixture(calendar=new WorkCalendar()) {
  const pool=new HistoryPool(),flight={role:'visible' as const};let now=0;
  const period={calendar,transport:{read(){throw Error('no HTTP expected');}},retained:new Map(),valueCache:new Map(),
    get estimatedBytes(){return calendar.bytes;},evictionCandidates(){return calendar.evictionCandidates();}};
  const context=vm.createContext({Map,Set,WeakMap,Headers,Request,URL,TextEncoder,location:{href:'http://fixture.invalid/'},performance:{now:()=>++now},fetch:()=>{throw Error('no HTTP expected');}});
  vm.runInContext('window=globalThis;',context);vm.runInContext(historyPoolReceiptScript(),context,{timeout:3000});
  context.__quotumInspectHistoryPool(pool);pool.register(period);
  return{calendar,pool,flight,context,reserve:(bytes:number)=>pool.reserve(flight,bytes),read:()=>context.__quotumCalendarReceipt.read(),mark:()=>context.__quotumHistoryPoolReceipt.mark(2,3)};
}
function section(calendar:WorkCalendar,selection:PeriodSelection=live,now=NOW){
  const range=evaluatedRange(selection,now),edges=calendar.state.window.edges,known=NOW-4*H;
  const rows=[{session:1,source:null,device:'private-device',user:'private-user',origin:'terminal' as const,project:null,folder:null,startedAt:NOW-45*60_000,from:NOW-45*60_000,to:NOW-40*60_000}];
  const proof={...drain(calendarProof(rows,range,now,known,0,()=>{})),retentionMs:90*DAY,...(selection.mode==='live'?{periodMs:selection.periodMs}:{})};
  const cells=drain(calendarCells(rows,edges,edges.slice(1).map((_,i)=>i),now,known,0,90*DAY,range,selection.mode==='live'?selection.periodMs:undefined)).map(([,cell])=>cell);
  return{state:'complete' as const,basis:{run:'private-run',revision:'1',evaluatedAt:now,evidenceCut:now,range,calendarKey:'private-calendar',filterKey:'private-filter',workAuthority:'private-authority'},value:{zone:calendar.state.window.zone,edges,cells,availableFrom:known,retainedFrom:0,cursor:'private-cursor',proof}};
}

test('actual calendar producer, cached union and dirty boundaries are observed without supplying their results',()=>{
  const h=fixture(),c=h.calendar;
  c.configure(true,'private-context',NOW,false,live,h.reserve);
  assert.equal(c.needed,true);c.receive(section(c),c.generation,h.reserve);
  assert.equal(c.state.value!.cells.reduce((sum,cell)=>sum+(cell.agentMs??0),0),5*60_000);
  const historical={mode:'range' as const,from:NOW-H,to:NOW-H/2};
  c.configure(true,'private-context',NOW,false,historical,h.reserve);assert.equal(c.needed,false);
  c.configure(true,'private-context',NOW+2517,false,live,h.reserve);assert.equal(c.needed,false);
  c.dirty(NOW-H/2);c.configure(true,'private-context',NOW+2517,false,historical,h.reserve);assert.equal(c.needed,false);
  c.configure(true,'private-context',NOW+2517,false,{mode:'range',from:NOW-3*H,to:NOW-2*H},h.reserve);assert.equal(c.needed,true);
  h.mark();const receipt=h.read();assert.equal(receipt.status,'complete');assert.equal(receipt.early,true);
  const reads=receipt.rows.filter((r:{kind:string})=>r.kind==='cache.read');
  assert.deepEqual(Array.from(reads,(r:any)=>r.result.hit),[false,true,true,true,false]);
  const invalidation=receipt.rows.find((r:{kind:string})=>r.kind==='cache.invalidate');
  assert.equal(invalidation.after.entries[0].validBefore,NOW-H/2);assert.equal(invalidation.after.entries[0].cut,NOW-H/2);
  const add=receipt.rows.find((r:{kind:string})=>r.kind==='cache.add');
  assert.equal(add.after.entries.length,1);assert.equal(add.reserves.rejected,0);assert.ok(add.reserves.calls>0);
  assert.equal(add.after.entries[0].validBefore,'Infinity');
  for(const row of receipt.rows.filter((r:any)=>r.id!==undefined)){assert.ok(row.startSequence<row.sequence);assert.ok(row.finishedAt>=row.startedAt);}
  const json=JSON.stringify(receipt);assert.ok(!json.includes('private-'),'identity-bearing producer and request fields are anonymized');
  assert.equal(receipt.errors,0);assert.equal(receipt.omitted,0);assert.equal(receipt.snapshotOmitted,0);
});

test('actual pool pressure journals the calendar entry removed by its original candidate and refused reservation',()=>{
  const h=fixture(),c=h.calendar;c.configure(true,'context',NOW,false,live,h.reserve);c.receive(section(c),c.generation,h.reserve);
  const before=h.read().final.entries;assert.equal(before.length,1);
  assert.equal(h.pool.reserve(h.flight,h.pool.budget+1),false);h.mark();const receipt=h.read();
  assert.equal(receipt.status,'complete');const drop=receipt.rows.find((r:{kind:string})=>r.kind==='cache.drop');
  assert.equal(drop.before.entries[0].id,before[0].id);assert.equal(drop.after.entries.length,0);assert.equal(drop.complete,true);
  const trim=receipt.rows.find((r:any)=>r.kind==='pool.trim'&&r.result===false);
  assert.ok(trim);assert.ok(trim.drops>0);assert.ok(trim.peakCharge>h.pool.budget);assert.ok(trim.lastCharge>h.pool.budget);assert.equal(trim.complete,true);
  const pool=h.context.__quotumHistoryPoolReceipt.read();
  assert.ok(pool.entries.some((r:any)=>r.kind==='reserve-critical'&&r.accepted===false),'the existing pool witness keeps the actual refusal');
});

test('calendar delegation preserves receivers, all arguments, return values and original thrown errors',()=>{
  const c=new WorkCalendar(),original=c.configure,marker=new Error('original'),receiver={},seen:{self:unknown;args:unknown[];result?:boolean}[]=[];
  c.configure=function(...args){if(this===receiver)throw marker;const row={self:this,args,result:original.apply(this,args)};seen.push(row);return row.result;};
  const h=fixture(c),selected={...live};const result=c.configure(true,'context',NOW,false,selected,h.reserve);
  assert.equal(result,seen[0].result);assert.equal(seen[0].self,c);assert.equal(seen[0].args[4],selected);assert.equal(seen[0].args[5],h.reserve);
  assert.throws(()=>c.configure.call(receiver as WorkCalendar,true,'context',NOW,false,selected,h.reserve),error=>error===marker);
  h.mark();const receipt=h.read();assert.ok(receipt.rows.some((r:any)=>r.kind==='calendar.configure'&&r.complete===false));assert.equal(receipt.errors,0);
});

test('observer faults and bounded journal overflow cannot become complete evidence or alter calendar demand',()=>{
  const h=fixture(),c=h.calendar;c.configure(true,'context',NOW,false,live,h.reserve);
  for(let i=0;i<2200;i++)c.dirty(Infinity);
  h.mark();const full=h.read();assert.equal(full.status,'insufficient-evidence');assert.ok(full.omitted>0);assert.ok(Buffer.byteLength(JSON.stringify(full))<=2*1024*1024);
  const expected=WorkCalendar.prototype.demand.call(c);
  const cache=(c as any).cache,entries=cache.entries;Object.defineProperty(cache,'entries',{configurable:true,get(){throw Error('observer-only read');}});
  try{assert.deepEqual(c.demand(),expected);assert.equal(h.read().status,'insufficient-evidence');assert.ok(h.read().errors>0);}
  finally{Object.defineProperty(cache,'entries',{configurable:true,writable:true,value:entries});}
});

test('an original cache exception has no invented hit and unchanged calls are counted without flooding the journal',()=>{
  const calendar=new WorkCalendar(),cache=(calendar as any).cache,original=cache.read,marker=new Error('original cache error');let throwing=true;
  cache.read=function(...args:unknown[]){if(throwing)throw marker;return original.apply(this,args);};
  const h=fixture(calendar);
  assert.throws(()=>calendar.configure(true,'context',NOW,false,live,h.reserve),error=>error===marker);
  throwing=false;calendar.configure(false,'context',NOW,false,live,h.reserve);calendar.configure(true,'context',NOW,false,live,h.reserve);
  for(let i=0;i<1000;i++){assert.equal(calendar.configure(true,'context',NOW,false,live,h.reserve),false);calendar.demand();}
  h.mark();const receipt=h.read();assert.equal(receipt.status,'complete');
  const failed=receipt.rows.find((r:any)=>r.kind==='cache.read'&&!r.complete);assert.ok(failed);assert.equal(failed.result,null);
  assert.equal(receipt.noops['calendar.configure'].calls,1000);assert.equal(receipt.noops['calendar.demand'].calls,999);
  assert.ok(receipt.rows.length<20);assert.equal(receipt.errors,0);assert.equal(receipt.omitted,0);
});

test('a real stale receive keeps decimal revision order when range and evidence cut are unchanged',()=>{
  const h=fixture(),c=h.calendar;c.configure(true,'context',NOW,false,live,h.reserve);
  const old=section(c);c.receive({...old,basis:{...old.basis,revision:'2'}},c.generation,h.reserve);const accepted=c.state;
  c.receive(old,c.generation,h.reserve);assert.equal(c.state,accepted,'the real receive guard rejects revision1 after revision2');
  h.mark();const receipt=h.read();assert.equal(receipt.status,'complete');
  const rejected=receipt.rows.filter((r:any)=>r.kind==='calendar.receive').at(-1);
  assert.equal(rejected.args.basis.revisionValue,'1');assert.equal(rejected.before.basis.revisionValue,'2');assert.equal(rejected.after.basis.revisionValue,'2');
  assert.deepEqual(rejected.args.basis.range,rejected.before.basis.range);assert.equal(rejected.args.basis.evidenceCut,rejected.before.basis.evidenceCut);
});
