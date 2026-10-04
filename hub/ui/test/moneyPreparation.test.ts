import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';

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
});
