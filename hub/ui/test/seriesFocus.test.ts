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

test('one legend arbiter handles pointer, keyboard, toggles, touch, dismissal and cleanup',()=>{
  const properties=new Map<string,string>(),events=new Map<string,(event:any)=>void>(),globalEvents=new Map<string,(event:any)=>void>(),microtasks:(()=>void)[]=[],timers=new Map<number,()=>void>();
  let writes=0,phase=()=>{},shift=false,active:number|null=null,folding=false,changed=()=>{},observing=false;
  class Button {dataset:Record<string,string>;pressed='true';visible=true;attached=true;isConnected=true;constructor(key:string){this.dataset={seriesKey:key};}closest(){return this;}contains(target:unknown){return target===this;}getAttribute(){return this.pressed;}matches(){return this.visible;}}
  const root={querySelector:()=>folding?{}:null,contains:(button:Button)=>button.attached,style:{setProperty:(key:string,value:string)=>{writes++;properties.set(key,value);},removeProperty:(key:string)=>{writes++;properties.delete(key);}},addEventListener:(name:string,run:(event:any)=>void)=>events.set(name,run),removeEventListener:(name:string)=>events.delete(name)};
  const context={exports:{} as {SeriesFocus:new()=>{attach:(panel:unknown,phase:unknown)=>()=>void;get:()=>string|null;refresh:()=>void;reset:()=>void;subscribe:(run:()=>void)=>()=>void}},Element:Button,require:()=>({}),
    queueMicrotask:(run:()=>void)=>microtasks.push(run),setTimeout:(run:()=>void)=>{timers.set(1,run);return 1;},clearTimeout:(id:number)=>timers.delete(id),
    addEventListener:(name:string,run:(event:any)=>void)=>globalEvents.set(name,run),removeEventListener:(name:string)=>globalEvents.delete(name),
    MutationObserver:class{constructor(run:()=>void){changed=run;}observe(){observing=true;}disconnect(){observing=false;}}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/seriesFocus.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const controller=new context.exports.SeriesFocus(),cleanup=controller.attach(root,{active:()=>active,shifting:()=>shift,onPhase:(run:()=>void)=>{phase=run;return()=>{};}}),changes:(string|null)[]=[];
  controller.subscribe(()=>changes.push(controller.get()));
  const a=new Button('source@window'),b=new Button('Group 😀'),muted=new Button('muted');muted.pressed='false';
  const send=(type:string,target:Button|null,relatedTarget:Button|null=null,pointerType='mouse')=>events.get(type)!({type,target,relatedTarget,pointerType});
  const plans=planRenderer.exports.paint([{key:'source@resetHour',lines:[a.dataset.seriesKey,b.dataset.seriesKey]},{key:'other@resetHour',lines:['other@weekly']}],['M0,0L10,10','M0,10L10,0']).children[0];
  const focus=(plan:typeof plans[number])=>Math.max(...[...plan.props.style['--series-focus'].matchAll(/var\((--series-[\w-]+)/g)].map(([,key])=>Number(properties.get(key)??properties.get('--chart-focus')??1)));
  send('pointerover',a);assert.equal(controller.get(),a.dataset.seriesKey);assert.equal(properties.get('--chart-focus'),'.25');assert.equal(properties.size,2);
  assert.equal(focus(plans[0]),1);assert.equal(focus(plans[1]),.25);
  const previous=writes;send('pointerover',a);send('pointerout',a,a);controller.refresh();assert.equal(writes,previous);
  send('focusin',b);assert.equal(writes,previous,'pointer priority also selects the numerical context');
  send('pointerout',a);assert.equal(controller.get(),b.dataset.seriesKey);assert.equal(focus(plans[0]),1);
  send('focusout',b);assert.equal(controller.get(),null);
  send('pointerover',muted);assert.equal(properties.size,0);
  send('pointerover',a);a.pressed='false';controller.refresh();assert.equal(controller.get(),null);
  a.pressed='true';controller.refresh();assert.equal(properties.size,2);a.attached=false;controller.refresh();assert.equal(properties.size,0);
  send('pointerover',b);globalEvents.get('keydown')!({key:'Escape'});assert.equal(controller.get(),null);controller.refresh();assert.equal(controller.get(),null,'Escape holds until a new entry or focus');
  send('pointerout',b);send('focusin',b);assert.equal(controller.get(),b.dataset.seriesKey);
  shift=true;phase();assert.equal(controller.get(),null);shift=false;active=1;phase();assert.equal(controller.get(),null);active=null;phase();assert.equal(controller.get(),b.dataset.seriesKey);
  active=1;phase();folding=true;active=null;phase();assert.equal(controller.get(),null,'the completed gesture still suppresses its final fold');
  folding=false;changed();assert.equal(controller.get(),b.dataset.seriesKey,'the DOM fold completion restores an existing keyboard context');
  controller.reset();send('pointerup',b,null,'touch');globalEvents.get('click')!({target:b});microtasks.splice(0).forEach(run=>run());assert.equal(controller.get(),b.dataset.seriesKey);assert.equal(timers.size,1);
  globalEvents.get('pointerdown')!({target:a});assert.equal(controller.get(),null);assert.equal(timers.size,0);
  send('pointerup',muted,null,'touch');globalEvents.get('click')!({target:muted});microtasks.splice(0).forEach(run=>run());assert.equal(controller.get(),null);
  send('pointerup',b,null,'touch');globalEvents.get('click')!({target:b});microtasks.splice(0).forEach(run=>run());timers.get(1)!();assert.equal(controller.get(),null);
  assert.ok(changes.length>5);cleanup();assert.equal(properties.size,0);assert.equal(events.size,0);assert.equal(globalEvents.size,0);assert.equal(observing,false);
  assert.notDeepEqual(seriesFocusStyle('a:b'),seriesFocusStyle('ab'));
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
