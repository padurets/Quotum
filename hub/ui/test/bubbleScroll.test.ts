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
