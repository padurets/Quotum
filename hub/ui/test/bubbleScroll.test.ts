import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('an anchored capped shared tooltip accepts native scrolling',()=>{
  const element={style:{} as Record<string,string>,dataset:{},getBoundingClientRect:()=>({left:10,right:110,height:94})};
  const context={exports:{} as {useBubble:(active:boolean,anchor:unknown)=>unknown},require:()=>({}),useRef:()=>({current:element}),useLayoutEffect:(run:()=>void)=>run(),useEffect:()=>{},innerHeight:280,
    document:{documentElement:{clientWidth:390}},roomOf:()=>({above:20,below:0}),coverOf:()=>0,sideOf:()=>({up:true,cap:20}),shiftOf:()=>0};
  const source=readFileSync(new URL('../components/Tooltip.tsx',import.meta.url),'utf8'),start=source.indexOf('export function useBubble('),end=source.indexOf('\n/**',start);
  runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  context.exports.useBubble(true,{current:{getBoundingClientRect:()=>({top:220,bottom:240})}});
  assert.equal(element.style.overflow,'auto');assert.equal(element.style.maxHeight,'20px');assert.equal(element.style.pointerEvents,'auto');
});

test('own scrolling does not place the bubble again and outside placement preserves its reading offset',()=>{
  const handlers=new Map<string,(event?:unknown)=>void>();let placements=0,cap='',scrollTop=0;
  const style:Record<string,string>={};
  // Expanding a real scroll container to its full content height clamps scrollTop.
  Object.defineProperty(style,'maxHeight',{get:()=>cap,set:(value:string)=>{cap=value;if(!value)scrollTop=0;}});
  const element={style,dataset:{},get scrollTop(){return scrollTop;},set scrollTop(value:number){scrollTop=cap?Math.max(0,Math.min(74,value)):0;},getBoundingClientRect:()=>({left:10,right:110,height:cap?20:94})};
  const context={exports:{} as {useBubble:(active:boolean,anchor:unknown)=>unknown},require:()=>({}),useRef:()=>({current:element}),useLayoutEffect:(run:()=>void)=>run(),useEffect:(run:()=>void)=>run(),innerHeight:280,
    addEventListener:(name:string,run:(event?:unknown)=>void)=>handlers.set(name,run),removeEventListener:()=>{},document:{documentElement:{clientWidth:390}},roomOf:()=>{placements++;return {above:20,below:0};},coverOf:()=>0,sideOf:()=>({up:true,cap:20}),shiftOf:()=>0};
  const source=readFileSync(new URL('../components/Tooltip.tsx',import.meta.url),'utf8'),start=source.indexOf('export function useBubble('),end=source.indexOf('\n/**',start);
  runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const anchor={current:{getBoundingClientRect:()=>({top:220,bottom:240})}};
  context.exports.useBubble(true,anchor);element.scrollTop=32;const before=placements;
  handlers.get('scroll')!({type:'scroll',target:element});assert.equal(element.scrollTop,32);assert.equal(placements,before,'native reading scroll must not trigger placement');
  handlers.get('scroll')!({type:'scroll',target:{}});assert.equal(element.scrollTop,32);assert.equal(placements,before+1,'page movement still recomputes placement');
  handlers.get('resize')!();assert.equal(element.scrollTop,32);assert.equal(placements,before+2);
  context.exports.useBubble(true,anchor);assert.equal(element.scrollTop,32,'an ordinary layout commit preserves the same detail position');
});
