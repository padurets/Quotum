import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {defaultWidth,landed,ordered,placesOf,settle,starts,widths,widened,withArranged,withSparseArrangement,type Height,type Place} from '../lib/grid';
import {EMPTY_VIEW,decodeView,encodeView,viewBytes,VIEW_BODY_LIMIT,type View} from '../../server/domain/view';
const shape=(items:ReturnType<typeof ordered>)=>items.map(({id,x,w})=>({id,x,w}));

/** Exhaustive deletion checks are a small-input oracle for the sparse save contract. */
function exhaustive(view:View,places:Record<string,Place>,ids:string[],height?:Height) {
  const result=withArranged(view,places,height),expected=ordered(result.layout,ids);
  for(const id of ids) {
    if(!id.startsWith('source:')||Object.hasOwn(view.layout.places,id)||height?.id===id)continue;
    const candidate={...result.layout.places};delete candidate[id];
    const actual=ordered({...result.layout,places:candidate},ids);
    if(actual.every((item,i)=>item.id===expected[i].id&&item.x===expected[i].x&&item.w===expected[i].w))result.layout.places=candidate;
  }
  return result;
}

test('sparse normalization matches exhaustive pruning across mixed arrangements and height intents',()=>{
  let seed=105;
  const pick=(n:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let attempt=0;attempt<3000;attempt++) {
    const ids=Array.from({length:2+pick(15)},(_,i)=>'source:'+i).concat(['agents','quota-history'].slice(0,pick(3)));
    const places:Record<string,Place>={'source:hidden':{x:3,y:2,w:3,h:13},'source:absent':{x:0,y:100,w:4,h:7}};
    for(const id of ids)if(pick(3)===0){const w=widths(6)[pick(4)],xs=starts(6,w);places[id]={x:xs[pick(xs.length)],w,y:pick(12),...(pick(2)?{h:1+pick(20)}:{})};}
    const view:View={...EMPTY_VIEW,layout:{columns:6,places},hidden:['source:hidden'],names:{absent:'Saved name'},windows:[]};
    const before=structuredClone(view),origin=settle(ordered(view.layout,ids).map(item=>({...item,h:view.layout.places[item.id]?.h??1+pick(10)})),6);
    const target=origin[pick(origin.length)],kind=pick(4),height:Height|undefined=kind===0?{id:target.id,rows:pick(3)?1+pick(20):null}:undefined;
    const reordered=[...origin];
    if(kind===3)for(let i=reordered.length-1;i>0;i--){const j=pick(i+1);[reordered[i],reordered[j]]=[reordered[j],reordered[i]];}
    const next=kind===0?settle(origin.map(item=>({...item,h:item.id===target.id?height!.rows??5:item.h})),6)
      :kind===1?widened(origin,target.id,widths(6,target.x)[pick(widths(6,target.x).length)],6)
      :kind===2?landed(origin,target.id,{x:starts(6,target.w)[pick(starts(6,target.w).length)],y:pick(40)},6)
      :settle(reordered,6);
    const changed=placesOf(next),expected=exhaustive(view,changed,ids,height),actual=withSparseArrangement(view,changed,ids,height);
    assert.deepEqual(actual,expected,'case '+attempt);
    assert.deepEqual(shape(ordered(actual.layout,ids)),shape(ordered(withArranged(view,changed,height).layout,ids)));
    assert.deepEqual(actual.layout.places['source:hidden'],view.layout.places['source:hidden']);
    assert.deepEqual(actual.layout.places['source:absent'],view.layout.places['source:absent']);
    assert.deepEqual(view,before,'normalization cannot mutate the prior draft');
    assert.equal(viewBytes(actual),viewBytes(expected));assert.ok(decodeView(encodeView(actual)));
  }
});

/** Count complete layout traversals, avoiding machine-dependent timing assertions. */
function instrumented() {
  const source=readFileSync(new URL('../lib/grid.ts',import.meta.url),'utf8'),start=source.indexOf('export function withSparseArrangement');
  const body=source.slice(start,source.indexOf('export function narrowed',start));
  let visited=0;
  const context={exports:{} as {withSparseArrangement:typeof withSparseArrangement},withArranged,defaultWidth,starts,
    ordered:(...args:Parameters<typeof ordered>)=>{visited+=args[1].length;return ordered(...args);}};
  runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {run:context.exports.withSparseArrangement,visited:()=>visited};
}

test('a normal first-card height save traverses the full arrangement a bounded number of times',()=>{
  for(const count of [500,1000]) {
    const ids=Array.from({length:count},(_,i)=>'source:'+String(i).padStart(12,'0'));
    const origin=settle(ordered(EMPTY_VIEW.layout,ids).map(item=>({...item,h:5})),6);
    const next=settle(origin.map((item,i)=>({...item,h:i===0?6:5})),6),height={id:ids[0],rows:6};
    const probe=instrumented(),saved=probe.run(EMPTY_VIEW,placesOf(next),ids,height);
    assert.deepEqual(shape(ordered(saved.layout,ids)),shape(ordered(withArranged(EMPTY_VIEW,placesOf(next),height).layout,ids)));
    assert.equal(saved.layout.places[ids[0]].h,6);
    assert.ok(Object.keys(saved.layout.places).length<count,'neighbours that remain natural stay implicit');
    assert.ok(viewBytes(saved)<VIEW_BODY_LIMIT);assert.ok(decodeView(encodeView(saved)));
    assert.ok(probe.visited()<=count*2,`a ${count}-card save revisited ${probe.visited()} items in full orderings`);
  }
});
