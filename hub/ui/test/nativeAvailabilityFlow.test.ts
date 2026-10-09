import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {cellsOf, type CellSamples} from '../../server/domain/cells';
import {compose, type Chunk, type Target} from '../../server/domain/history';
import {HistoryTile} from '../lib/historyTiles';
import {plotOf} from '../lib/historyPlot';
import * as lineContract from '../lib/lines';
import type {PlotSeries} from '../lib/lines';
import {readout} from '../lib/readout';
import {drain} from '../lib/prepare';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';

const known = {work:0,sources:{s:0}}, cell = 60_000, to = 900_000;
const sample = (at:number, used:number, staleAfterMs:number, validUntil?:number) =>
  ({at,used,resetAt:3_600_000,staleAfterMs,...(validUntil === undefined ? {} : {validUntil})});

/** Both production consumers read the same COW tile, with no invented sample anchors. */
function views(samples:CellSamples['samples']) {
  const original = structuredClone(samples);
  const chunks = cellsOf([{source:'s',window:'w',samples}],[],{},cell,0,to,known);
  const restored = chunks.map(chunk => {
    const input:Chunk = {...chunk,activity:{...chunk.activity,sessions:[]}};
    const tile = new HistoryTile(chunk.from,cell); tile.readTo=chunk.to;
    const staged = drain(tile.staged(input,known));
    return {normal:staged.chunk(known),plot:staged.chunk(known,true)};
  });
  assert.deepEqual(samples,original,'aggregation preserves the original timestamps, TTLs and unavailable evidence');
  const target:Target = {cell,k0:0,k1:to/cell-1,length:to,live:false,key:'availability',now:to};
  const normal = compose(restored.map(row=>row.normal),{known,now:to,historyStart:0},target,new Set(['s w']));
  const plot = plotOf(restored.map(row=>row.plot),{known,now:to,historyStart:0},target,[[0,to]],new Set(['s w']),0,0,0);
  return [normal.series[0],plot.series[0]];
}

const chart = readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
const axis = readFileSync(new URL('../components/timeAxis.ts',import.meta.url),'utf8');
const javascript = (source:string) => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const axisCall = javascript(chart.slice(chart.indexOf('  const axis = useTimeAxis('),chart.indexOf('\n',chart.indexOf('  const axis = useTimeAxis('))));
const pointerCode = javascript(axis.slice(axis.indexOf('  const timeAt = '),axis.indexOf('  const onPointerDown = '))+'\nglobalThis.move=onPointerMove;');
const circles = chart.split('\n').find(line=>line.includes('{rows.map(row => row.value !== null && <circle'))!.trim().slice(1,-1);
const readoutCode = javascript('function draw(){'+chart.slice(chart.indexOf('  const model = '),chart.indexOf('  const columnCount = '))+
  chart.slice(chart.indexOf('  const observationHover='),chart.indexOf('  const narrow = '))+
  `\nconst circles=${circles};\nreturn {value:rows[0]?.value??null,pointedAt,hoverX,rowAt:rowTime(lines[0]),circles};}\nglobalThis.draw=draw;`);
const drawingCode = javascript('function draw(){'+chart.slice(chart.indexOf('  const inputs = '),chart.indexOf('  const model = '))+
  '\nreturn prepared;}\nglobalThis.draw=draw;');

/** Exercise Chart's precision choice, the real pointer handler, and its actual readout wiring. */
function pointed(line:PlotSeries, at:number) {
  let precise = false, hover:number|null = null;
  runInNewContext(axisCall,{...lineContract,useTimeAxis:(input:{precise:boolean})=>{precise=input.precise;return {};},
    desiredFrom:0,desiredTo:to,desiredNow:to,cellMs:cell,left:0,right:0,onSelect:undefined,incomingReady:true,incomingLines:[line],navigation:undefined});
  const pointer = {from:0,to,width:to,left:0,right:0,cellMs:cell,precise,visualGeometry:()=>({from:0,to}),
    setHover:(value:number|null)=>{hover=value;},useEffect:()=>{},pointer:{current:null},panPointer:{current:null},
    svg:{current:{getBoundingClientRect:()=>({left:0,width:to})}},panning:null,folding:false,shifting:false,drag:null,holding:{current:null},
    move:null as unknown as (event:{clientX:number;pointerId:number;pointerType:string})=>void};
  runInNewContext(pointerCode,pointer);
  pointer.move({clientX:at,pointerId:1,pointerType:'mouse'});
  const context = {React,...lineContract,prepared:{ready:true,value:{basis:{from:0,to},lines:[{...line,key:'s w'}],plans:[],forecasts:[],markers:[],paths:[],strip:null}},
    valueAxis:undefined,currentClock:to,desiredFrom:0,desiredNow:to,desiredTo:to,desiredLive:true,incomingReady:true,cellMs:cell,
    width:to,left:0,right:0,height:220,top:12,bottom:28,
    axis:{hover:hover===null?null:Math.floor(hover/cell)*cell,hoverAt:hover,screenX:(time:number)=>time,commitDrawing:()=>{}},
    useLayoutEffect:()=>{},niceTicks:()=>({ticks:[],daily:false}),readCell:readout,
    draw:null as unknown as ()=>{value:number|null;pointedAt:number;hoverX:number;rowAt:number;circles:(false|React.ReactElement<{cx:number}>)[]}};
  runInNewContext(readoutCode,context);
  const {circles,rowAt,...result} = context.draw();
  for(const circle of circles)if(circle)assert.equal(circle.props.cx,result.hoverX,'the value marker follows the crosshair');
  assert.equal(rowAt,result.pointedAt,'details and formatting receive the same time as the pointer');
  return {...result,precise};
}

function drawn(line:PlotSeries) {
  const hooks = preparationFixture();
  const context = {...hooks,axis:{active:false,basis:{from:0,to,end:to}},incomingStrip:line.blocks?{from:0,to}:null,
    desiredFrom:0,desiredTo:to,desiredNow:to,incomingLines:[line],valueAxis:undefined,stepped:false,modelContext:'',navigation:undefined,
    desiredLive:false,incomingReady:true,incomingPlans:[],incomingForecasts:[],incomingMarkers:[],
    cellMs:cell,width:to,height:100,left:0,right:0,top:0,bottom:0,clipPrepared,plotPathPrepared,NO_FORECASTS:[],
    draw:null as unknown as ()=>{value:{paths:{line:string;parts:{line:string}[]|null}[]}|null}};
  runInNewContext(drawingCode,context);
  hooks.begin();context.draw();hooks.commit();hooks.finish();hooks.begin();
  const path = context.draw().value!.paths[0];
  return path.parts?.map(part=>part.line).join('')??path.line;
}

test('native unavailable deadlines reach the actual pointer and tooltip through both tile projections',()=>{
  for(const line of views([sample(5_000,65,204_000,30_000),sample(120_000,71,204_000)])) {
    assert.equal(line.points[0][3],30_000);
    for(const [at,value] of [[29_999,35],[30_000,null],[45_000,null]] as const) {
      assert.deepEqual(pointed(line,at),{value,pointedAt:at,hoverX:at,precise:true});
    }
  }
});

test('bounded native readout keeps the original sample deadline when a later cadence grows',()=>{
  for(const line of views([sample(5_000,65,204_000,600_000),sample(660_000,71,900_000)])) {
    assert.equal(line.staleAfterMs,900_000);
    assert.equal(line.points[0][3],209_001,'the original timestamp and inclusive TTL determine the exclusive deadline');
    for(const [at,value] of [[209_000,35],[209_001,null],[300_000,null]] as const)assert.equal(pointed(line,at).value,value);
  }
});

test('bounded native readout keeps its earlier freshness when a later cadence shrinks',()=>{
  for(const line of views([sample(5_000,65,900_000,600_000),sample(660_000,71,204_000)])) {
    assert.equal(line.staleAfterMs,204_000);
    assert.equal(line.points[0][3],600_000,'explicit unavailability still wins before the original TTL');
    for(const [at,value] of [[300_000,35],[599_999,35],[600_000,null]] as const)assert.equal(pointed(line,at).value,value);
  }
});

test('normal and strip geometry stop at the same own deadline across both cadence changes',()=>{
  for(const [firstTTL,lastTTL,unavailable,deadline] of [[10_000,900_000,50_000,15_001],[900_000,10_000,20_000,20_000]] as const) {
    for(const line of views([sample(5_000,65,firstTTL,unavailable),sample(120_000,71,lastTTL)])) {
      assert.equal(drawn(line),`M${deadline.toFixed(1)},65.0M150000.0,71.0`);
      assert.equal(pointed(line,deadline-1).value,35);
      assert.equal(pointed(line,deadline).value,null);
    }
  }
});

test('recovery cannot fill the unavailable beginning of the same, next or a later coarse cell',()=>{
  for(const [unavailable,recovery] of [[30_000,36_000],[90_000,96_000],[90_000,216_000]] as const) {
    for(const line of views([sample(0,65,900_000,unavailable),sample(recovery,71,900_000),sample(recovery+12_000,72,900_000)])) {
      const start=Math.floor(recovery/cell)*cell;
      assert.equal(line.points.find(point=>point[0]===start)?.[3],start,'the whole mixed cell stays unavailable, including later samples in it');
      assert.equal(pointed(line,recovery-3_000).value,null);
      assert.equal(pointed(line,recovery+15_000).value,null);
      assert.equal(drawn(line),start===0?'':'M30000.0,65.0','suppressed recovery has no geometry or connecting bridge');
    }
  }
});

test('recovery at an exact cell boundary remains visible without changing ordinary quota aggregation',()=>{
  for(const line of views([sample(0,65,900_000,90_000),sample(120_000,71,900_000)])) {
    assert.equal(line.points.find(point=>point[0]===120_000)?.[3],undefined);
    assert.equal(pointed(line,120_000).value,29);
  }
  for(const line of views([sample(0,65,30_000),sample(36_000,71,30_000)])) {
    assert.ok(line.points.every(point=>point[3]===undefined),'a natural TTL gap creates no explicit unavailable bound');
    assert.deepEqual(pointed(line,33_000),{value:29,pointedAt:0,hoverX:30_000,precise:false});
  }
});

test('the shared pointer keeps exact bounds for monetary observations and subscription caps',()=>{
  const base:PlotSeries = {sourceId:'s',windowId:'w',points:[[0,35,1,30_000]],staleAfterMs:900_000};
  for(const line of [{...base,pointMode:'observation' as const},{...base,points:[],capCells:[{at:0,from:5_000,to:30_000,value:35}]}]) {
    assert.equal(pointed(line,29_999).value,35);
    assert.equal(pointed(line,30_000).value,null);
  }
});

test('pointer precision scans immutable native points once and follows a replacement publication',()=>{
  const raw:PlotSeries['points'] = [[0,35,1],[60_000,29,1]];
  raw.forEach(Object.freeze);Object.freeze(raw);
  let scans = 0;
  const points = new Proxy(raw,{get(target,key,receiver){if(key==='some')scans++;return Reflect.get(target,key,receiver);}});
  for(let i=0;i<10;i++)assert.equal(lineContract.preciseReadout({points}),false);
  assert.equal(scans,1,'rerenders and tooltip rows share the same immutable publication');
  assert.equal(lineContract.preciseReadout({points:[[0,35,1,30_000]]}),true,'a new projection does not reuse the old exactness');
  assert.equal(lineContract.preciseReadout({points}),false);
  assert.equal(scans,1);
});
