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
  const original=SETS[0].entries.find(entry=>entry.kind==='card'&&entry.id==='claude-hidden-windows')!;
  const stable=set.entries.find(entry=>entry.kind==='card'&&entry.id===original.id)!;
  assert.ok(original.kind==='card'&&stable.kind==='card');
  assert.deepEqual({...stable,windows:original.windows},original,'hidden limits never supply stress load');
});

test('the actual settled probe keeps distinct density and numeric session evidence',()=>{
  const source=readFileSync(new URL('../panning.ts',import.meta.url),'utf8'),probe=source.match(/const density = \(\) => cdp.evaluate[^`]+`([\s\S]+?)`\);/)![1];
  const path=(left:number,right:number,d='M0,0L1,1')=>({d,getBoundingClientRect:()=>({left,right})});
  const groups=Array.from({length:12},(_,i)=>({dataset:{series:'source-'+i},paths:[path(100,200)],querySelectorAll(){return this.paths.filter(path=>path.d);}}));
  groups[0].paths.push({d:'M0,0',getBoundingClientRect:()=>{throw new Error('a later fragment must not add a layout read after an intersection');}});
  const svg={dataset:{drawFrom:'1000',drawTo:'2000'} as Record<string,string>,parentElement:{dataset:{axisEnd:'1900'}},getBoundingClientRect:()=>({left:0,right:900,width:900}),viewBox:{baseVal:{width:900}}};
  const panel={querySelector:()=>svg,querySelectorAll:()=>groups},document={querySelector:()=>panel};
  const read=()=>runInNewContext(probe,{document}),expected={groups:12,nonempty:12,intersecting:12,leftOnly:0,rightOnly:0,drawFrom:1000,drawTo:2000,axisEnd:1900};
  assert.equal(read().sessionSeries,12,'separate reset paths do not count as extra series');
  assert.deepEqual({...read().sessionDensity},expected);
  groups[11].paths=[path(100,200,'')];
  const empty=read();assert.equal(empty.sessionSeries,11);assert.deepEqual({...empty.sessionDensity},{...expected,nonempty:11,intersecting:11});
  assert.ok(!JSON.stringify(empty).includes('source-'),'evidence never includes series identities');
  groups[11].paths=[path(-200,-100),path(-90,-50)];
  assert.deepEqual({...read().sessionDensity},{...expected,intersecting:11,leftOnly:1});
  groups[11].paths=[path(950,1000)];
  assert.deepEqual({...read().sessionDensity},{...expected,intersecting:11,rightOnly:1});
  svg.dataset.drawFrom='';delete svg.dataset.drawTo;svg.parentElement.dataset.axisEnd='invalid';
  assert.deepEqual({...read().sessionDensity},{...expected,intersecting:11,rightOnly:1,drawFrom:null,drawTo:null,axisEnd:null});
});
