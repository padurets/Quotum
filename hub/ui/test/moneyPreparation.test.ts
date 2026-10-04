import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';
import {composeMeters,composeMetersPrepared,type MeterSeriesCells} from '../../server/domain/meterHistory';
import {drain} from '../lib/prepare';
import {moneyIdentity} from '../lib/moneyView';

test('the actual spending generator keeps visible quantities invariant under overscan and boundary steps',()=>{
  const source=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8'),start=source.indexOf('  const prepared=usePrepared('),region=source.slice(start,source.indexOf('  const model=prepared.value',start));
  const cells:MeterSeriesCells={source:'s',meter:'balance',kind:'balance',unit:'USD',semantics:null,cells:[0,1,2,3].map(i=>[i,'10000000','1000000','0',60000])};
  for(const crossing of [false,true]) {
    const raw=crossing?{...cells,cells:[[1,'10000000','0','1000000',60000,{steps:[{from:10000,to:60001,amount:'1000000',evidence:'continuous'}]}]] as MeterSeriesCells['cells']}:cells;
    const chunks=[{from:0,meterSeries:[raw]}],original=composeMeters(chunks,60000,60000,180000);
    const draw=(strip:unknown)=>{
      const context={strip,original,history:{meterSeries:original},unit:'USD',prefs:{money:{view:'spending'},muted:{}},sources:[{id:'s',title:'Fixture',provider:'openrouter'}],arrange:{view:{}},locale:'en',board:'b',moneyIdentity,composeMetersPrepared,colorOf:()=> '#fff',nameOf:()=> 'Fixture',usePrepared:(work:()=>Generator<void,unknown,void>)=>({value:drain(work()),ready:true}),model:null as unknown as {entries:typeof original}};
      runInNewContext(ts.transpileModule(region+'\nglobalThis.model=prepared.value;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
      return JSON.stringify(context.model.entries[0].points.filter(p=>p.at>=60000&&p.at<180000).map(p=>[p.at,p.value]));
    };
    assert.equal(draw({meterChunks:chunks,cell:60000,from:0,to:240000,meterFrame:{from:60000,to:180000}}),draw(null));
    if(crossing)assert.equal(original[0].spent,'0');else assert.equal(original[0].spent,'2000000');
  }
});

test('the actual prepared money chart keeps its value axis, step geometry and exact last amount',()=>{
  const hook=preparationFixture();let exactReads=0;
  const valueAxis={min:-5,max:15,rawValue:()=>{exactReads++;return '10000000';}};
  const context={...hook,axis:{active:false,basis:{from:0,to:120000,end:60000}},incomingLines:[{key:'money',points:[[0,0,1],[60000,10,1]]}],
    incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredFrom:0,desiredTo:120000,desiredNow:60000,
    desiredLive:true,incomingReady:true,modelContext:'money',navigation:undefined,valueAxis,stepped:true,
    cellMs:60000,width:900,height:220,left:40,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,
    draw:null as unknown as ()=>{value:{valueAxis:typeof valueAxis;paths:{line:string;latest:string}[]}|null;ready:boolean}};
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8'),start=source.indexOf('  const inputs = ');
  const region=source.slice(start,source.indexOf('  const model = ',start));
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  hook.begin();context.draw();hook.commit();hook.finish();hook.begin();const model=context.draw().value!;
  assert.equal(model.valueAxis,valueAxis);assert.equal(model.paths[0].line,'M252.0,147.0H464.0V57.0');
  assert.equal(model.paths[0].latest,'60000:10000000');assert.equal(exactReads,1);
  context.valueAxis={min:0,max:20,rawValue:()=> '3000000'};
  context.incomingLines=[{key:'money',points:[[0,0,1],[60000,3,1]]}];
  hook.begin();const pending=context.draw();
  assert.equal(pending.value,model,'the same account and unit retain their drawing during a display-mode change');
  assert.equal(pending.ready,false);hook.commit();hook.finish();hook.begin();
  const next=context.draw().value!;assert.equal(next.valueAxis,context.valueAxis);assert.equal(next.paths[0].latest,'60000:3000000');
});
