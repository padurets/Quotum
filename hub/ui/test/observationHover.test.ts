import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('the actual axis keeps snapped subscription hover without publishing raw pointer updates',()=>{
  const source=readFileSync(new URL('../components/timeAxis.ts',import.meta.url),'utf8'),start=source.indexOf('  const onPointerMove = '),region=source.slice(start,source.indexOf('  const onPointerDown = ',start));
  let rawUpdates=0,gridUpdates=0,cell:number|null=null;
  const context={rawPointer:false,shiftDrag:{current:null},pan:{move:()=>{}},toChart:(e:{clientX:number})=>e.clientX,pointer:{current:null},panning:false,folding:false,shifting:false,drag:null,holding:{current:null},width:900,left:40,right:12,timeAt:(px:number)=>px*1000,cellMs:60000,setRawHover:()=>{rawUpdates++;},setHover:(next:number)=>{if(next!==cell){gridUpdates++;cell=next;}},setDrag:()=>{},cancelHold:()=>{},move:null as unknown as (event:{clientX:number;pointerType:string})=>void};
  runInNewContext(ts.transpileModule(region+'\nglobalThis.move=onPointerMove;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  for(const clientX of [100,101,102])context.move({clientX,pointerType:'mouse'});
  assert.equal(gridUpdates,1);assert.equal(rawUpdates,0);
  context.rawPointer=true;
  for(const clientX of [103,104])context.move({clientX,pointerType:'mouse'});
  assert.equal(gridUpdates,1);assert.equal(rawUpdates,2,'observation consumers retain within-cell pointer precision');
  context.panning=true;context.move({clientX:105,pointerType:'mouse'});assert.equal(rawUpdates,2,'hidden panning readouts publish no pointer state');
});
