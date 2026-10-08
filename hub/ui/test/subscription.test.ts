import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quotaPeriods,quotaRemaining,subscriptionSelection,subscriptionOverflow,subscriptionLinesOf,subscriptionPlotLinesPrepared} from '../lib/subscription';
import {readMoney,moneySelection} from '../lib/moneySelection';
import {readout} from '../lib/readout';
import {lineRegistry} from '../lib/plotRegistry';
import {drain} from '../lib/prepare';
import {plotOf} from '../lib/historyPlot';
import {meterCells,type MeterHistory} from '../../server/domain/meterHistory';
import {EMPTY_VIEW} from '../../server/domain/view';
import {QUOTA_IDS,type Meter} from '../../server/domain/meters';
import type {Card,History,HistorySeries,Win} from '../lib/types';
import {targetOf,type Chunk} from '../../server/domain/history';
import {setLocale} from '../i18n';

const M=60_000;
const meter=(id:string,limit='2000000000',amount='800000000'):Meter=>({id,kind:'cap',unit:'credits:zai',amount,limit,at:0,resetAt:3*M,scope:'five_hour',minutes:300,label:null,stale:false,staleAfterMs:10*M});
const five=meter(QUOTA_IDS[0]),week={...meter(QUOTA_IDS[1],'10000000000','2000000000'),scope:'week' as const,minutes:10080};
const zai:Card&{title:string}={id:'zai:fixture',title:'Personal',provider:'zai',plan:'lite',windows:[],meters:[five,week],resets:null,owners:[],error:null,successAt:0,stale:false,staleAfterMs:10*M,measureIntervalMs:null};
const windows:Win[]=[{id:'session',kind:'session',label:null,used:30,remaining:70,resetAt:5*M,minutes:300},{id:'weekly',kind:'weekly',label:null,used:10,remaining:90,resetAt:5*M,minutes:10080}];
const native:Card={...zai,id:'codex:fixture',provider:'codex',meters:undefined,windows};
const nativeSeries=(windowId:string):HistorySeries=>({sourceId:native.id,windowId,consumed:2,coveredMs:M,remainingAtStart:72,remainingAtEnd:70,points:[[0,72,1],[M,70,1]],staleAfterMs:10*M,work:null});
const capSeries=(id:string,value='1200000000',limit='2000000000'):MeterHistory=>({sourceId:zai.id,meterId:id,kind:'cap',unit:'credits:zai',semantics:null,start:value,end:value,spent:'0',topup:'0',unlocated:[],topupUnlocated:[],coveredMs:0,
  points:[{at:0,value,spent:'0',segment:1,semantics:{limit,resetAt:3*M,scope:'five_hour',minutes:300,label:null},steps:[],knownFrom:0,knownUntil:M}]});
const history:History={range:'24h',live:true,since:0,to:M,cellMs:M,historyStart:0,series:windows.map(w=>nativeSeries(w.id)),meterSeries:[capSeries(QUOTA_IDS[0]),capSeries(QUOTA_IDS[1],'8000000000','10000000000')],events:[],activity:{since:0,known:null,barMs:M,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};

test('native and hub subscriptions share period, source order, colours and percentage line identities',()=>{
  try {
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      for(const [kind,id,remaining] of [['session',QUOTA_IDS[0],60],['weekly',QUOTA_IDS[1],80]] as const) {
        const view={...EMPTY_VIEW,colors:{[zai.id]:'#123456'}};
        const lines=subscriptionLinesOf(history,[zai,native],view,kind);
        assert.deepEqual(lines.map(l=>l.sourceId),[zai.id,native.id]);
        const cap=lines[0];assert.equal(cap.windowId,id);assert.equal(cap.current,remaining);assert.equal(cap.color,'#123456');
        assert.equal(cap.kind,kind);assert.equal(cap.key,`${zai.id}/${id}`);assert.equal(cap.name,'Personal');
        assert.equal(cap.work,null);assert.equal(lines[1].consumed,2,'native quota accounting is preserved');
        assert.equal(lines[1].current,kind==='session'?70:90);
      }
    }
  }finally{setLocale('en');}
  assert.deepEqual(quotaPeriods(zai).map(w=>[w.id,w.kind,w.minutes]),[[QUOTA_IDS[0],'session',300],[QUOTA_IDS[1],'weekly',10080]]);
  assert.equal(quotaPeriods(native),native.windows);
});

test('historical caps use their own exact allowance through changes and keep exclusive gaps',()=>{
  const first=capSeries(QUOTA_IDS[0]),second={...first.points[0],at:2*M,knownFrom:2*M+1000,knownUntil:3*M,value:'1200000000',semantics:{...first.points[0].semantics!,limit:'4000000000'},segment:2};
  const data={...history,to:3*M,meterSeries:[{...first,points:[...first.points,second]}]};
  const line=subscriptionLinesOf(data,[zai],EMPTY_VIEW,'session')[0];
  assert.deepEqual(line.points,[[0,60,1],[2*M,30,2]]);assert.equal(line.current,60,'today\'s allowance does not rewrite history');
  assert.equal(line.remainingAtStart,60);assert.equal(line.remainingAtEnd,30);
  for(const at of [M,2*M,2*M+999,3*M])assert.equal(readout([line],[],Math.floor(at/M)*M,M,3*M,3*M,[],undefined,at).rows[0].value,null);
  assert.equal(readout([line],[],2*M,M,3*M,3*M,[],undefined,2*M+1000).rows[0].value,30);
  const gap=subscriptionLinesOf({...data,since:M,to:2*M},[zai],EMPTY_VIEW,'session')[0];
  assert.equal(gap.remainingAtStart,null);assert.equal(gap.remainingAtEnd,null);
  const cleared=lineRegistry([line],[line],[])[0];assert.deepEqual(cleared.capCells,[],'an unread replacement strip cannot retain old cap cells');
});

test('unknown or zero allowances never become a synthetic zero or full quota',()=>{
  for(const limit of [null,'0']) {
    const source={...zai,meters:[{...five,limit}]};
    assert.equal(quotaRemaining(source,five.id),null);
    const invalid=capSeries(five.id);invalid.points[0].semantics!.limit=limit;
    assert.deepEqual(subscriptionLinesOf({...history,meterSeries:[invalid]},[source],EMPTY_VIEW,'session'),[]);
  }
  const absent={...zai,meters:[]};assert.equal(quotaRemaining(absent,five.id),null);
  assert.equal(subscriptionLinesOf(history,[absent],EMPTY_VIEW,'session')[0].current,null,'valid history remains available when current quota is unknown');
  const huge='9007199254740993000000000000';
  const series=capSeries(five.id,(BigInt(huge)*3n/5n).toString(),huge);
  assert.equal(subscriptionLinesOf({...history,meterSeries:[series]},[zai],EMPTY_VIEW,'session')[0].points[0][1],60);
  const over=capSeries(five.id,'-1');assert.equal(subscriptionLinesOf({...history,meterSeries:[over]},[zai],EMPTY_VIEW,'session')[0].points[0][1],0);
});

test('common period visibility selects both quotas by default and uses no money preference',()=>{
  assert.equal(subscriptionSelection([native],EMPTY_VIEW),undefined);
  assert.deepEqual(subscriptionSelection([zai,native],EMPTY_VIEW)?.ids,QUOTA_IDS.map(id=>[zai.id,id]));
  const view={...EMPTY_VIEW,windows:[`${zai.id}/${five.id}`]};
  assert.deepEqual(subscriptionSelection([zai],view)?.ids,[[zai.id,week.id]]);
  assert.deepEqual(subscriptionLinesOf(history,[zai],view,'session'),[]);
  assert.equal(subscriptionSelection([zai],{...EMPTY_VIEW,windows:QUOTA_IDS.map(id=>`${zai.id}/${id}`)}),undefined,'hiding all cap periods preserves ordinary native history');
  assert.equal(subscriptionLinesOf(history,[zai],view,'weekly').length,1);
  const hidden={...EMPTY_VIEW,hidden:[`source:${zai.id}`]};
  assert.equal(subscriptionSelection([zai],hidden),undefined);assert.deepEqual(subscriptionLinesOf(history,[zai],hidden,'weekly'),[]);
  const saved=readMoney({unit:'credits:zai',selected:{'credits:zai':[[zai.id,five.id]],USD:[['wallet','balance']]}});
  assert.equal(saved.unit,'USD');assert.deepEqual(saved.selected,{USD:[['wallet','balance']]});
  assert.deepEqual(moneySelection([zai],[],{...saved,unit:'USD'}).selection?.ids,[]);
  const many=Array.from({length:17},(_,i)=>({...zai,id:`zai:${i}`}));
  assert.equal(subscriptionSelection(many,EMPTY_VIEW)?.ids.length,32);assert.equal(subscriptionOverflow(many,EMPTY_VIEW),2);
  assert.equal(subscriptionOverflow(many,{...EMPTY_VIEW,hidden:['source:zai:0']}),0);
});

test('the progressive subscription plot projects raw cap tiles through the same percentage model',()=>{
  const readings=[{...five,previousAt:null},{...five,at:M,amount:'1000000000',previousAt:0}];
  const chunk:Chunk={from:0,to:3*M,series:[],meterSeries:meterCells({source:zai.id,meter:five.id,readings,spans:[{from:0,to:2*M,staleAfterMs:10*M,holdUntil:3*M}]},five.unit,0,3*M,M),activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[]};
  const strip=plotOf([chunk],{now:3*M,historyStart:0,known:{work:0,sources:{[zai.id]:0}}},targetOf(3*M,3*M,'caps',{from:0,to:3*M}),[[0,3*M]],new Set(),1,1,1);
  const lines=drain(subscriptionPlotLinesPrepared(strip,[zai],EMPTY_VIEW,'session'));
  assert.equal(lines.length,1);assert.equal(lines[0].key,`${zai.id}/${five.id}`);
  assert.deepEqual(lines[0].points.map(p=>p[1]),[60,50,50]);
  assert.ok(lines[0].capCells?.every(cell=>cell.to<=3*M));
});
