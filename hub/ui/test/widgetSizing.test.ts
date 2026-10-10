import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WidgetSizing} from '../lib/widgetSizing';
import {rowsFor,settle} from '../lib/grid';

const same=(a:number|undefined,b:number|undefined)=>a===b||a!==undefined&&b!==undefined&&Math.abs(a-b)<1;

test('a growing agent list moves its neighbours without notifying content with automatic heights',()=>{
  const sizing=new WidgetSizing(same),woken:string[]=[];
  for(const id of ['agents','card','chart'])sizing.subscribe(id,()=>woken.push(id));
  const positions=()=>settle(['agents','card','chart'].map(id=>({id,x:0,w:6,h:rowsFor(sizing.sizes[id],undefined)})),6);
  for(const id of ['agents','card','chart'])sizing.report(id,{min:100,natural:100,shown:100});
  const before=positions();
  sizing.allocate(new Map(before.map(spot=>[spot.id,0])));
  assert.equal(sizing.report('agents',{min:100,natural:180,shown:180}),true);
  const after=positions();
  assert.ok(after[1].y>before[1].y);
  sizing.allocate(new Map(after.map(spot=>[spot.id,0])));
  assert.deepEqual(woken,[]);
  sizing.allocate(new Map(after.map(spot=>[spot.id,spot.id==='agents'?176:0])));
  assert.deepEqual(woken,['agents'],'only the widget whose own allocation changed reads it again');
});

test('fractional measurements settle, and a released width waits for its own content report',()=>{
  const sizing=new WidgetSizing(same);
  sizing.report('chart',{min:100,natural:200,shown:250});
  assert.equal(sizing.measure({chart:250.5},0),false);
  assert.equal(sizing.measure({chart:300},0,true),false,'a snapped width retains the last report until the chart draws it');
  assert.equal(sizing.report('chart',{min:110,natural:210,shown:300}),true);
  assert.equal(sizing.measure({chart:300.5},0),false);
  assert.equal(sizing.measure({},0),true);
  sizing.report('chart',null);
  assert.deepEqual(sizing.heights,{});assert.deepEqual(sizing.sizes,{});
  let calls=0;const stop=sizing.subscribe('chart',()=>calls++);
  sizing.allocate(new Map([['chart',300]]));
  sizing.allocate(new Map([['chart',300.5]]));assert.equal(calls,1);
  stop();sizing.allocate(new Map());assert.equal(calls,1);
});
