import {workChange} from '../lib/workChanges';
import * as periodValueClockBindings from '../../server/domain/periodValues';
import {WorkCalendar} from '../lib/workCalendar';
import {AGENT_HOURS_HEATMAP} from '../../server/domain/widgets';
import * as filterModelBindings from '../../server/domain/dataFilters';
import * as filterRuntimeBindings from '../lib/filterSelection';
import * as filterCurveBindings from '../../server/domain/periodCurves';
import * as retention from '../../server/domain/periodRetention';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodTransport,fetchPeriod} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {HistoryStore} from '../lib/history';
import {drain,Preparations,prepareAsync as productionPrepareAsync} from '../lib/prepare';
import {PeriodAccounting} from '../../server/domain/periodAccounting';

import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {evaluatedRange,periodKey,type PeriodRange} from '../../server/domain/period';
import {cellOf,expandHistory} from '../../server/domain/history';
import {PERIOD_SCOPES} from '../../server/domain/periodRead';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared} from '../../server/domain/periodWork';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {hasPeriodValue,periodValueAt} from '../../server/domain/periodValues';
import {canShift,shifted} from '../../server/domain/periodShift';
import {periodOf} from '../lib/periods';
import {moneyReadSelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {subscriptionSelection} from '../lib/subscription';
import {sameJson} from '../lib/store';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';

import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import {ResetFeed} from '../../server/resets';
import {Events} from '../../server/events';
import {HistoryTiles} from '../../server/history';
import {PeriodReader} from '../../server/periodRead';
import {Projection} from '../../server/projection';
import {seedPanningBudgets} from '../../bench/fixture';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expandPeriod} from '../../server/domain/periodWire';
for(const acrossHour of [false,true])test('money preparation keeps cold history reusable across cached return and repeat under the shared limit'+(acrossHour?' across an hour boundary':''),async t=>{
  const DAY=86_400_000,NOW=Date.parse(acrossHour?'2026-10-20T13:00:00Z':'2026-10-08T12:00:00Z'),length=30*DAY;
  // Seeding completes before the initial exclusive read cut.
  let clockNow=NOW+(acrossHour?-1000:1);t.mock.method(Date,'now',()=>clockNow);
  const initialCell=Math.floor(clockNow/cellOf(length));
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  const coordinatorCode=ts.transpileModule(source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const dir=mkdtempSync(join(tmpdir(),'quotum-full-memory-')),file=join(dir,'fixture.sqlite');
  let store=new Store(file,NOW-75*DAY),directory=new Directory(store.db);
  const user=directory.createUser('fixture@example.com','Fixture','fixture',NOW-75*DAY),owner={...user,personalBoard:directory.boards(user.id)[0].id};store.close();
  seedPanningBudgets(file,{start:NOW-(acrossHour?3*3_600_000:0),people:new Map([['fixture',owner]])} as any);
  store=new Store(file);directory=new Directory(store.db);
  store.db.exec('BEGIN');const quotas:string[]=[];
  for(let i=0;i<12;i++){
   const id=store.source('claude',`quota-fixture-${i}`,NOW-75*DAY);quotas.push(id);store.hold(id,user.id,NOW-75*DAY);
   for(let at=NOW-75*DAY;at<=NOW-(acrossHour?3*3_600_000:0);at+=3*3_600_000)store.record(id,{observedAt:at,staleAfterMs:6*3_600_000,plan:'pro',resets:null,windows:[{id:'weekly',kind:'weekly',used:20+i,remaining:80-i,minutes:10080,resetAt:NOW+7*DAY,label:null},{id:'session',kind:'session',used:20+i,remaining:80-i,minutes:300,resetAt:NOW+7*DAY,label:null}]});
  }
  store.db.exec('COMMIT');
  const device=directory.saveDevice({userId:user.id,machine:{id:'test-machine',name:'Laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.7.0',tokenId:null},NOW-75*DAY).id;
  for(let at=NOW-75*DAY;at<NOW;at+=6*3_600_000)store.creditWork(device,at,at+3_600_000,[{source:quotas[0],origin:'terminal',startedAt:NOW-75*DAY,project:'Project',folder:'folder',identity:{kind:'stable',sessionId:'work'}}]);
  const hub:any={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const events=new Events(hub,undefined,{now:()=>clockNow,after:()=>()=>{}},null),server=new PeriodReader(hub,new HistoryTiles(store),events),projection=new Projection(hub);
  const snapshot=projection.snapshot(user.id,owner.personalBoard,clockNow)!;
  const board={id:owner.personalBoard,meta:snapshot.board,cards:Object.fromEntries(snapshot.sources.map(c=>[c.id,c])),lineup:snapshot.sources.map(c=>c.id),view:{...snapshot.view,shown:['quota-history','budget-history','budget-table',SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS]},currencies:snapshot.currencies};
  let selected:PeriodRange|null=null,panning=false,phase='seed';
  const settings={range:'30d',kind:'weekly',money:{...DEFAULT_MONEY},funds:{...DEFAULT_MONEY}};
  const preparer=new Preparations({now:()=>performance.now(),post:run=>setImmediate(run)});
  const pool=new HistoryPool(),attempts:string[]=[],drops:{phase:string;bytes:number}[]=[];
  // Another visible consumer pins actual storage while the three histories share
  // the unchanged board budget. Its allocation is independent of index estimates.
  const pinned=new Uint8Array(5*1024*1024);pool.register({get estimatedBytes(){return pinned.byteLength;},evictionCandidates:()=>[]});
  let peak=0;const reserve=pool.reserve.bind(pool);pool.reserve=(flight,bytes)=>{const result=reserve(flight,bytes);if(result){assert.ok(pool.estimatedBytes<=pool.budget);peak=Math.max(peak,pool.estimatedBytes);}return result;};
  const register=pool.register.bind(pool);pool.register=member=>{
   const evict=member.evictionCandidates.bind(member);
   member.evictionCandidates=()=>evict().map(candidate=>({...candidate,drop:()=>{drops.push({phase,bytes:candidate.bytes});candidate.drop();}}));register(member);
  };
  t.mock.method(globalThis,'fetch',async(_url:any,init:any)=>{
   const body=JSON.parse(init.body);attempts.push(phase);
   const reply=server.read(owner.personalBoard,user.id,body);return new Response(reply,{headers:{'content-type':'application/json'}});
  });
  const context={WorkCalendar,AGENT_HOURS_HEATMAP,exports:{} as any,hubNow:()=>clockNow,retention,historyPool:pool,clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},PeriodTransport,fetchPeriod,page:{get:()=>({board}),dispatch:console.error},pan:{get:()=>panning?{}:null},preparations:()=>preparer,
   prepareAsync:(owner:object,work:any,valid:()=>boolean)=>productionPrepareAsync(owner,work,valid,preparer),evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,canShift,shifted,hasPeriodValue,periodValueAt,
   empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson,timeRange:()=>selected,prefs:()=>settings,periodOf,cellOf,moneyReadSelection,subscriptionSelection,PERIOD_SCOPES,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS,widgetVisible,noSessions:[],noValue:{}};
  runInNewContext(coordinatorCode,Object.assign(context,{workChange},periodValueClockBindings,filterModelBindings,filterRuntimeBindings,filterCurveBindings));const period=new context.exports.BoardPeriod();
  const readers:HistoryStore[]=[];
  for(const [i,scope] of (['quota','budget','budget'] as const).entries()){
   const meter=i===0?undefined:moneyReadSelection(snapshot.sources,board.view,i===2?settings.funds:settings.money,board.currencies,i===2?'funds':'budget');
   const family=i===2?'funds':scope;
   const reader=new HistoryStore({workInPresentation:scope!=='budget',now:()=>clockNow,preparations:preparer,setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:t=>clearTimeout(t as any),dropTimeRange:()=>{throw Error('dropRange')},
    read:(_board,cell,from,to,signal,meters,meta)=>period.transport.read(family,{cell:String(cell),from:String(from),to:String(to),...(panning?{evidence:'skip'}:{}),meta:meta?.meta??'',...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{}),...(meters.work?{work:'1'}:{})}:{})},signal).then((reply:any)=>expandHistory(reply,meta)),
   },pool.budget,scope,pool);
   readers.push(reader);reader.choose('30d',null);reader.setMeters(meter);reader.open(board.id);reader.hello(events.epoch);reader.snapshot(board.lineup,quotas.flatMap(id=>store.state(id).windows.map(w=>`${id} ${w.id}`)),NOW-75*DAY);
  }
  async function settle(){for(let i=0;i<30000;i++){await new Promise(r=>setImmediate(r));if(i>20&&!preparer.size&&!pool.activeFlights&&!period.transport.flights.size&&!period.transport.queue.length&&readers.every(r=>!r.get().loading))return;}throw Error('notsettled');}

  function oracle(label:string){
   const selection=selected?{mode:'range' as const,...selected}:{mode:'live' as const,periodMs:length},range=evaluatedRange(selection,clockNow),key=selected?`${selected.from}-${selected.to}`:'30d';
   const fresh=expandPeriod(JSON.parse(server.read(board.id,user.id,{version:1,selection,evaluatedAt:clockNow,...period.queries(board,range),sessions:{},...(selected?{values:period.sourceIds}:{})})));
   assert.ok(fresh.sessions&&fresh.sessions.state!=='error');const work=fresh.sessions.value,workIndex=new PeriodIndex(work),rows=workIndex.advance(range,clockNow).rows;
   assert.equal(period.get().error,null);assert.equal(period.get().loading,false);assert.deepEqual(JSON.parse(JSON.stringify(period.get().basis.range)),range);
   const workFields=(values:any[])=>values.map(({ref,source,clientId,workedMs,lastWorkedAt,working}:any)=>({ref,source,clientId,workedMs,lastWorkedAt,working}));
   assert.deepEqual(workFields(period.get().rows),workFields(rows),`${label}: credited work`);
   const values=new Map<string,any>();if(fresh.values?.state==='complete')for(const value of fresh.values.value){values.set(value.id,value);const fields=({states,validFor,...value}:any)=>value;assert.deepEqual(fields(periodValueAt(period.getValue(value.id).value,range.to)),fields(periodValueAt(value,range.to)),`${label}: card values`);}
   for(const [i,reader] of readers.entries()){
    const expectedScope=i===0?'quota':i===1?'budget':'funds';
    const shown=reader.get();assert.equal(shown.loading,false);assert.equal(shown.error,undefined);assert.equal(shown.history?.range,key);assert.equal(period.projectionState(shown.history,expectedScope).ready,true);
    const reply=fresh[expectedScope];assert.equal(reply?.state,'complete');const tape=reply.value.tape;assert.ok(tape);
    for(const row of tape.quota){row.samples=drain(retainSamplesPrepared(row.samples,row.samplesEncoding==='delta'));delete row.samplesEncoding;}
    const baseline=new PeriodAccounting(tape,work,workIndex.curves).project(shown.history,range,values),actual=period.project(shown.history,expectedScope,clockNow);
    assert.equal(actual.since,range.from);assert.equal(actual.to,range.to);assert.deepEqual(actual.series,baseline.series,`${label}: exact quota projection`);assert.deepEqual(actual.meterSeries,baseline.meterSeries,`${label}: exact money projection`);assert.deepEqual(actual.moneyWork,baseline.moneyWork,`${label}: exact monetary work`);
    if(expectedScope==='quota'){const activity=new PeriodActivity(work,workIndex.curves);activity.update(rows);const expected=activity.project(baseline.activity,range);const knownFrom=Math.max(range.from,period.work.value.knownFrom),knownTo=Math.min(range.to,period.work.value.cut);expected.known=knownFrom<knownTo?{from:knownFrom,to:knownTo}:null;assert.deepEqual(actual.activity,expected,`${label}: exact activity and retained evidence cut`);}
   }

  }
  async function gesture(label:string,end:number,commit:PeriodRange|null){phase=label;panning=true;const origin=selected?.to??clockNow;
   for(let step=1;step<=30;step++){clockNow+=25;const at=origin+(end-origin)*step/30;for(const reader of readers)reader.pan({token:label==='cold'?1:label==='warm-return'?2:3,length,from:at-length,to:Math.min(NOW,at+(reader.scope==='quota'?DAY:0)),direction:end<origin?-1:1});await new Promise(r=>setTimeout(r,25));}
   selected=commit;for(const reader of readers)reader.choose('30d',selected);panning=false;for(const reader of readers)reader.endPan(true);period.changed();await settle();oracle(label);
  }
  try{
   period.activate(true);await settle();
   const money=period.tapes.get('budget').tape.money.filter((group:any)=>group.workCounter);
   assert.equal(money.length,12,'the real provider fixture has twelve native usage ledgers');
   for(const group of money)assert.equal(group.workCounter.readings,group.readings,'identical financial and work observations occupy one retained array');
   assert.ok(period.get().rows.some((row:any)=>row.workedMs>0),'the retained work fixture must have positive credit inside its known period');
   // Returning across the hour retires a real financial prefix while cold tiles
   // are unpinned. Retirement must not consume their space for discarded scratch.
   const end=NOW-(length+(acrossHour?0:DAY))*.5;await gesture('cold',end,{from:end-length,to:end});
   await gesture('warm-return',NOW,null);await gesture('warm-repeat',end,{from:end-length,to:end});
   assert.equal(Math.floor(clockNow/cellOf(length)),initialCell,'the hour edge stays inside the original history freshness cell');
   assert.equal(attempts.filter(stage=>stage.startsWith('warm')).length,0,'warm return/repeat must not read any history section');
   assert.ok(peak<=15*1024*1024);assert.deepEqual(drops,[],'preparation cannot evict reusable history');
  }finally{period.activate(false);for(const r of readers)r.close();events.close();preparer.dispose();store.close();rmSync(dir,{recursive:true,force:true});}

});
