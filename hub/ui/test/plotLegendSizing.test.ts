import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('the actual plot freezes the latest observed legend size without forcing layout during input',()=>{
  let active=false,phase=()=>{},stopped=(_stop:unknown)=>{},mutated=()=>{},reads=0;
  const queued:(()=>void)[]=[],cleanups:(()=>void)[]=[],observed=new Set<unknown>();
  const legend=()=>({style:{height:'',overflow:'',alignContent:''},getBoundingClientRect:()=>{reads++;return {height:48};}});
  let current=legend(),resized=(_entries:unknown[])=>{};
  const panel={current:{querySelector:(selector:string)=>selector===':scope > .legend'?current:null}};
  const pan={active:()=>active?1:null,shifting:()=>false,onPhase:(run:()=>void)=>{phase=run;return()=>{};},onStop:(run:typeof stopped)=>{stopped=run;return()=>{};}};
  const react={createContext:()=>({}),useContext:()=>null,useState:(initial:unknown)=>[initial,()=>{}],useRef:(value:unknown)=>({current:value}),useCallback:(run:unknown)=>run,useLayoutEffect:(run:()=>void|(()=>void))=>{const cleanup=run();if(cleanup)cleanups.push(cleanup);}};
  const context={exports:{} as {usePlot:(panel:unknown)=>unknown},queueMicrotask:(run:()=>void)=>queued.push(run),devicePixelRatio:1,
    MutationObserver:class{constructor(run:()=>void){mutated=run;}observe(){}disconnect(){}},
    ResizeObserver:class{constructor(run:typeof resized){resized=run;}observe(element:unknown){observed.add(element);}unobserve(element:unknown){observed.delete(element);}disconnect(){observed.clear();}},
    require:(name:string)=>name==='react'?react:name==='../lib/pan'?{pan}:name==='../lib/timeRange'?{onTimeRange:()=>()=>{},timeRange:()=>null}:name==='../lib/prefs'?{onPrefs:()=>()=>{},prefs:()=>({range:'24h'})}:name==='../lib/board'?{page:{listen:()=>()=>{}}}:{useLocale:()=> 'en'},
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/sizing.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  context.exports.usePlot(panel);assert.ok(observed.has(current));
  const resize=(height:number)=>resized([{target:current,borderBoxSize:[{blockSize:height}],contentRect:{height:height-2}}]);
  resize(48);active=true;phase();assert.equal(current.style.height,'48px');assert.equal(reads,0);
  stopped({changed:false});active=false;phase();queued.splice(0).forEach(run=>run());assert.equal(current.style.height,'');
  resize(64);active=true;phase();assert.equal(current.style.height,'64px','font or width changes replace the retained geometry before the next gesture');assert.equal(reads,0);
  stopped({changed:false});active=false;phase();queued.splice(0).forEach(run=>run());
  const old=current;current=legend();mutated();assert.equal(observed.has(old),false);assert.ok(observed.has(current));
  resize(80);active=true;phase();assert.equal(current.style.height,'80px');assert.equal(reads,0);
  cleanups.reverse().forEach(run=>run());assert.equal(observed.size,0);assert.equal(current.style.height,'');
});
