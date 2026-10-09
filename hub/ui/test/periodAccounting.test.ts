import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../lib/periodAccounting.js';
import {PeriodActivity} from '../lib/periodActivity.js';
import {PeriodIndex} from '../lib/periodIndex.js';
import type {PeriodTape} from '../../server/domain/periodTape.js';
import type {History} from '../lib/types.js';
import type {Reading} from '../../server/domain/meters.js';

const blank:History={range:'1h',live:true,since:0,to:60_000,cellMs:60_000,historyStart:0,events:[],series:[],activity:{since:0,known:{from:0,to:60_000},barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
const tape=():PeriodTape=>({from:0,cut:60_000,replaceFrom:0,cursor:'cursor',quota:[],money:[]});
test('exact endpoints exclude later samples of the same cell and stop validity at reset',()=>{
  const evidence=tape();evidence.quota=[{source:'s',window:'w',samples:[{at:0,used:10,resetAt:50_000,staleAfterMs:60_000},{at:20_000,used:25,resetAt:50_000,staleAfterMs:60_000},{at:40_000,used:90,resetAt:50_000,staleAfterMs:60_000}]}];
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
  evidence.quota=[{source:'s',window:'gone',member:true,windowValue:{id:'gone',kind:'weekly',label:'Retained',minutes:10080},samples:[{at:0,used:10,resetAt:null,staleAfterMs:60_000},{at:40_000,used:90,resetAt:null,staleAfterMs:60_000}]}];
  const accounting=new PeriodAccounting(evidence,null),shown=accounting.project({...blank,live:false},{from:10_000,to:30_000});
  assert.equal(shown.series[0].windowValue?.label,'Retained');assert.equal(shown.series[0].remainingAtEnd,90);
  assert.deepEqual(shown.series[0].points,[[10_000,90,1,30_000]]);
});
