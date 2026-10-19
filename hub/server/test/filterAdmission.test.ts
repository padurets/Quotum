import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters,executableWorkFilters,jsonBytes,matchesWork,prepareWorkFilter,workFilter,type Selection,type FilterWork,type FamilyRef} from '../domain/dataFilters.js';
import {PERIOD_BODY_BYTES} from '../domain/periodRead.js';

test('prepared work membership captures all modes and empty rules before the input changes',()=>{
  const rows:FilterWork[]=Array.from({length:360},(_,i)=>({source:i%3?`s${i%7}`:null,...(i%6===0?{sourceStatus:'notProvided' as const}:{}),project:i%4?`项目${i%11}`:null,device:`d${i%5}`,clientId:i%3?`c${i%4}`:'unknown'}));
  let comparisons=0;
  for(let modes=0;modes<16;modes++)for(let size=0;size<12;size++){
    const filters=workFilter(defaultFilters());
    const refs={sources:[{source:'s1'},{status:'unknown'},{status:'notProvided'}],projects:[null,'项目1','项目4'],devices:['d1','d3'],clients:[null,'c1']};
    for(const [i,family] of (['sources','projects','devices','clients'] as const).entries())filters[family]={mode:modes&(1<<i)?'include':'exclude',values:size?refs[family].slice(0,size%4):[]} as never;
    const expected=rows.map(row=>matchesWork(filters,row));let charged=0;
    const prepared=prepareWorkFilter(filters,bytes=>{charged+=bytes;});
    assert.ok(charged>=256);
    for(const family of ['sources','projects','devices','clients'] as const){const rule=filters[family] as Selection<FamilyRef>;rule.mode=rule.mode==='include'?'exclude':'include';rule.values.length=0;}
    assert.deepEqual(rows.map(prepared),expected);comparisons+=rows.length;
  }
  assert.equal(comparisons,69120);
});

test('the current producer full envelope fits with the entire executable predicate and accepted tokens',()=>{
  const filters=defaultFilters();filters.projects={mode:'include',values:Array.from({length:876},(_,i)=>`${i}`.padStart(83,'p'))};
  assert.equal(executableWorkFilters(filters),true);
  const source=(i:number)=>`${i}`.padStart(24,'a'),meter=(i:number)=>`${i}`.padStart(160,'m');
  const query={cell:'3600000',from:'1800000000000',to:'1800003600000',unit:'x'.repeat(120),currency:'x'.repeat(120),meters:JSON.stringify(Array.from({length:32},(_,i)=>[source(i),meter(i)])),meta:'m'.repeat(43),evidence:'e'.repeat(2048)};
  const request={version:1,selection:{mode:'range',from:1800000000000,to:1800003600000},evaluatedAt:1800003600000,workFilter:workFilter(filters),values:Array.from({length:2000},(_,i)=>source(i)),quota:{...query,sources:JSON.stringify(Array.from({length:2000},(_,i)=>source(i)))},budget:{...query,work:'1'},funds:query,sessions:{cursor:'s'.repeat(2048)},sourceWork:{cursor:'s'.repeat(2048)},facets:true};
  assert.ok(jsonBytes(request)>76*1024);assert.ok(jsonBytes(request)<PERIOD_BODY_BYTES);
});
