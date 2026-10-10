import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {moneyIdentity,moneyPointAt,meterPointIn} from '../lib/moneyView';
import {observationRunsPrepared,plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';

test('a committed credit heartbeat retains its observation when the carried outline is unchanged',()=>{
  const cell=300000,now=cell+10000,key=JSON.stringify(['credit','balance:credits','balance','USD']);
  const series=(observedAt:number,observation=true)=>({sourceId:'credit',meterId:'balance:credits',kind:'balance',unit:'USD',pointMode:observation?'observation':undefined,
    points:[{at:cell,value:'99920000',validUntil:2*cell,semantics:{conversion:{original:{at:observedAt}}}}]});
  const moneySource=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8');
  const start=moneySource.indexOf('  const axis=useMemo('),region=moneySource.slice(start,moneySource.indexOf('  const answered=',start));
  type Axis={min:number;max:number;rawValue:(key:string,at:number)=>string|undefined;observedAt?:(key:string,at:number)=>number|undefined};
  const money={moneyIdentity,moneyPointAt,meterPointIn,useMemo:(work:()=>unknown)=>work(),t:()=>'',symbol:'$',unit:'USD',locale:'en',context:{},strip:null,history:{cellMs:cell},
    makeAxis:null as unknown as (entries:ReturnType<typeof series>[])=>Axis};
  const pointStart=moneySource.indexOf('const pointAt='),pointEnd=moneySource.indexOf('\n',pointStart);
  runInNewContext(ts.transpileModule(`${moneySource.slice(pointStart,pointEnd)}
    function makeAxis(entries){const model={origin:99920000n,span:1000000n,pad:100000n};${region}return axis;}
    globalThis.makeAxis=makeAxis;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,money);
  const firstAt=cell-7000,nextAt=cell-5000;
  const line=()=>({key,pointMode:'observation',points:[[cell,0,1,2*cell]]});
  const hook=preparationFixture();
  type Model={paths:{line:string;last:[number,number]|null;latest:string}[]};
  const chart={...hook,axis:{active:false,basis:{from:now-86400000,to:now,end:now}},incomingLines:[line()],incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,
    desiredFrom:now-86400000,desiredTo:now,desiredNow:now,desiredLive:true,incomingReady:true,modelContext:'funds',navigation:undefined,
    valueAxis:money.makeAxis([series(firstAt)]),stepped:true,cellMs:cell,width:900,height:220,left:76,right:12,top:12,bottom:28,
    clipPrepared,plotPathPrepared,observationRunsPrepared,draw:null as unknown as ()=>{value:Model|null;ready:boolean}};
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8'),chartStart=source.indexOf('  const inputs = ');
  const chartRegion=source.slice(chartStart,source.indexOf('  const model = ',chartStart));
  runInNewContext(ts.transpileModule(`function draw(){${chartRegion}\nreturn prepared;}globalThis.draw=draw;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,chart);
  const render=()=>{hook.begin();return chart.draw();};
  assert.equal(render().value,null);hook.commit();hook.finish();
  const before=render().value!;assert.equal(before.paths[0].latest,firstAt+':99920000');
  chart.incomingLines=[line()];chart.valueAxis=money.makeAxis([series(nextAt)]);
  assert.equal(render().value,before,'new data cannot claim a commit before preparation finishes');
  hook.commit();hook.finish();const after=render();assert.equal(after.ready,true);
  assert.equal(after.value!.paths[0].line,before.paths[0].line,'both heartbeats draw exactly the same outline');
  assert.deepEqual(after.value!.paths[0].last,before.paths[0].last);
  assert.equal(after.value!.paths[0].latest,nextAt+':99920000','the committed model identifies the new observation');
  assert.equal(money.makeAxis([series(nextAt,false)]).observedAt?.(key,cell),undefined,'aggregate cells retain their grid marker');
});
