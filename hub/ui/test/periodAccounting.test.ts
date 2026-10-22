import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../lib/periodAccounting.js';
import {PeriodActivity} from '../lib/periodActivity.js';
import {PeriodIndex} from '../lib/periodIndex.js';
import {packSamples,sampleDeadlineAt,retainSamplesPrepared,type PeriodTape,type SampleRows} from '../../server/domain/periodTape.js';
import {drain} from '../../server/domain/prepare.js';
import type {History} from '../lib/types.js';
import type {Reading} from '../../server/domain/meters.js';
import {packWork,workedSessions,type WorkTrace} from '../../server/domain/periodWork.js';
import {union} from '../../server/domain/work.js';
import {fixedTape,fixedWork} from '../../server/periodFixed.js';
import {shifted} from '../../server/domain/periodShift.js';
import {periodTextChangesAt} from '../lib/periodClock.js';
import {lineWork,workText,workLeftChangesAt,WORK_COLUMNS} from '../lib/work.js';
import {setLocale} from '../i18n/index.js';
import {expandPeriod,periodDictionary} from '../../server/domain/periodWire.js';
import {compactJSON} from '../../server/history.js';
import {cellsOf} from '../../server/domain/cells.js';
import {compose,type HistorySeries} from '../../server/domain/history.js';
import {valueIn} from '../lib/lines.js';
import {observationRunsPrepared} from '../lib/plotPath.js';

for(const cadence of [30_000,120_000])for(const kind of ['weekly','session'] as const)test(`fixed ${kind} retains producer cell support at ${cadence}ms cadence`,()=>{
  const cell=60_000,range={from:30_000,to:390_000};
  const samples=Array.from({length:Math.floor(420_000/cadence)+1},(_,i)=>({at:i*cadence,used:10+i,resetAt:600_000,staleAfterMs:180_000}));
  const groups=[{source:'s',window:kind,samples}],known={work:0,sources:{s:0}};
  const frame=compose(cellsOf(groups,[],{},cell,0,420_000,known).map(c=>({...c,activity:{...c.activity,sessions:[]}})),{now:420_000,historyStart:0,known},{cell,k0:0,k1:6,length:420_000,live:false,key:'fixed',now:420_000},new Set(['s '+kind]));
  assert.ok(frame.series[0].points.every(p=>p.length===3),'the regression must use actual unbounded cells');
  const evidence:PeriodTape={from:0,cut:420_000,replaceFrom:0,cursor:'c',quota:groups.map(g=>({...g,samples:packSamples(g.samples)})),money:[]};
  const full=new PeriodAccounting(evidence,null),compact=new PeriodAccounting(fixedTape(evidence,null,range,cell,()=>{}),null);
  for(const projected of [compact.project(frame,range),full.project(frame,range)]){
    const line=projected.series[0];assert.equal(line.pointMode,'observation');
    // Interior expectations come from the original cell contract, independently
    // of either accounting implementation. Partial edges use raw observations.
    for(let at=cell;at<360_000;at+=15_000){
      const expected=valueIn(frame.series[0].points,Math.floor(at/cell)*cell,420_000,180_000);
      assert.equal(valueIn(line.points,at,420_000,180_000,undefined,line.pointMode),expected,`interior ${at}`);
    }
    for(const at of [30_000,45_000,360_000,375_000,389_999]){
      const raw=samples.filter(s=>s.at<=at).at(-1)!;
      assert.equal(valueIn(line.points,at,420_000,180_000,undefined,line.pointMode),100-raw.used,`exact boundary ${at}`);
    }
    const drawing=drain(observationRunsPrepared(line.points,range.from,range.to,420_000));
    assert.ok(drawing.runs.some(run=>run.some(([at])=>at>=120_000&&at<360_000)),'interior geometry survives');
  }
});

test('fixed cell normalization respects exclusive deadlines, segment breaks and terminal coverage',()=>{
  const range={from:30_000,to:570_000},cell=60_000;
  const samples=[{at:0,used:10,resetAt:null,staleAfterMs:180_000,validUntil:180_000},{at:240_000,used:20,resetAt:null,staleAfterMs:60_000},{at:420_000,used:30,resetAt:null,staleAfterMs:60_000}];
  const known={work:0,sources:{s:0}},groups=[{source:'s',window:'w',samples}];
  const frame=compose(cellsOf(groups,[],{},cell,0,600_000,known).map(c=>({...c,activity:{...c.activity,sessions:[]}})),{now:600_000,historyStart:0,known},{cell,k0:0,k1:9,length:600_000,live:false,key:'fixed',now:600_000},new Set(['s w']));
  const evidence:PeriodTape={from:0,cut:600_000,replaceFrom:0,cursor:'c',quota:groups.map(g=>({...g,samples:packSamples(g.samples)})),money:[]};
  const compact=new PeriodAccounting(fixedTape(evidence,null,range,cell,()=>{}),null);
  const line=compact.project(frame,range).series[0];
  const read=(at:number)=>valueIn(line.points,at,600_000,180_000,undefined,line.pointMode);
  assert.equal(read(179_999),90);assert.equal(read(180_000),undefined);assert.equal(read(239_999),undefined);
  assert.equal(read(240_000),80);assert.equal(read(300_000),undefined,'a new segment cannot bridge the gap');
  assert.equal(read(480_000),70,'the terminal cell keeps its existing inclusive cell hold');
  assert.equal(read(540_000),undefined,'exact last boundary does not extend terminal support');
  for(const deadline of [0,60_000]){
    const invalid:HistorySeries={...frame.series[0],points:[[60_000,99,1,deadline],[240_000,80,1]]};
    const projected=compact.project({...frame,series:[invalid]},range).series[0];
    assert.equal(valueIn(projected.points,90_000,600_000,180_000,undefined,projected.pointMode),undefined);
  }
  assert.equal(compact.project(frame,{...range,to:range.to-1}),frame,'wrong fixed range is refused');
  const wrongCell={...frame,cellMs:30_000};assert.equal(compact.project(wrongCell,range),wrongCell);
});

test('shared work curves match exact session sums and concurrent unions across hour boundaries',()=>{
  const refs=Array.from({length:5},(_,i)=>({ref:String(i),source:String(i%2),device:{id:String(i%3),name:'Laptop'},origin:'terminal' as const,project:i%2?'P':null,folder:null,startedAt:0}));
  const trace:WorkTrace={anchor:0,cut:3*3_600_000,knownFrom:0,refs,spans:[]};
  for(let id=0;id<refs.length;id++)for(let n=0;n<43;n++){const from=n*237_117+id*913;trace.spans.push([id,from,from+111_023+id*7]);}
  const packed=packWork(trace),index=new PeriodIndex(packed),activity=new PeriodActivity(packed,index.curves);
  for(let from=0;from<9_000_000;from+=173_113){const range={from,to:from+899_997},expected=workedSessions(trace,range,range.to),rows=index.advance(range,range.to).rows;activity.update(rows);const shown=activity.project(blank.activity,range);assert.deepEqual(rows,expected);assert.equal(shown.agentMs,expected.reduce((n,r)=>n+r.workedMs,0));const active=union(trace.spans.map(([,a,b])=>({from:Math.max(a,from),to:Math.min(b,range.to)})).filter(s=>s.to>s.from)).reduce((n,[a,b])=>n+b-a,0);assert.equal(shown.activeMs,active);}
  const atStart=index.advance({from:0,to:237_117},237_117).rows.find(r=>r.ref==='0')!;
  assert.equal(atStart.lastWorkedAt,111_023,'an interval starting at the exclusive end contributes no last-work evidence');
});

const blank:History={range:'1h',live:true,since:0,to:60_000,cellMs:60_000,historyStart:0,events:[],series:[],activity:{since:0,known:{from:0,to:60_000},barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
const tape=():PeriodTape=>({from:0,cut:60_000,replaceFrom:0,cursor:'cursor',quota:[],money:[]});
for(const compressed of [false,true])test(`ordered quota deadlines keep retirement preparation linear with ${compressed?'compressed':'flat'} samples`,()=>{
  const count=2048,cycle=512,step=1000;
  const samples=packSamples(Array.from({length:count},(_,i)=>({at:i*step,used:10+(i%cycle)*.125,resetAt:(Math.floor(i/cycle)+1)*cycle*step,staleAfterMs:count*step})));
  const evidence={...tape(),cut:count*step,quota:[{source:'s',window:'w',samples:compressed?drain(retainSamplesPrepared(samples)):samples}]};
  const before=JSON.stringify(evidence),prepared=PeriodAccounting.prepare(evidence,null);
  let steps=0,result=prepared.next();while(!result.done){steps++;result=prepared.next();}
  assert.ok(steps<count*1.25,`already ordered deadlines took ${steps} cooperative steps for ${count} samples`);
  assert.deepEqual(result.value.quotaSummary('s','w',{from:0,to:(count-1)*step+1}),{
    consumed:(count/cycle)*(cycle-1)*.125,coveredMs:(count/cycle)*(cycle-1)*step,
    remainingAtStart:90,remainingAtEnd:100-10-(cycle-1)*.125,work:null,
    selectedWork:{from:(count-1)*step+1,ms:null,agentMs:0},
  });
  assert.equal(JSON.stringify(evidence),before);
});

test('unavailable work does not read its captured curve while preparing quota accounting',t=>{
  const count=512,evidence=tape();
  evidence.cut=count*1000;
  evidence.quota=[{source:'s',window:'w',samples:drain(retainSamplesPrepared(packSamples(Array.from({length:count},(_,i)=>({at:i*1000,used:10+(i%128)*.1,resetAt:(Math.floor(i/128)+1)*128000,staleAfterMs:count*1000})))))}];
  const work:WorkTrace={anchor:0,cut:count*1000,knownFrom:0,available:false,
    refs:[{ref:'r',source:'s',device:{id:'d',name:'Laptop'},origin:'terminal',project:null,folder:null,startedAt:0}],spans:[[0,0,count*1000]]};
  const curves=new PeriodIndex(work).curves,activity=curves.groups.source.get('s');
  assert.ok(activity);
  t.mock.method(activity,'read',()=>{throw new Error('unavailable work was read');});
  const before=JSON.stringify(evidence),accounting=drain(PeriodAccounting.prepare(evidence,work,curves)),reference=new PeriodAccounting(evidence,null);
  for(const range of [{from:0,to:1001},{from:117.125,to:128001},{from:128001,to:evidence.cut}]){
    assert.equal(accounting.quotaSummary('s','w',range)!.work,null);
    assert.deepEqual(accounting.fixed(range,1000),reference.fixed(range,1000));
  }
  assert.equal(JSON.stringify(evidence),before);
});

test('quota deadlines keep exact stale, reset and exclusive supplier bounds in every sample representation',()=>{
  const samples=packSamples([
    {at:1000.125,used:17,resetAt:null,staleAfterMs:2000.25},
    {at:2000.125,used:31,resetAt:4000.5,staleAfterMs:10_000,validUntil:3000.75},
    {at:3000.125,used:49,resetAt:3500.5,staleAfterMs:10_000,validUntil:4000.75},
    {at:4000.125,used:53,resetAt:0,staleAfterMs:10_000},
    {at:5000.125,used:61,resetAt:null,staleAfterMs:10_000,validUntil:0},
  ]);
  const versions:SampleRows[]=[samples,new Float64Array(samples),drain(retainSamplesPrepared(samples))];
  for(const rows of versions){
    assert.deepEqual([0,1,2,3,4].map(i=>sampleDeadlineAt(rows,i)),[3001.375,3000.75,3500.5,0,0]);
    assert.equal(sampleDeadlineAt(rows,-1),undefined);assert.equal(sampleDeadlineAt(rows,5),undefined);
  }
  for(const empty of [[],new Float64Array(0),drain(retainSamplesPrepared([]))])assert.equal(sampleDeadlineAt(empty,0),undefined);
});

for(const cadence of [0,1000])test(`quota deadlines read ${cadence?'run-compressed':'constant'} columns without decoding the quota value`,()=>{
  const rows=drain(retainSamplesPrepared(packSamples(Array.from({length:128},(_,i)=>({at:1000+i*cadence,used:17,resetAt:null,staleAfterMs:1000})))));
  if(!('columns' in rows))throw new Error('samples were not packed');
  if(cadence)assert.ok(rows.columns[0].runs);else assert.equal(rows.columns[0].values,null);
  let usedReads=0;const used=rows.columns[1];
  Object.defineProperty(rows.columns,1,{get(){usedReads++;return used;}});
  const expected=cadence?[2001,65001,129001]:[2001,2001,2001];
  assert.deepEqual([0,63,127].map(i=>sampleDeadlineAt(rows,i)),expected);
  assert.equal(usedReads,0,'a deadline needs observation and validity fields only');
});

test('out-of-order quota deadlines preserve the rolling wake and exclusive availability',()=>{
  const samples=packSamples([
    {at:0,used:10,resetAt:null,staleAfterMs:20_000},
    {at:1000,used:20.125,resetAt:null,staleAfterMs:100},
    {at:2000,used:30.25,resetAt:null,staleAfterMs:5000},
  ]);
  for(const rows of [samples,new Float64Array(samples),drain(retainSamplesPrepared(samples))]){
    const evidence=tape();evidence.quota=[{source:'s',window:'w',samples:rows}];
    const accounting=drain(PeriodAccounting.prepare(evidence,null));
    assert.equal(accounting.changesAt(21_001,20_000,'s'),21_101);
    assert.equal(accounting.quotaSummary('s','w',{from:0,to:1100})!.remainingAtEnd,79.875);
    assert.equal(accounting.quotaSummary('s','w',{from:0,to:1101})!.remainingAtEnd,null);
  }
});

test('a quota clock includes both knowledge boundaries without any working context',()=>{
  const evidence=tape();evidence.quota=[{source:'s',window:'w',samples:[]}];
  const work:WorkTrace={anchor:0,knownFrom:100,refs:[],spans:[]},accounting=new PeriodAccounting(evidence,work),period=1000;
  const summary=(now:number)=>accounting.quotaSummary('s','w',{from:now-period,to:now})!.work!;
  assert.equal(accounting.quotaChangesAt('s','w',99,period),101);
  assert.equal(summary(100).ms,null);assert.equal(summary(101).ms,0);
  assert.equal(accounting.quotaChangesAt('s','w',1099,period),1100);
  for(const locale of ['en','ru'] as const){
    setLocale(locale,false);
    const read=(now:number)=>JSON.stringify(workText('work',{none:'none'},summary(now),now-period,null,null));
    assert.equal(periodTextChangesAt(1099,at=>accounting.quotaChangesAt('s','w',at,period)!,read),1100);
    assert.notEqual(read(1099),read(1100),'the since qualification ends at equality');
  }
  setLocale('en',false);
  assert.equal(accounting.quotaChangesAt('s','w',1100,period),null);
  assert.equal(accounting.quotaChangesAt('s','missing',1100,period),undefined);
  assert.equal(accounting.quotaChangesAt('missing','w',1100,period),undefined);
  assert.equal(new PeriodAccounting(evidence,null).quotaChangesAt('s','w',1100,period),null,'unknown work never invents a deadline');
  evidence.fixed={range:{from:0,to:1000},cell:100,quota:[],money:[]};
  const fixed=new PeriodAccounting(evidence,work);
  assert.equal(fixed.changesAt(1100,period),null);assert.equal(fixed.quotaChangesAt('s','w',1100,period),undefined);
});

test('each quota work column keeps exact content and titles through source handoffs and gaps',()=>{
  const period=3_600_000,refs=Array.from({length:8},(_,i)=>({ref:String(i),source:'s',device:{id:'d',name:'Device'},origin:'terminal' as const,project:null,folder:null,startedAt:0}));
  const trace:WorkTrace={anchor:0,cut:period,knownFrom:17,refs,spans:refs.flatMap((_,i)=>[[i,i*120_000,(i+1)*120_000] as [number,number,number],[i,1_200_000+i*311,1_400_000+i*311] as [number,number,number]])};
  const index=new PeriodIndex(trace),evidence=tape();
  evidence.quota=[{source:'s',window:'w',samples:packSamples(Array.from({length:31},(_,i)=>({at:i*120_000,used:10+(i%10)*.25,resetAt:(Math.floor(i/10)+1)*1_200_000,staleAfterMs:i%3?240_000:13_111})))}];
  const accounting=new PeriodAccounting(evidence,trace,index.curves),resetAt=period+2_000_000;
  for(const locale of ['en','ru'] as const){
    setLocale(locale,false);
    for(const column of WORK_COLUMNS)for(const now of [period,period+1,period+17,period+120_000,period+1_200_000,period+1_399_999]){
      const lineAt=(at:number)=>({...accounting.quotaSummary('s','w',{from:at-period,to:at})!,current:85,minutes:300});
      const read=(at:number)=>{const line=lineAt(at),cells=lineWork(line,false,resetAt,at)!,perWork='value' in cells.perwork?cells.perwork.value:null;return JSON.stringify(workText(column,cells[column],line.work!,at-period,resetAt,perWork));};
      const original=(at:number)=>{
        let next=accounting.changesAt(at,period,'s')??Infinity;
        for(const curve of index.curves.contexts)next=Math.min(next,curve.next(at-period)+period,curve.next(at));
        if(column==='workleft')next=Math.min(next,workLeftChangesAt(lineAt(at),resetAt,at)??Infinity);
        return Number.isFinite(next)?next:null;
      };
      const own=(at:number)=>{const next=Math.min(accounting.quotaChangesAt('s','w',at,period)??Infinity,column==='workleft'?workLeftChangesAt(lineAt(at),resetAt,at)??Infinity:Infinity);return Number.isFinite(next)?next:null;};
      const due=periodTextChangesAt(now,own,read);
      assert.equal(due,periodTextChangesAt(now,original,read),`${locale}/${column}/${now}`);
      if(column==='work'||column==='agenthours'){
        const selected=(at:number)=>accounting.quotaSelectedWorkChangesAt('s','w',at,period)??null;
        assert.equal(periodTextChangesAt(now,selected,read),due,`${locale}/${column} keeps its first displayed transition without quota boundaries`);
      }
      if(due!==null){
        assert.ok(due>now);const seen=read(now);
        for(const at of [now+1,Math.floor((now+due)/2),due-1])if(at<due)assert.equal(read(at),seen);
      }
    }
  }
  setLocale('en',false);
});

test('selected work clocks preserve different supplier curves and knowledge without quota-only wakes',()=>{
  const H=3_600_000,M=60_000,refs=[0,1].map(i=>({ref:String(i),source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:String(i),folder:null,startedAt:0}));
  const all:WorkTrace={anchor:0,cut:H,knownFrom:0,refs,spans:[[0,0,H/2],[1,H/3,H]]};
  const supplier=new PeriodIndex(all).curves;
  for(const knownFrom of [0,17*M])for(const workFrom of [0,23*M]){
    const selected={...all,knownFrom,spans:all.spans.filter(([id])=>id===0)},curves=new PeriodIndex(selected).curves;
    const evidence={...tape(),cut:H,quota:[{source:'s',window:'w',workFrom,samples:packSamples(Array.from({length:61},(_,i)=>({at:i*M,used:i/10,resetAt:3*H,staleAfterMs:2*H})))}]};
    const accounting=drain(PeriodAccounting.prepare(evidence,selected,curves,undefined,undefined,undefined,{groups:{source:supplier.groups.source},knownFrom:0}));
    for(const locale of ['en','ru'] as const){setLocale(locale,false);
      for(const column of ['work','agenthours'] as const)for(const now of [knownFrom,workFrom,H,H+1,H+17*M,2*H]){
        const read=(at:number)=>{const summary=accounting.quotaSummary('s','w',{from:at-H,to:at})!,line={...summary,current:83,minutes:300},cells=lineWork(line,false,3*H,at)!;return JSON.stringify(workText(column,cells[column],line.work,at-H,3*H,null,line.selectedWork));};
        const legacy=periodTextChangesAt(now,at=>accounting.quotaChangesAt('s','w',at,H)??null,read);
        const due=periodTextChangesAt(now,at=>accounting.quotaSelectedWorkChangesAt('s','w',at,H)??null,read);
        if(due!==legacy){
          assert.equal(due,null);assert.equal(legacy,now+H,'only an unchanged hourly fallback may disappear');
          for(const offset of [1,M,17*M,30*M,H-1,H])assert.equal(read(now+offset),read(now));
        }
      }
    }
    assert.equal(accounting.quotaSelectedWorkChangesAt('missing','w',H,H),undefined);
    assert.equal(accounting.quotaSelectedWorkChangesAt('s','missing',H,H),undefined);
    for(const unavailable of [{...selected,available:false as const},selected]){
      const rows={...evidence,quota:evidence.quota.map(row=>({...row,...(unavailable===selected?{workFrom:null}:{})}))};
      const unknown=drain(PeriodAccounting.prepare(rows,unavailable,curves));
      assert.equal(unknown.quotaSelectedWorkChangesAt('s','w',H,H),undefined,'unknown work retains the prior display clock');
    }
  }
  setLocale('en',false);
});

test('a knowledge edge survives a zero-net handoff and literal unknown uses its captured aggregate',()=>{
  const refs=[{ref:'a',source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:null,folder:null,startedAt:0},{ref:'b',source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:null,folder:null,startedAt:0}];
  const trace:WorkTrace={anchor:0,knownFrom:0,refs,spans:[[0,0,100],[1,100,200]]},index=new PeriodIndex(trace),evidence=tape(),period=1000;
  evidence.quota=[{source:'s',window:'w',workFrom:100,samples:[]}];
  const accounting=new PeriodAccounting(evidence,trace,index.curves);
  assert.equal(index.curves.groups.source.get('s')!.next(99),200,'the aggregate has no slope change at the handoff');
  assert.equal(accounting.quotaChangesAt('s','w',1099,period),1100,'knowledge remains an independent boundary');
  for(const locale of ['en','ru'] as const){
    setLocale(locale,false);
    const read=(now:number)=>{const work=accounting.quotaSummary('s','w',{from:now-period,to:now})!.work!;return JSON.stringify(workText('work',{value:work.ms!},work,now-period,null,null));};
    assert.notEqual(read(1099),read(1100));
    assert.equal(periodTextChangesAt(1099,at=>accounting.quotaChangesAt('s','w',at,period)!,read),1100);
  }
  setLocale('en',false);
  const unknownTrace:WorkTrace={...trace,refs:refs.map((ref,i)=>({...ref,source:i?'unknown':null}))};
  const unknownIndex=new PeriodIndex(unknownTrace);
  evidence.quota=[{source:'unknown',window:'w',samples:[]}];
  const unknown=new PeriodAccounting(evidence,unknownTrace,unknownIndex.curves);
  assert.equal(unknown.quotaSummary('unknown','w',{from:0,to:200})!.work!.ms,200);
  assert.equal(unknown.quotaChangesAt('unknown','w',1001,period),1200,'read and wake retain the same existing aggregate semantics');
});

for(const bound of ['ttl','reset','hold','interruption','paired'] as const)test(`fixed endpoint validity survives wire and cached shifts with ${bound} money bounds independently of card values`,()=>{
  const evidence=tape(),range={from:0,to:2000},at=100;
  evidence.cut=at;evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:10,used:17,staleAfterMs:1000,resetAt:600,validUntil:500}])}];
  const reading:Reading={id:'balance',kind:'balance',unit:'credits:codex',amount:'1000000',limit:null,at:10,previousAt:null,staleAfterMs:1000,resetAt:bound==='reset'?350:null,minutes:null,scope:null,label:null};
  const span={from:10,to:10,staleAfterMs:1000,...(bound==='hold'?{holdUntil:400}:{}),...(bound==='interruption'?{interruptedAt:450}:{})};
  evidence.money=[{source:'s',meter:'balance',displayUnit:'USD',readings:[reading],spans:[span],rates:{'credits:codex\n10':[{id:'coefficient',base:'credits:codex',from:'1000000',to:'40000',source:'manual',date:0,fetchedAt:0}]},...(bound==='paired'?{paired:{readings:[{...reading,amount:'3000000'}],spans:[{...span,holdUntil:250}]}}:{})}];
  const deadline={ttl:1011,reset:350,hold:400,interruption:450,paired:250}[bound];
  const fixed=new PeriodAccounting(evidence,null).fixed(range,60_000,at);
  assert.equal(fixed.quota[0].endValidUntil,500);assert.equal(fixed.money[0].endValidUntil,deadline);assert.notEqual(fixed.money[0].end,null);
  const basis={run:'r',revision:'1',evaluatedAt:at,evidenceCut:at,range},reply={basis,quota:{state:'complete' as const,basis,value:{version:1 as const,run:'r',now:at,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:{...evidence,quota:[],money:[],fixed}}}};
  const dictionary=periodDictionary(reply,()=>{}),decoded=expandPeriod(JSON.parse(compactJSON(reply,dictionary.replacer)));
  if(decoded.quota?.state!=='complete')throw Error('fixed wire');const retained=decoded.quota.value.tape!;
  for(const clock of [at,deadline-1,deadline,500,2000]){
    const result=new PeriodAccounting(retained,null).project({...blank,live:false},range,undefined,false,Math.min(range.to,clock));
    assert.equal(result.series[0].remainingAtEnd,clock<500?83:null);
    assert.equal(result.meterSeries![0].end,clock<deadline?fixed.money[0].end:null);
  }
  const cached=fixedTape(evidence,null,{from:0,to:at-2},60_000,()=>{}).fixed!,moved=shifted(cached,{from:1,to:at-1});assert.ok(moved);
  assert.equal(moved.quota[0].endValidUntil,500);assert.equal(moved.money[0].endValidUntil,deadline);
  const accounting=new PeriodAccounting({...retained,fixed},null);
  assert.equal(accounting.changesAt(at,0),Math.min(500,deadline));assert.equal(accounting.changesAt(Math.max(500,deadline),0),null);
  assert.equal(accounting.changesAt(at,0,'another'),null);
});
test('ordered native quota bounds prepare in linear work and nonmonotonic bounds retain their deadlines',()=>{
  const count=4096,evidence=tape();
  const samples=Array.from({length:count},(_,i)=>({at:i*100,used:i%100,resetAt:1_000_000,staleAfterMs:1000}));
  evidence.cut=count*100;evidence.quota=[{source:'s',window:'w',samples:packSamples(samples)}];
  const task=PeriodAccounting.prepare(evidence,null);let turns=0,result;
  for(;;){const step=task.next();if(step.done){result=step.value;break;}turns++;}
  assert.ok(turns<count*8,'already ordered native bounds must not add a logarithmic sort to a replacement baseline');
  assert.equal(result.changesAt(count*100,100_000),count*100+1);
  const unordered=tape();unordered.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10,resetAt:null,staleAfterMs:900},{at:100,used:20,resetAt:null,staleAfterMs:100},{at:200,used:30,resetAt:null,staleAfterMs:500}])}];
  const mixed=new PeriodAccounting(unordered,null);
  assert.equal(mixed.changesAt(1001,1000),1101);
  assert.equal(mixed.changesAt(1101,1000),1201,'a later observation can expire before an earlier one');
  assert.equal(mixed.changesAt(1201,1000),1701);
});
test('exact endpoints exclude later samples of the same cell and stop validity at reset',()=>{
  const evidence=tape();evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10,resetAt:50_000,staleAfterMs:60_000},{at:20_000,used:25,resetAt:50_000,staleAfterMs:60_000},{at:40_000,used:90,resetAt:50_000,staleAfterMs:60_000}])}];
  const frame={...blank,series:[{sourceId:'s',windowId:'w',consumed:80,coveredMs:40_000,remainingAtStart:90,remainingAtEnd:10,staleAfterMs:60_000,points:[[0,10,1] as [number,number,number]],work:null}]};
  const accounting=new PeriodAccounting(evidence,null);
  const selected=accounting.project(frame,{from:0,to:30_000}).series[0];
  assert.equal(selected.consumed,15);assert.equal(selected.remainingAtEnd,75);assert.equal(selected.coveredMs,20_000);
  assert.equal(accounting.project(frame,{from:0,to:20_000}).series[0].remainingAtEnd,90,'a sample exactly at to is excluded');
  assert.equal(accounting.project(frame,{from:10_000,to:30_000}).series[0].consumed,0,'an uncertain boundary movement is not divided proportionally');
  assert.equal(accounting.project(frame,{from:10_000,to:50_000}).series[0].remainingAtEnd,null,'exclusive reset expires availability');
});

test('money uses exact native steps and historical allowance, including an inside-cell end',()=>{
  const value=(at:number,amount:string,limit:string|null=null):Reading=>({id:'cap',kind:limit===null?'counter':'cap',unit:'credits:zai',amount,limit,at,previousAt:at?0:null,staleAfterMs:60_000,resetAt:null,minutes:300,scope:null,label:null});
  const evidence=tape();evidence.money=[{source:'s',meter:'cap',accounting:{spending:'unavailable',topups:'unavailable'},readings:[value(0,'9007199254740993','18014398509481986'),value(40_000,'9007199254740993','36028797018963972')],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const frame:History={...blank,meterSeries:[{sourceId:'s',meterId:'cap',unit:'credits:zai',kind:'cap',start:null,end:null,spent:null,topup:null,coveredMs:0,unlocated:[],topupUnlocated:[],semantics:null,points:[]}]};
  const accounting=new PeriodAccounting(evidence,null),old=accounting.project(frame,{from:0,to:30_000}).meterSeries![0];
  assert.equal(old.end,'9007199254740993');assert.equal(old.semantics?.limit,'18014398509481986');
  assert.equal(accounting.project(frame,{from:0,to:50_000}).meterSeries![0].end,'27021597764222979');
  evidence.money=[{source:'s',meter:'cap',accounting:{spending:'counter',topups:'unavailable'},readings:[value(0,'0'),value(20_000,'9007199254740993'),value(40_000,'9007199254741093')],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const counter=new PeriodAccounting(evidence,null),cut=counter.project(frame,{from:10_000,to:30_000}).meterSeries![0];
  assert.equal(cut.spent,'0');assert.deepEqual(cut.unlocated.map(s=>s.amount),['9007199254740993']);
  assert.equal(counter.project(frame,{from:0,to:40_000}).meterSeries![0].spent,'9007199254740993');
});

test('rolling money clocks include historical resets and validity beyond the last evidence cut',()=>{
  const value=(at:number,resetAt:number):Reading=>({id:'cap',kind:'cap',unit:'credits:zai',amount:'1',limit:'10',at,previousAt:null,staleAfterMs:60_000,resetAt,minutes:300,scope:null,label:null});
  const evidence=tape();evidence.money=[{source:'s',meter:'cap',readings:[value(0,15_000),value(40_000,90_000)],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const accounting=new PeriodAccounting(evidence,null),period=100_000;
  const at=(now:number)=>accounting.moneySummary('s','cap','credits:zai',{from:now-period,to:now})!.start;
  for(const [now,due] of [[100_001,115_000],[160_001,190_000]]){
    assert.equal(periodTextChangesAt(now,at=>accounting.changesAt(at,period,'s'),now=>String(at(now))),due);
    assert.equal(at(now),'9');assert.equal(at(due-1),'9');assert.equal(at(due),null);
  }
  assert.equal(accounting.changesAt(100_001,period,'another'),null);
});

test('the roster and activity share exact rolling duration, union, counts and bounded edge bars',()=>{
  const refs=['a','b'].map(ref=>({ref,source:'s',device:{id:'d',name:'Laptop'},origin:'terminal' as const,project:'P',folder:null,startedAt:0}));
  const trace={anchor:0,cut:30,knownFrom:0,refs,spans:[[0,0,10],[0,20,30],[1,0,5],[1,15,30]] as [number,number,number][]};
  const index=new PeriodIndex(trace),activity=new PeriodActivity(trace);
  const base={...blank.activity,barMs:30,cells:[[0,25,40,2] as [number,number,number,number]],by:{source:[{key:'s',name:null,agentMs:40,activeMs:25,agents:2,cells:[[0,40] as [number,number]]}],project:[],device:[]}};
  for(const [from,total,active] of [[0,40,25],[6,29,19],[30,0,0]]) {
    const range={from,to:from+30},rows=index.advance(range,range.to).rows;activity.update(rows);const shown=activity.project(base,range);
    assert.equal(shown.agentMs,total);assert.equal(shown.activeMs,active);assert.equal(shown.agentMs,rows.reduce((sum,r)=>sum+r.workedMs,0));
    assert.equal(shown.by.source.reduce((sum,g)=>sum+g.agentMs,0),total);assert.equal(shown.cells.reduce((sum,c)=>sum+c[2],0),total);
  }
});


test('fixed boundary geometry keeps the old native window and cap allowance inside a coarse cell',()=>{
  const evidence=tape();
  evidence.quota=[{source:'s',window:'gone',member:true,windowValue:{id:'gone',kind:'weekly',label:'Retained',minutes:10080},samples:packSamples([{at:0,used:10,resetAt:null,staleAfterMs:60_000},{at:40_000,used:90,resetAt:null,staleAfterMs:60_000}])}];
  const accounting=new PeriodAccounting(evidence,null),shown=accounting.project({...blank,live:false},{from:10_000,to:30_000});
  assert.equal(shown.series[0].windowValue?.label,'Retained');assert.equal(shown.series[0].remainingAtEnd,90);
  assert.deepEqual(shown.series[0].points,[[10_000,90,1,30_000]]);
});

test('credit heartbeats keep exact coefficients and their own valuation without inventing spending',()=>{
  const evidence=tape(),rate=(to:string)=>[{id:to,base:'credits:codex',from:'1000000',to,source:'manual',date:0,fetchedAt:0}];
  evidence.money=[{source:'s',meter:'balance:credits',displayUnit:'USD',accounting:{spending:'unavailable',topups:'unavailable'},
    readings:[{id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'2500000000001',scale:12,limit:null,at:0,previousAt:null,staleAfterMs:60000,resetAt:null,minutes:null,scope:null,label:null}],
    spans:[{from:0,to:40000,staleAfterMs:60000}],rates:{'credits:codex\n0':rate('40000'),'credits:codex\n40000':rate('30000')}}];
  const frame:History={...blank,live:false,meterSeries:[{sourceId:'s',meterId:'balance:credits',unit:'USD',kind:'balance',start:null,end:null,spent:null,topup:null,coveredMs:0,unlocated:[],topupUnlocated:[],semantics:null,points:[]}]};
  const accounting=new PeriodAccounting(evidence,null);
  const before=accounting.project(frame,{from:0,to:40000}).meterSeries![0];
  assert.equal(before.end,'100000');
  const after=accounting.project(frame,{from:0,to:50000}).meterSeries![0];
  assert.equal(after.end,'75000');assert.equal(after.spent,null);assert.equal(after.topup,null);
  assert.equal(after.points.find(p=>p.at===40000)?.value,'75000');
  const summary=fixedTape(evidence,null,{from:0,to:50000},frame.cellMs,()=>{}).fixed!.money[0];
  assert.equal(summary.end,'75000');assert.equal(summary.endScale,6);
  assert.deepEqual(summary.semantics?.conversion?.original,{meterId:'balance:credits',amount:'2500000000001',unit:'credits:codex',at:40000,scale:12,limit:null});
  assert.equal(summary.semantics?.conversion?.rate.to,'30000');
});


test('quota evidence can precede work without fabricating dates, and keeps the source sharing boundary',()=>{
  const evidence=tape();evidence.quota=[{source:'s',window:'w',workFrom:20000,samples:packSamples([{at:0,used:10,resetAt:null,staleAfterMs:60000},{at:30000,used:20,resetAt:null,staleAfterMs:60000}])}];
  const frame={...blank,live:false};
  const pending=new PeriodAccounting(evidence,null).project(frame,{from:0,to:40000});
  assert.equal(pending.series[0].remainingAtEnd,80);assert.equal(pending.series[0].work,null,'measurement-only replies cannot create a work date');
  const refs=[{ref:'one',source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:null,folder:null,startedAt:0}];
  const accounting=new PeriodAccounting(evidence,{anchor:0,cut:60000,knownFrom:0,refs,spans:[[0,20000,30000]]});
  const before=accounting.project(frame,{from:0,to:15000}).series[0].work!;
  assert.equal(before.from,20000);assert.equal(before.ms,null,'work before sharing remains unknown');
  const after=accounting.project(frame,{from:0,to:40000}).series[0].work!;
  assert.equal(after.from,20000);assert.equal(after.ms,10000);
});

test('fixed summaries preserve exact totals, native credit precision and boundary geometry',()=>{
  const evidence=tape(),range={from:123,to:49_999};
  evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10.125,resetAt:null,staleAfterMs:60_000},{at:25_000,used:22.375,resetAt:null,staleAfterMs:60_000}])}];
  evidence.money=[{source:'s',meter:'balance:credits',accounting:{spending:'unavailable',topups:'unavailable'},readings:[{id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'2500000000001',scale:12,limit:null,at:0,previousAt:null,staleAfterMs:60_000,resetAt:null,minutes:null,scope:null,label:null}],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const trace:WorkTrace={anchor:0,cut:60_000,knownFrom:0,refs:[{ref:'r',source:'s',device:{id:'d',name:'D'},origin:'terminal',project:null,folder:null,startedAt:0}],spans:[[0,0,5000],[0,25_000,55_000]]};
  const frame:History={...blank,live:false,cellMs:15_000,meterSeries:[{sourceId:'s',meterId:'balance:credits',kind:'balance',unit:'credits:codex',start:null,end:null,semantics:null,spent:null,topup:null,coveredMs:0,unlocated:[],topupUnlocated:[],points:[]}]};
  frame.series=[{sourceId:'s',windowId:'w',consumed:0,coveredMs:0,remainingAtStart:null,remainingAtEnd:null,staleAfterMs:60000,work:null,points:[[15000,77.625,2,30000]]}];
  const full=new PeriodAccounting(evidence,trace),summary=fixedTape(evidence,trace,range,frame.cellMs,()=>{}),compact=new PeriodAccounting(summary,null).project(frame,range),expected=full.project(frame,range);
  assert.deepEqual(summary.fixed!.quota[0].points,[[123,89.875,1,15000],[45000,77.625,2,49999]],'only boundary geometry travels beside cached interior cells');
  assert.deepEqual(compact.series,expected.series);assert.equal(compact.meterSeries![0].end,'2500000000001');assert.equal(compact.meterSeries![0].endScale,12);assert.equal(compact.meterSeries![0].points[0].semantics!.scale,12);
  assert.deepEqual(compact.meterSeries![0].points,expected.meterSeries![0].points);assert.equal(compact.meterSeries![0].spent,null);assert.deepEqual(summary.quota,[]);assert.deepEqual(summary.money,[]);
  const work=fixedWork(trace,range,frame.cellMs,60_000,()=>{});assert.deepEqual(workedSessions(work,range,60_000),workedSessions(trace,range,60_000));
  const index=new PeriodIndex(work);assert.deepEqual(index.advance(range,60_000).rows,workedSessions(trace,range,60_000));assert.equal(index.advance({from:0,to:50_000},60_000).limited,true);
  const activity=new PeriodActivity(work).project({...blank.activity,barMs:frame.cellMs,cells:[[0,5000,5000,1],[15000,5000,5000,1],[30000,15000,15000,1],[45000,10000,10000,1]]},range);
  assert.equal(activity.agentMs,29_876);assert.equal(activity.activeMs,29_876);assert.equal(activity.agents,1);assert.equal(activity.cells.reduce((n,c)=>n+c[2],0),29876);
});

test('fixed reuse preserves exact totals across recorded evidence and cell boundaries',()=>{
  const evidence=tape(),range={from:123,to:49_123},cell=15_000;
  evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10.125,resetAt:55_000,staleAfterMs:60_000},{at:25_000,used:22.375,resetAt:55_000,staleAfterMs:60_000}])}];
  evidence.money=[{source:'s',meter:'credits',accounting:{spending:'counter',topups:'unavailable'},readings:[0,25_000,55_000].map((at,i)=>({id:'credits',kind:'counter' as const,unit:'credits:codex',amount:String(9007199254740993n+BigInt(i)),scale:12,limit:null,at,previousAt:i?at-25_000:null,staleAfterMs:60_000,resetAt:null,minutes:null,scope:null,label:null})),spans:[{from:0,to:60_000,staleAfterMs:60_000}]}];
  const trace:WorkTrace={anchor:0,cut:60_000,knownFrom:0,refs:[{ref:'r',source:'s',device:{id:'d',name:'D'},origin:'terminal',project:null,folder:null,startedAt:0}],spans:[[0,0,5000],[0,25_000,55_000]]};
  const compact=fixedTape(evidence,trace,range,cell,()=>{}).fixed!,work=fixedWork(trace,range,cell,60_000,()=>{}).fixed!;
  assert.ok(compact.shift);assert.ok(work.shift);
  const withoutProof=<T extends {shift?:unknown}>(value:T)=>{const {shift:_,...summary}=value;return summary;};
  for(const offset of [-123,-1,1,17,1023,5000,5877,5878,6000,10876,10877]){
    const next={from:range.from+offset,to:range.to+offset};
    assert.deepEqual(withoutProof(shifted(compact,next)!),withoutProof(fixedTape(evidence,trace,next,cell,()=>{}).fixed!));
    const moved=shifted(work,next)!;
    assert.deepEqual(withoutProof(moved),withoutProof(fixedWork(trace,next,cell,60_000,()=>{}).fixed!));
    assert.deepEqual(workedSessions({...trace,spans:[],fixed:moved},next,60_000),workedSessions(trace,next,60_000));
  }
  for(const fixed of [compact,work])for(const offset of [-124,10878])assert.equal(shifted(fixed,{from:range.from+offset,to:range.to+offset}),null);
});
