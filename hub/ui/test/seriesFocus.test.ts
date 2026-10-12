import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {seriesFocusStyle} from '../components/seriesFocus';

test('legend focus paints only its widget, respects hover/keyboard/muted state, and cleans up',()=>{
  const properties=new Map<string,string>(),events=new Map<string,(event:any)=>void>();let writes=0,cleanup=()=>{},refresh=()=>{};
  class Button {dataset:Record<string,string>;pressed='true';visible=true;attached=true;constructor(key:string){this.dataset={seriesKey:key};}closest(){return this;}getAttribute(){return this.pressed;}matches(){return this.visible;}}
  const root={contains:(button:Button)=>button.attached,style:{setProperty:(key:string,value:string)=>{writes++;properties.set(key,value);},removeProperty:(key:string)=>{writes++;properties.delete(key);}},addEventListener:(name:string,run:(event:any)=>void)=>events.set(name,run),removeEventListener:(name:string)=>events.delete(name)};
  const context={exports:{} as {useSeriesFocus:(panel:unknown)=>void},Element:Button,require:()=>({useRef:(current:unknown)=>({current}),useLayoutEffect:(run:()=>void)=>{refresh=run;},useEffect:(run:()=>()=>void)=>{cleanup=run();}})};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/seriesFocus.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  context.exports.useSeriesFocus({current:root});
  const a=new Button('source@window'),b=new Button('Group 😀'),muted=new Button('muted');muted.pressed='false';
  const send=(type:string,target:Button|null,relatedTarget:Button|null=null,pointerType='mouse')=>events.get(type)!({type,target,relatedTarget,pointerType});
  send('pointerover',a);assert.equal(properties.get('--chart-focus'),'.25');assert.equal(properties.size,2);
  const previous=writes;send('pointerover',a);send('pointerout',a,a);refresh();assert.equal(writes,previous,'moving within an entry does no paint work');
  send('focusin',b);assert.equal(writes,previous,'hover wins over a different focused legend item');
  send('pointerout',a);assert.ok([...properties.keys()].some(key=>key.startsWith('--series-47-')),'keyboard focus remains after the pointer leaves');
  send('focusout',b);assert.equal(properties.size,0);
  send('pointerover',muted);assert.equal(properties.size,0,'a switched-off line cannot dim the visible lines');
  send('pointerover',a,null,'touch');assert.equal(properties.size,0,'touch keeps the existing visibility gesture');
  send('pointerover',a);a.pressed='false';refresh();assert.equal(properties.size,0,'a visibility change clears stale paint state');
  a.pressed='true';refresh();assert.equal(properties.size,2);a.attached=false;refresh();assert.equal(properties.size,0,'removed selections do not dim replacements');
  send('pointerover',b);cleanup();assert.equal(properties.size,0);assert.equal(events.size,0);
  assert.notDeepEqual(seriesFocusStyle('a:b'),seriesFocusStyle('ab'),'series variables retain identity');
});
