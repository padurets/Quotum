import {seriesName} from '../lib/quota';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crossingAt,forecastComparator,nextForecastSort,readForecastSort,sortValue,visibleForecastSort,SORT_COLUMNS,type ForecastSort,type SortRow} from '../lib/forecastSort';
import type {Line} from '../lib/lines';
import {PeriodAccounting} from '../lib/periodAccounting';
import {packSamples,type PeriodTape} from '../../server/domain/periodTape';
import type {WorkTrace} from '../../server/domain/periodWork';
const H=3_600_000;
const row=(name:string,current:number|null,changes:Partial<Line>={}):SortRow=>({line:{sourceId:name,windowId:'w',key:name,provider:'codex',kind:'weekly',label:null,minutes:10080,name,color:'blue',dash:'',current,points:[[0,current??0,1]],remainingAtStart:current,remainingAtEnd:current,consumed:0,coveredMs:H,staleAfterMs:H,work:null,...changes},live:current===null?undefined:{id:'w',kind:'weekly',label:null,minutes:10080,resetAt:10*H,remaining:current,used:100-current},measuredAt:3*H,ahead:null,plan:null,context:{windows:[],freeResets:0,announced:null}});
const sorted=(rows:SortRow[],sort:ForecastSort=null,fixed=false,now=3*H)=>rows.map(r=>sortValue(r,r.line,now,fixed)).sort(forecastComparator(sort,fixed,'en')).map(v=>v.row.line.name);
test('reader preference parsing, cycling and hidden-column recovery',()=>{
  assert.deepEqual(readForecastSort({column:'limit',descending:true}),{column:'name',descending:true},'the previous name-column preference survives the shared table contract');
  for(const bad of [null,{},[],{column:'money',descending:false},{column:'spent',descending:'false'}])assert.equal(readForecastSort(bad),null);
  const up=nextForecastSort(null,'spent'),down=nextForecastSort(up,'spent');assert.deepEqual(up,{column:'spent',descending:false});assert.deepEqual(down,{column:'spent',descending:true});assert.equal(nextForecastSort(down,'spent'),null);
  assert.equal(visibleForecastSort(down,['now']),null);assert.equal(visibleForecastSort(down,['spent']),down);
});
test('live importance, missed resets, caps and fixed spending use distinct evidence',()=>{
  const near=row('near',70),far=row('far',40),depleted=row('depleted',0),unknown=row('unknown',null),five=row('five',5),twenty=row('twenty',20),cap=row('cap',0,{capCells:[]});
  const ahead=(at:number)=>({state:'runsOut' as const,asOf:3*H,resetAt:10*H,anchor:null,F:-5,zero:at,shownZero:at,shownLeft:null,comfy:false,points:null,basis:null});near.ahead=ahead(4*H);far.ahead=ahead(8*H);
  const rows=[unknown,twenty,far,five,near,depleted,cap];assert.deepEqual(sorted(rows),['cap','depleted','near','far','five','twenty','unknown']);
  assert.deepEqual(sorted(rows,null,false,5*H),['cap','depleted','near','far','five','twenty','unknown'],'pastZero is a prediction, never actual depletion');
  assert.deepEqual(sorted([depleted,five],null,false,10*H),['depleted','five']);assert.equal(sortValue(depleted,depleted.line,10*H,false).current,null);
  const spent=[row('12',80,{consumed:12}),row('zero',50),row('30',20,{consumed:30}),row('unknown',null,{coveredMs:0}),cap];
  assert.deepEqual(sorted(spent,null,true),['30','12','zero','cap','unknown']);
});
test('unknowns stay last in both directions and numeric names and ties remain stable',()=>{
  const rows=[row('Series 10',10),row('Unknown',null),row('Series 2',20)];
  assert.deepEqual(sorted(rows,{column:'name',descending:false}),['Series 2','Series 10','Unknown']);
  for(const descending of [false,true])assert.equal(sorted(rows,{column:'now',descending}).at(-1),'Unknown');
  const bounded=row('bounded',10,{work:{from:0,ms:H,agentMs:H,coveredMs:H,consumed:1,duringWork:1}}),numeric=row('numeric',10,{work:{from:0,ms:H,agentMs:H,coveredMs:H,consumed:10,duringWork:10}});
  for(const descending of [false,true])assert.deepEqual(sorted([bounded,numeric],{column:'workleft',descending}),['numeric','bounded']);
});
test('rolling union and agent-hour slopes use retained accounting and equality/inversion edges',()=>{
  const refs=['a','parallel','b'].map((ref,i)=>({ref,source:i<2?'A':'B',device:{id:'d',name:'Device'},origin:'terminal' as const,project:null,folder:null,startedAt:0}));
  const work:WorkTrace={anchor:0,knownFrom:0,cut:2*H,refs,spans:[[0,0,160_000],[1,0,100_000],[2,300_000,455_000]]};
  const tape:PeriodTape={from:0,cut:2*H,replaceFrom:0,cursor:'c',money:[],quota:['A','B'].map(source=>({source,window:'w',samples:packSamples([{at:0,used:1,resetAt:4*H,staleAfterMs:4*H},{at:H,used:2,resetAt:4*H,staleAfterMs:4*H}])}))};
  const accounting=new PeriodAccounting(tape,work),now=H;
  const linear=(active:boolean)=>['A','B'].map(source=>({value:accounting.quotaSummary(source,'w',{from:now-H,to:now})!.work![active?'ms':'agentMs']!,slope:accounting.quotaWorkSlope(source,'w',now,H,active)!.slope}));
  assert.deepEqual(linear(true),[{value:160_000,slope:-1},{value:155_000,slope:0}]);assert.deepEqual(linear(false),[{value:260_000,slope:-2},{value:155_000,slope:0}]);
  assert.equal(crossingAt(linear(true),now,now+160_000),now+5000);assert.equal(crossingAt([{value:155_000,slope:-1},{value:155_000,slope:0}],now+5000,now+160_000),now+5001);
  assert.equal(crossingAt(linear(false),now,now+100_000),now+52_500);
  assert.equal(crossingAt([{value:1,slope:1},{value:2,slope:0},{value:3,slope:-1}],0,100),1,'adjacent equality catches intermediate permutations');
});

test('sorting reads only needed work while preserving selected keys, fallback order and forecast deadlines',()=>{
  const work={from:0,ms:H,agentMs:2*H,coveredMs:H,consumed:10,duringWork:8};
  const rows=[row('A',20,{work}),row('B',10,{work:{...work,consumed:0.01}}),row('Series 2',50),row('Series 10',0),row('Unknown',null),row('Cap',0,{capCells:[]})];
  rows[0].line.name='Same';rows[1].line.name='same';rows[5].validUntil=4*H;
  for(const fixed of [false,true])for(const locale of ['en','ru'])for(const now of [3*H,4*H,10*H])for(const selection of [null,...SORT_COLUMNS.flatMap(column=>[false,true].map(descending=>({column,descending})))]){
    const compare=forecastComparator(selection,fixed,locale),full=rows.map(r=>sortValue(r,r.line,now,fixed)),selected=rows.map(r=>sortValue(r,r.line,now,fixed,selection?.column??'name'));
    selected.forEach((value,i)=>{
      assert.equal(value.current,full[i].current);assert.deepEqual(value.said,full[i].said);
      if(fixed)assert.equal(value.spent,full[i].spent,'fixed spending still breaks equal primary keys');
      if(selection&&selection.column!=='name')assert.deepEqual(value.keys[selection.column],full[i].keys[selection.column]);
    });
    assert.deepEqual(selected.sort(compare).map(v=>v.row.line.key),full.sort(compare).map(v=>v.row.line.key));
  }
  const tracked=row('Tracked',20,{work});let reads=0;
  Object.defineProperty(tracked.line,'work',{get:()=>{reads++;return work;}});
  sortValue(tracked,tracked.line,3*H,false);assert.ok(reads>0,'the full-key control reaches the work model');
  reads=0;sortValue(tracked,tracked.line,3*H,false,'name');assert.equal(reads,0,'default and name order need no work keys');
  sortValue(tracked,tracked.line,3*H,false,'workleft');assert.ok(reads>0,'work ordering still reads its full numeric or bounded key');
});


test('canonical scoped names remain distinct and sort naturally with stable identity ties in EN/RU',()=>{
  for(const locale of ['en','ru']){
    const second=row('second',10),tenth=row('tenth',10),tie=row('tie',10);
    second.line.name=seriesName({provider:'claude',title:'Account · literal'},{kind:'weekly',label:'Gemini 2',minutes:10080});
    tenth.line.name=seriesName({provider:'claude',title:'Account · literal'},{kind:'weekly',label:'Gemini 10',minutes:10080});
    tie.line.name=second.line.name;second.line.key='identity-a';tie.line.key='identity-b';tenth.line.key='identity-c';
    const values=[tenth,tie,second].map(r=>sortValue(r,r.line,3*H,false));
    assert.deepEqual([...values].sort(forecastComparator({column:'name',descending:false},false,locale)).map(v=>v.row.line.key),['identity-a','identity-b','identity-c']);
    assert.deepEqual([...values].sort(forecastComparator({column:'name',descending:true},false,locale)).map(v=>v.row.line.key),['identity-c','identity-a','identity-b']);
  }
});
