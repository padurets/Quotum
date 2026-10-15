import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {SETS} from '../../demo/catalogue.js';
import {DAY} from '../../demo/model.js';
import {panningSet} from '../fixture.js';

test('the native fixture retains twelve visible subscriptions of each period beyond the cold 30d edge',()=>{
  const set=panningSet(SETS[0]);
  for(const kind of ['session','weekly'])for(const at of [-67.5*DAY,-37.5*DAY,0]) {
    const visible=set.entries.filter(entry=>entry.kind==='card'&&entry.history>=75*DAY&&!entry.on?.ana?.hidden&&entry.machines.some(id=>!set.entries.some(machine=>machine.kind==='machine'&&machine.id===id&&machine.person&&machine.person!=='ana'))&&entry.windows.some(window=>window(at).kind===kind&&!entry.on?.ana?.windows?.includes(window(at).id)));
    assert.ok(visible.length>=12,`${kind} at ${at/DAY}d has only ${visible.length} eligible sources`);
  }
  assert.deepEqual(SETS[0].entries.find(entry=>entry.kind==='card'&&entry.id==='claude-hidden-windows'),set.entries.find(entry=>entry.kind==='card'&&entry.id==='claude-hidden-windows'),'hidden limits never supply stress load');
});

test('the actual settled probe counts distinct measured series intersecting the viewport',()=>{
  const source=readFileSync(new URL('../panning.ts',import.meta.url),'utf8'),probe=source.match(/const density = \(\) => cdp.evaluate[^`]+`([\s\S]+?)`\);/)![1];
  const groups=Array.from({length:12},(_,i)=>({dataset:{series:'source-'+i},paths:[{getBoundingClientRect:()=>({left:100,right:200})}],querySelectorAll(){return this.paths;}}));
  groups[0].paths.push({getBoundingClientRect:()=>({left:300,right:400})});
  const panel={querySelector:()=>({getBoundingClientRect:()=>({left:0,right:900,width:900}),viewBox:{baseVal:{width:900}}}),querySelectorAll:()=>groups};
  const document={querySelector:()=>panel};
  assert.equal(runInNewContext(probe,{document}).sessionSeries,12,'separate reset paths do not count as extra series');
  groups[11].paths=[{getBoundingClientRect:()=>({left:-200,right:-100})}];
  assert.equal(runInNewContext(probe,{document}).sessionSeries,11,'off-screen retained geometry does not replace a missing edge series');
});
