import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {cellsOf} from '../../server/domain/cells';
import {compose, type Chunk, type Target} from '../../server/domain/history';
import {HistoryTile} from '../lib/historyTiles';
import {plotOf} from '../lib/historyPlot';
import {valueIn, type PlotBlock, type PlotSeries} from '../lib/lines';
import {readout} from '../lib/readout';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {drain} from '../lib/prepare';
import {preparationFixture} from './preparationFixture';

const known = {work:0,sources:{s:0}};
const samples = [
  {at:0,used:65,resetAt:3_600_000,staleAfterMs:204_000,validUntil:1000},
  {at:2000,used:71,resetAt:3_600_000,staleAfterMs:204_000},
  {at:3000,used:72,resetAt:3_600_000,staleAfterMs:204_000},
];

test('native availability bounds survive tile replacement, COW, compact reads and plot blocks', () => {
  for (const cell of [1000,10_000]) {
    const [input] = cellsOf([{source:'s',window:'w',samples}],[],{},cell,0,4*cell,known);
    const chunk: Chunk = {...input,activity:{...input.activity,sessions:[]}};
    const tile = new HistoryTile(0,cell); tile.readTo=4*cell;
    const plain = {...chunk,series:chunk.series.map(s=>({...s,cells:s.cells.map(([i,low,spent,covered,extra])=>[i,low,spent,covered,{...extra,u:undefined}] as typeof s.cells[number])}))};
    tile.merge(plain,known);
    const bytes = tile.bytes, alias = tile.chunk(known);
    const replacement = drain(tile.staged(chunk,known));
    assert.equal(replacement.bytes-bytes,60*8,'only the affected series allocates an availability buffer');
    assert.deepEqual(tile.chunk(known),alias,'published tile remains unchanged');
    for (const plot of [false,true]) {
      const restored = replacement.chunk(known,plot);
      assert.equal(restored.series[0].cells[0][4]?.u,cell===1000?1000:0);
      const target: Target = {cell,k0:0,k1:3,length:4*cell,live:false,key:'test',now:4*cell};
      const drawn = plotOf([restored],{known,now:4*cell,historyStart:0},target,[[0,4*cell]],new Set(['s w']),0,0,0).series[0];
      assert.equal(drawn.points[0][3],cell===1000?1000:0);
      assert.equal(drawn.blocks?.[0].block.points[0][4],cell===1000?1000:0);
      assert.equal(valueIn(drawn.points,1000,4*cell,204_000),undefined);
      if (!plot) {
        const history = compose([restored],{known,now:4*cell,historyStart:0},target,new Set(['s w']));
        assert.equal(history.series[0].consumed,1);
        assert.equal(history.series[0].coveredMs,1000);
        assert.equal(history.series[0].points[0][3],cell===1000?1000:0);
      }
    }
    const cleared = drain(replacement.staged({...chunk,series:[]},known));
    assert.equal(cleared.bytes,248+1024,'deleting a series releases its availability buffer too');
  }
});

test('native readout ends exclusively inside a cell while money observations retain their contract', () => {
  const points: PlotSeries['points'] = [[0,35,1,1000],[2000,29,2]];
  assert.equal(valueIn(points,999,4000,204_000),35);
  assert.equal(valueIn(points,1000,4000,204_000),undefined);
  assert.equal(valueIn(points,1999,4000,204_000),undefined);
  assert.equal(valueIn(points,2000,4000,204_000),29);
  assert.equal(valueIn([[0,35,1,0]],0,4000,204_000),undefined,'a conservative unavailable coarse cell has no readout');
  assert.equal(valueIn([[0,35,1,1000]],999,4000,204_000,undefined,'observation'),35);
  assert.equal(valueIn([[0,35,1,1000]],1000,4000,204_000,undefined,'observation'),undefined);
  assert.equal(valueIn([[0,35,1]],0,4000,204_000,undefined,'observation'),undefined);
  const line = {sourceId:'s',windowId:'w',key:'s w',points,staleAfterMs:204_000} as Parameters<typeof readout>[0][number];
  assert.equal(readout([line],[],0,2000,4000,4000,[],undefined,999).rows[0].value,35);
  assert.equal(readout([line],[],0,2000,4000,4000,[],undefined,1000).rows[0].value,null);
  const cap = {...line,capCells:[{at:0,from:100,to:1000,value:35}]};
  assert.equal(readout([cap],[],0,2000,4000,4000,[],undefined,999).rows[0].value,35);
  assert.equal(readout([cap],[],0,2000,4000,4000,[],undefined,1000).rows[0].value,null);
});

test('actual native chart generators never draw past an explicit bound or connect a suppressed coarse cell', () => {
  for (const strip of [false,true]) {
    const hook = preparationFixture();
    const block: PlotBlock = {from:0,to:4000,gap:false,points:[[0,35,1,204_000,1000],[2000,29,2,204_000,2000],[3000,28,2,204_000]]};
    const line: PlotSeries = {sourceId:'s',windowId:'w',points:block.points.map(([at,left,segment,,until])=>until===undefined?[at,left,segment]:[at,left,segment,until]),staleAfterMs:204_000,...(strip?{blocks:[{block,join:false}]}:{})};
    const source = readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
    const start = source.indexOf('  const inputs = '), region = source.slice(start,source.indexOf('  const model = ',start));
    const context = {...hook,axis:{active:false,basis:{from:0,to:4000,end:4000}},
      incomingStrip:strip?{from:0,to:4000}:null,desiredFrom:0,desiredTo:4000,desiredNow:4000,requested:{from:0,to:4000,end:4000},incomingLines:[line],
      valueAxis:undefined,stepped:false,modelContext:'',navigation:undefined,desiredLive:false,incomingReady:true,incomingPlans:[],incomingForecasts:[],incomingMarkers:[],
      cellMs:4000,width:4000,height:100,left:0,right:0,top:0,bottom:0,clipPrepared,plotPathPrepared,blockPaths:{current:new WeakMap()},NO_FORECASTS:[],
      draw:null as unknown as ()=>{value:{paths:{line:string;parts:{line:string}[]|null}[]}|null},
    };
    runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    hook.begin();context.draw();hook.commit();hook.finish();hook.begin();
    const path = context.draw().value!.paths[0];
    const drawn = path.parts?.map(p=>p.line).join('') ?? path.line;
    assert.equal(drawn,'M66.7,65.0M266.7,72.0','the old value ends at the bound and recovery starts a new run on the minimum one-minute scale');
  }
});
