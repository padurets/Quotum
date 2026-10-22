import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {calendarProof} from '../../server/domain/calendarWork';
import {calendarCells,type CalendarSection} from '../../server/domain/workCalendar';
import {packCalendar,expandCalendar} from '../../server/domain/workCalendarWire';
import {expandPeriodSequences} from '../../server/domain/periodSequenceWire';
import {periodDictionary,type PeriodWireReply} from '../../server/domain/periodWire';
import {periodValueAt,withValueStates,type PeriodValues} from '../../server/domain/periodValues';
import {drain} from '../../server/domain/prepare';
import type {PeriodSelection} from '../../server/domain/period';
import type {PeriodReply,PeriodRequest} from '../../server/domain/periodRead';
import {CalendarCache} from '../lib/calendarCache';
import {WorkCalendar,calendarWindow} from '../lib/workCalendar';
import {HistoryPool} from '../lib/historyPool';
import {PeriodTransport,fetchPeriod,type PeriodIntent} from '../lib/periodTransport';

const DAY=86_400_000,H=3_600_000,periodMs=30*DAY,retentionMs=90*DAY;
// These endpoints reproduce the rolling return; all identities and work are synthetic.
const seed={from:1790077677216,to:1792669677216,now:1792669677216,retained:1784893677676};
const fixed={from:1788781681712,to:1791373681712,now:1792669683723,retained:1784893684178};
const returned={from:1790077689443,to:1792669689443,now:1792669689443};
const known=1786188420000,live:PeriodSelection={mode:'live',periodMs};
const work=[
  [fixed.from+60_000,fixed.from+240_000],
  [seed.from-30_000,seed.from+90_000],
  [fixed.to-90_000,fixed.to+90_000],
  [seed.to-120_000,seed.to+60_000],
].map(([from,to],session)=>({session,source:null,device:'synthetic-device',user:'synthetic-user',origin:'terminal' as const,project:null,folder:null,startedAt:from,from,to}));

function section(bounds:typeof seed,isLive:boolean):Extract<CalendarSection,{state:'complete'}>{
  const selection:PeriodSelection=isLive?live:{mode:'range',from:bounds.from,to:bounds.to};
  const window=calendarWindow(bounds.now,'UTC',selection),cut=bounds.to;
  const proof={...drain(calendarProof(work,bounds,cut,known,bounds.retained,()=>{})),retentionMs,...(isLive?{periodMs}:{})};
  const cells=drain(calendarCells(work,window.edges,window.edges.slice(1).map((_,i)=>i),cut,known,bounds.retained,retentionMs,bounds,isLive?periodMs:undefined)).map(([,cell])=>cell);
  return {state:'complete',basis:{run:'synthetic-run',revision:'102984',evaluatedAt:bounds.now,evidenceCut:cut,range:{from:bounds.from,to:bounds.to},calendarKey:isLive?'live-calendar':'fixed-calendar',workAuthority:'same-authority',filterKey:'same-filter'},value:{zone:'UTC',edges:window.edges,cells,availableFrom:known,retainedFrom:bounds.retained,cursor:isLive?'live-cursor':'fixed-cursor',proof}};
}

const sourceCount=64,windowCount=8,stateCount=16;
function valueAt(source:number,piece:number):PeriodValues{
  const from=fixed.from+Math.floor(periodMs*piece/stateCount),to=fixed.from+Math.floor(periodMs*(piece+1)/stateCount);
  return {id:'synthetic-source-'+source,provider:'codex',validFor:{from,to},meters:[],keys:[],windows:Array.from({length:windowCount},(_,window)=>({id:'pool-'+window,kind:'session' as const,label:'Pool '+window,minutes:300,used:piece+window,remaining:100-piece-window,resetAt:fixed.now+H,observedAt:from,validUntil:to,stale:false}))};
}
function checkValues(values:PeriodValues[]){
  assert.equal(values.length,sourceCount);
  for(const [source,value] of values.entries())for(let piece=0;piece<stateCount;piece++){
    const expected=valueAt(source,piece),actual=periodValueAt(value,expected.validFor!.from)!;const {states:_states,...reading}=actual;assert.deepEqual(reading,expected,'every decoded semantic state is consumed');
  }
}
function combined(){
  const calendar=section(fixed,false),values=Array.from({length:sourceCount},(_,source)=>withValueStates(valueAt(source,0),Array.from({length:stateCount},(_,piece)=>valueAt(source,piece)),()=>{}));
  const reply:PeriodReply={basis:calendar.basis,calendar,values:{state:'complete',basis:calendar.basis,value:values}};
  const dictionary=periodDictionary(reply,()=>{},true),text=JSON.stringify(reply,dictionary.replacer),packed=JSON.parse(text) as PeriodWireReply;
  assert.equal(JSON.parse(text).values.value[0].states.pathEncoding,'prefix','the combined body really restores sequences after calendar');
  let positiveCalendar=0,residentCalendar=0,sequences=0;
  expandCalendar(structuredClone(packed.calendar),packed.basis,bytes=>{positiveCalendar+=Math.max(0,bytes);});
  // The production cells-only decoder measures precisely the retained calendar result.
  const cellsOnly=packCalendar({...calendar,value:{...calendar.value,proof:undefined}},reply.basis,()=>{});
  expandCalendar(cellsOnly,reply.basis,bytes=>{residentCalendar+=bytes;});
  expandPeriodSequences(structuredClone(packed) as PeriodReply,bytes=>{sequences+=bytes;});
  const native=Buffer.byteLength(text)*3,correct=native+Math.max(positiveCalendar,residentCalendar+sequences),cumulative=native+positiveCalendar+sequences;
  assert.ok(cumulative>correct,'later semantic state programs must expose expired calendar workspace');
  return {text,calendar,native,positiveCalendar,residentCalendar,sequences,correct,cumulative,gap:cumulative-correct};
}
function prepared(){
  const calendar=new WorkCalendar();assert.ok((calendar as unknown as {cache:CalendarCache}).cache instanceof CalendarCache);
  const pool=new HistoryPool(),member={get estimatedBytes(){return calendar.bytes;},evictionCandidates:()=>calendar.evictionCandidates()};pool.register(member);
  const temporary={role:'visible' as const},reserve=(bytes:number)=>pool.reserve(temporary,bytes);
  try{
    calendar.configure(true,'same-context',seed.now,false,live,reserve);calendar.receive(section(seed,true),calendar.generation,reserve);
    calendar.configure(true,'same-context',fixed.now,false,{mode:'range',from:fixed.from,to:fixed.to},reserve);
    assert.equal(calendar.needed,true);assert.equal(calendar.evictionCandidates().length,1);
  }finally{pool.release(temporary);pool.unregister(member);}
  return calendar;
}
function warmPeak(){
  const calendar=prepared();let peak=calendar.bytes;
  const reserve=(bytes:number)=>{peak=Math.max(peak,calendar.bytes+bytes);return true;};
  calendar.receive(section(fixed,false),calendar.generation,reserve);
  calendar.configure(true,'same-context',returned.now,false,live,reserve);assert.equal(calendar.needed,false);
  return peak;
}
const until=async(check:()=>unknown)=>{for(let i=0;i<300;i++){await new Promise<void>(setImmediate);if(check())return;}assert.fail('period transport did not settle');};

function fixture(t:TestContext,mode:'pressure'|'refused'|'failure'|'abort'='pressure'){
  const resolved=Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype,'resolvedOptions',function(this:Intl.DateTimeFormat){return {...resolved.call(this),timeZone:'UTC'};});
  const wire=combined(),calendar=prepared(),retained=calendar.bytes;
  // The midpoint admits every live phase but rejects their cumulative expired workspace.
  const budget=mode==='refused'?retained+wire.native+Math.floor(wire.residentCalendar/2):retained+wire.correct+Math.floor(wire.gap/2);
  const legitimateWarmPeak=warmPeak();assert.ok(budget>legitimateWarmPeak,'semantic response density also funds the legitimate warm projection');
  const pool=new HistoryPool(budget),evictions:{phase:string;bytes:number;shownAt:number}[]=[],trims:{phase:string;before:number;after:number;accepted:boolean}[]=[];
  let phase='idle',requests=0,finished=0,intent:PeriodIntent|null={board:'synthetic-board',generation:1,revision:1,calendarGeneration:calendar.generation,request:{version:1,selection:{mode:'range',from:fixed.from,to:fixed.to},evaluatedAt:fixed.now,calendar:{zone:'UTC'},values:Array.from({length:sourceCount},(_,i)=>'synthetic-source-'+i)}};
  pool.register({get estimatedBytes(){return calendar.bytes;},evictionCandidates(){return calendar.evictionCandidates().map(candidate=>{const drop=candidate.drop;candidate.drop=()=>{evictions.push({phase,bytes:candidate.bytes,shownAt:candidate.shownAt});drop();};return candidate;});}});
  const originalTrim=pool.trim;
  pool.trim=function(){const before=this.estimatedBytes,result=originalTrim.call(this);trims.push({phase,before,after:this.estimatedBytes,accepted:result});return result;};
  let abortObserved=false;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
    requests++;
    if(mode==='failure')throw new Error('synthetic network failure');
    if(mode==='abort')return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>{abortObserved=true;reject(new DOMException('Aborted','AbortError'));},{once:true});});
    return new Response(wire.text,{headers:{'content-type':'application/json'}});
  });
  const transport=new PeriodTransport(pool,()=>intent,(reply,request,reserve)=>{
    phase='adopt';
    if(reply.calendar)calendar.receive(reply.calendar,request.calendarGeneration!,reserve??(()=>true));
    if(reply.values?.state==='complete')checkValues(reply.values.value);
    finished++;
  },async(board,body,signal,reserve)=>{phase='decode';return fetchPeriod(board,body,signal,reserve);});
  t.after(()=>{intent=null;transport.reset();});
  t.diagnostic(JSON.stringify({mode,retained,budget,legitimateWarmPeak,native:wire.native,calendarPositive:wire.positiveCalendar,calendarResident:wire.residentCalendar,sequence:wire.sequences,positiveGap:wire.gap,correctDecodePeak:retained+wire.correct,cumulativeDecodePeak:retained+wire.cumulative}));
  return {calendar,pool,transport,wire,evictions,trims,start:()=>transport.change(),requests:()=>requests,finished:()=>finished,aborted:()=>abortObserved,stop:()=>{intent=null;transport.reset();},warm:()=>{phase='warm';const temporary={role:'visible' as const};try{calendar.configure(true,'same-context',returned.now,false,live,bytes=>pool.reserve(temporary,bytes));}finally{pool.release(temporary);}}};
}

test('expired calendar decode workspace never evicts the reusable LIVE proof before warm return',async t=>{
  const h=fixture(t);h.start();await until(()=>h.finished()>0&&h.pool.activeFlights===0);
  assert.equal(h.calendar.state.error,null,'the combined fixed response remains admitted');
  assert.equal(h.calendar.needed,false);
  t.diagnostic(JSON.stringify({evictions:h.evictions,pressure:h.trims.filter(trim=>trim.before>h.pool.budget)}));
  assert.ok(h.evictions.every(drop=>drop.phase==='decode'),'no adoption or warm allocation may cause the witnessed eviction');
  h.warm();
  assert.equal(Number(h.calendar.needed),0,'warm return must HIT the reusable LIVE proof without requesting calendar again');
  assert.equal(h.calendar.demand(),undefined);assert.equal(h.requests(),1);
  assert.equal(h.evictions.length,0,'released calendar workspace leaves the LIVE proof reusable');
  const window=calendarWindow(returned.now,'UTC',live),oracle=drain(calendarCells(work,window.edges,window.edges.slice(1).map((_,i)=>i),seed.to,known,returned.now-retentionMs,retentionMs,returned,periodMs)).map(([,cell])=>cell);
  assert.ok(oracle.some(cell=>(cell.agentMs??0)>0));assert.deepEqual(h.calendar.state.value!.cells,oracle,'all values, interval bounds and validUntil match the fresh server oracle');
  assert.equal(h.pool.estimatedBytes,h.calendar.bytes,'the completed response and warm staging have been released');
});

test('genuinely insufficient calendar decode budget retains the normal bounded fallback and releases its flight',async t=>{
  const h=fixture(t,'refused');h.start();await until(()=>h.finished()>0&&h.pool.activeFlights===0);
  assert.equal(h.calendar.state.error,'history_limit');assert.ok(h.trims.some(trim=>!trim.accepted));
  assert.equal(h.pool.estimatedBytes,h.calendar.bytes,'refused native response staging is fully released');
  h.warm();assert.equal(h.calendar.needed,true);assert.ok(h.calendar.demand(),'an evicted proof falls back to the common calendar transport');
});

for(const mode of ['failure','abort'] as const)test(`a ${mode==='abort'?'pre-response cancellation':'network failure'} releases the actual period transport flight`,async t=>{
  const h=fixture(t,mode);h.start();await until(()=>h.requests()>0);
  if(mode==='abort'){h.stop();await until(()=>h.aborted()&&h.pool.activeFlights===0);}else await until(()=>h.finished()>0&&h.pool.activeFlights===0);
  assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,h.calendar.bytes);
});

test('a refused reservation shrink keeps the decode ledger conservative through later sequence allocations',async t=>{
  const wire=combined();let lastAccepted=0,refusedShrinks=0;
  t.mock.method(globalThis,'fetch',async()=>new Response(wire.text,{headers:{'content-type':'application/json'}}));
  const request:PeriodRequest={version:1,selection:{mode:'range',from:fixed.from,to:fixed.to},evaluatedAt:fixed.now,calendar:{zone:'UTC'},values:Array.from({length:sourceCount},(_,i)=>'synthetic-source-'+i)};
  const reply=await fetchPeriod('synthetic-board',request,new AbortController().signal,bytes=>{
    if(bytes<lastAccepted){refusedShrinks++;return false;}
    lastAccepted=bytes;return true;
  });
  assert.ok(refusedShrinks>0,'the actual decoder must request release of expired workspace');
  assert.equal(lastAccepted,wire.cumulative,'no refused shrink may lower the next admitted allocation');
  assert.deepEqual(reply.calendar,wire.calendar,'refusing a shrink preserves every calendar cell and validUntil');
  assert.ok(reply.values?.state==='complete');checkValues(reply.values.value);
  t.diagnostic(JSON.stringify({refusedShrinks,lastAccepted,expectedCumulativeCharge:wire.cumulative}));
});
