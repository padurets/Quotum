import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {seriesFocusStyle} from '../components/seriesFocus';
import {arbiter} from './seriesFocusFixture';

const chart=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
const planMarkup=chart.slice(chart.indexOf('{plans.map('),chart.indexOf('{forecasts.map'));
const planRenderer={exports:{} as {paint:(plans:unknown[],planPaths:string[])=>{children:{props:{style:Record<string,string>;d:string}}[][]}},seriesFocusStyle,node:(_tag:unknown,props:unknown,...children:unknown[])=>({props,children})};
runInNewContext(ts.transpileModule(`export const paint=(plans,planPaths)=><g>${planMarkup}</g>;`,{fileName:'plans.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'node'}}).outputText,planRenderer);

test('focus styles reuse immutable values without encoding retained keys and keep bounded recent identities',()=>{
  let encodings=0;
  const context={exports:{} as {seriesFocusStyle:typeof seriesFocusStyle},require:()=>({}),Array:{from:(...args:Parameters<typeof Array.from>)=>{encodings++;return Array.from(...args);}},size:()=>0};
  const source=readFileSync(new URL('../components/seriesFocus.ts',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(source+'\nglobalThis.size=()=>styles.size;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const style=context.exports.seriesFocusStyle,first=style('source 😀 / window'),group=style(['source 😀 / window','other']);
  assert.ok(Object.isFrozen(first));const count=encodings;
  for(let i=0;i<100;i++){assert.equal(style('source 😀 / window'),first);assert.equal(style(['source 😀 / window','other']),group);}
  assert.equal(encodings,count,'clock and gesture renders do not encode the same CSS identity again');
  assert.equal(style(['source 😀 / window']),first,'one associated line has the same paint as that line');
  assert.notDeepEqual(style(['a,b','c']),style(['a','b,c']),'group identities cannot collide through delimiters');
  assert.notDeepEqual(style('😀'),style('\ud83d'),'whole codepoints and unmatched surrogates stay distinct');
  for(let i=0;i<512;i++){style('recent-'+i);style('source 😀 / window');}
  assert.equal(context.size(),512);assert.equal(style('source 😀 / window'),first,'a frequently used series survives the bounded recent cache');
  assert.notEqual(style(['source 😀 / window','other']),group,'an unused old group is evicted');
  assert.equal(context.size(),512);
});

test('click choices and pointer previews compose the complete three-level matrix without data or control renders',()=>{
  const h=arbiter(),{a,b,c,controller}=h,changes:(string|null)[]=[];
  controller.subscribe(()=>changes.push(controller.get()));
  assert.deepEqual(h.matrix(),[1,1,1]);
  h.click(a);h.click(b);assert.deepEqual(h.matrix(),[1,1,.4]);assert.equal(a.pressed,'true');assert.equal(b.pressed,'true');assert.equal(c.pressed,'false');
  h.hover(c);assert.deepEqual(h.matrix(),[.65,.65,1]);assert.equal(c.pressed,'false');
  const writes=h.writes;h.hover(c);controller.refresh();assert.equal(h.writes,writes,'unchanged interactions cause no repeated style writes');
  h.leave();assert.deepEqual(h.matrix(),[1,1,.4]);h.hover(a);assert.deepEqual(h.matrix(),[1,.65,.4]);
  h.click(a);assert.equal(a.pressed,'false');assert.deepEqual(h.matrix(),[1,.65,.4],'toggling previewed A off preserves the independent H');
  h.leave();assert.deepEqual(h.matrix(),[.4,1,.4]);h.click(b);assert.deepEqual(h.matrix(),[1,1,1]);
  for(const button of h.buttons)h.click(button);h.hover(b);assert.deepEqual(h.matrix(),[.65,1,.65],'all-chosen still distinguishes preview');
  assert.ok(changes.length>4);h.cleanup();assert.equal(h.properties.size,0);assert.equal(h.events.size,0);assert.equal(h.globalEvents.size,0);assert.equal(h.observing,false);
});

test('pointer wins over keyboard; Escape, pan/fold and touch dismiss previews while choices remain',()=>{
  const h=arbiter(),{a,b,c,controller}=h;
  h.click(a);h.click(b);h.send('focusin',b);h.hover(c);assert.equal(controller.get(),c.dataset.seriesKey);
  h.leave();assert.equal(controller.get(),b.dataset.seriesKey);h.globalEvents.get('keydown')!({key:'Escape'});
  assert.equal(controller.get(),null);assert.deepEqual(h.matrix(),[1,1,.4]);controller.refresh();assert.equal(controller.get(),null);
  h.send('focusout',b);h.send('focusin',a);h.shift(true);assert.equal(controller.get(),null);assert.deepEqual(h.matrix(),[1,1,.4]);
  h.shift(false);h.pan(1);assert.equal(controller.get(),null);h.fold(true);h.pan(null);assert.equal(controller.get(),null);h.fold(false);assert.equal(controller.get(),a.dataset.seriesKey);
  controller.dismiss();h.send('pointerup',c,null,'touch');h.click(c);assert.equal(c.pressed,'true');assert.equal(controller.get(),c.dataset.seriesKey);
  h.globalEvents.get('pointerdown')!({target:a});assert.equal(controller.get(),null);assert.deepEqual(h.matrix(),[1,1,1]);
  h.send('pointerup',b,null,'touch');h.click(b);assert.equal(b.pressed,'false');assert.deepEqual(h.matrix(),[.65,1,.65]);
  h.timers.get(1)!();assert.equal(controller.get(),null);assert.deepEqual(h.matrix(),[1,.4,1]);h.cleanup();assert.equal(h.timers.size,0);
});

test('dormant explicit identities survive range responses; only an explicit reset prevents their return',()=>{
  const h=arbiter(),{a,b,c,controller}=h;
  h.click(a);a.attached=false;controller.refresh();assert.deepEqual(h.matrix(),[1,1],'dormant A does not dim B/C');
  a.attached=true;controller.refresh();assert.deepEqual(h.matrix(),[1,.4,.4]);assert.equal(a.pressed,'true');
  a.attached=false;controller.reset();a.attached=true;controller.refresh();assert.equal(a.pressed,'false');assert.deepEqual(h.matrix(),[1,1,1],'late responses cannot restore reset choices');
  b.attached=c.attached=false;controller.refresh();h.click(a);h.hover(a);assert.deepEqual(h.matrix(),[1]);h.click(a);assert.equal(a.pressed,'false');assert.deepEqual(h.matrix(),[1]);h.leave();assert.deepEqual(h.matrix(),[1]);h.cleanup();
});

test('shared plans use the strongest associated series without changing their intrinsic layer opacity',()=>{
  const h=arbiter(),{a,b,c}=h;
  const plans=planRenderer.exports.paint([{key:'source@resetHour',lines:[a.dataset.seriesKey,b.dataset.seriesKey]},{key:'other@resetHour',lines:['other@weekly']}],['M0,0L10,10','M0,10L10,0']).children[0];
  const focus=(plan:typeof plans[number])=>Math.max(...[...plan.props.style['--series-focus'].matchAll(/var\((--series-[\w-]+)/g)].map(([,key])=>Number(h.properties.get(key)??h.properties.get('--chart-focus')??1)));
  h.click(a);h.hover(c);assert.equal(focus(plans[0]),.65);assert.equal(focus(plans[1]),.4);
  h.hover(b);assert.equal(focus(plans[0]),1);assert.equal(plans[0].props.d,'M0,0L10,10');h.cleanup();
});

test('actual crosshair markers follow click choices and previews without changing readout geometry',()=>{
  const start=chart.indexOf('{rows.map(row => row.value !== null && <circle'),end=chart.indexOf('\n          </g>',start);
  assert.ok(start>=0&&end>start);
  const h=arbiter(),rows=h.buttons.map((button,i)=>({line:{key:button.dataset.seriesKey,color:`color-${i}`},value:i+1}));
  const context={exports:{} as {paint:()=>{children:{props:Record<string,any>}[][]}},rows:[...rows,{line:{key:'unknown',color:'none'},value:null}],seriesFocusStyle,
    hover:12,hoverX:20,preciseReadout:()=>true,bx:()=>15,y:(value:number)=>value*2,node:(_tag:unknown,props:unknown,...children:unknown[])=>({props,children})};
  runInNewContext(ts.transpileModule(`export const paint=()=><g>${chart.slice(start,end)}</g>;`,{fileName:'crosshair.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'node'}}).outputText,context);
  const markers=Array.from(context.exports.paint().children[0]).filter(Boolean);
  assert.equal(markers.length,3,'unknown values do not invent a point');
  const geometry=()=>markers.map(({props})=>[props.cx,props.cy,props.r,props.fill]);
  const before=geometry(),matrix=()=>markers.map(({props})=>{
    assert.equal(props.className,'series-focus');
    const variable=props.style['--series-focus'].match(/var\((--series-[\w-]+)/)![1];
    return Number(h.properties.get(variable)??h.properties.get('--chart-focus')??1);
  });
  assert.deepEqual(matrix(),[1,1,1]);h.click(h.a);h.click(h.b);assert.deepEqual(matrix(),[1,1,.4]);
  h.hover(h.c);assert.deepEqual(matrix(),[.65,.65,1]);h.leave();assert.deepEqual(matrix(),[1,1,.4]);
  assert.deepEqual(geometry(),before,'paint changes neither the sampled values nor their point coordinates');h.cleanup();
});
