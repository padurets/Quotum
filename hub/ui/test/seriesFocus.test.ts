import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {seriesFocusStyle} from '../components/seriesFocus';

const chart=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
const planMarkup=chart.slice(chart.indexOf('{plans.map('),chart.indexOf('{forecasts.map'));
const planRenderer={exports:{} as {paint:(plans:unknown[],planPaths:string[])=>{children:{props:{style:Record<string,string>;d:string}}[][]}},seriesFocusStyle,node:(_tag:unknown,props:unknown,...children:unknown[])=>({props,children})};
runInNewContext(ts.transpileModule(`export const paint=(plans,planPaths)=><g>${planMarkup}</g>;`,{fileName:'plans.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'node'}}).outputText,planRenderer);

test('legend focus paints only its widget, respects hover/keyboard/muted state, and cleans up',()=>{
  const properties=new Map<string,string>(),events=new Map<string,(event:any)=>void>();let writes=0,cleanup=()=>{},refresh=()=>{};
  class Button {dataset:Record<string,string>;pressed='true';visible=true;attached=true;constructor(key:string){this.dataset={seriesKey:key};}closest(){return this;}getAttribute(){return this.pressed;}matches(){return this.visible;}}
  const root={contains:(button:Button)=>button.attached,style:{setProperty:(key:string,value:string)=>{writes++;properties.set(key,value);},removeProperty:(key:string)=>{writes++;properties.delete(key);}},addEventListener:(name:string,run:(event:any)=>void)=>events.set(name,run),removeEventListener:(name:string)=>events.delete(name)};
  const context={exports:{} as {useSeriesFocus:(panel:unknown)=>void},Element:Button,require:()=>({useRef:(current:unknown)=>({current}),useLayoutEffect:(run:()=>void)=>{refresh=run;},useEffect:(run:()=>()=>void)=>{cleanup=run();}})};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/seriesFocus.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  context.exports.useSeriesFocus({current:root});
  const a=new Button('source@window'),b=new Button('Group 😀'),muted=new Button('muted');muted.pressed='false';
  const send=(type:string,target:Button|null,relatedTarget:Button|null=null,pointerType='mouse')=>events.get(type)!({type,target,relatedTarget,pointerType});
  const plans=planRenderer.exports.paint([{key:'source@resetHour',lines:[a.dataset.seriesKey,b.dataset.seriesKey]},{key:'other@resetHour',lines:['other@weekly']}],['M0,0L10,10','M0,10L10,0']).children[0];
  const focus=(plan:typeof plans[number])=>Math.max(...[...plan.props.style['--series-focus'].matchAll(/var\((--series-[\w-]+)/g)].map(([,key])=>Number(properties.get(key)??properties.get('--chart-focus')??1)));
  send('pointerover',a);assert.equal(properties.get('--chart-focus'),'.25');assert.equal(properties.size,2);
  assert.equal(focus(plans[0]),1,'the selected line retains its associated plan despite a different reset identity');assert.equal(focus(plans[1]),.25);
  const previous=writes;send('pointerover',a);send('pointerout',a,a);refresh();assert.equal(writes,previous,'moving within an entry does no paint work');
  send('focusin',b);assert.equal(writes,previous,'hover wins over a different focused legend item');
  send('pointerout',a);assert.ok([...properties.keys()].some(key=>key.startsWith('--series-47-')),'keyboard focus remains after the pointer leaves');
  assert.equal(focus(plans[0]),1,'a shared plan follows either associated line under keyboard focus');assert.equal(focus(plans[1]),.25);
  assert.deepEqual(plans.map(plan=>plan.props.d),['M0,0L10,10','M0,10L10,0'],'focusing the legend does not rebuild plan geometry');
  send('focusout',b);assert.equal(properties.size,0);
  send('pointerover',muted);assert.equal(properties.size,0,'a switched-off line cannot dim the visible lines');
  send('pointerover',a,null,'touch');assert.equal(properties.size,0,'touch keeps the existing visibility gesture');
  send('pointerover',a);a.pressed='false';refresh();assert.equal(properties.size,0,'a visibility change clears stale paint state');
  a.pressed='true';refresh();assert.equal(properties.size,2);a.attached=false;refresh();assert.equal(properties.size,0,'removed selections do not dim replacements');
  send('pointerover',b);cleanup();assert.equal(properties.size,0);assert.equal(events.size,0);
  assert.notDeepEqual(seriesFocusStyle('a:b'),seriesFocusStyle('ab'),'series variables retain identity');
});

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
