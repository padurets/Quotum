import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {tableLayout} from '../lib/table';
import type {useTableLayout} from '../components/AnalyticsTable';

test('the shared table fit follows resize and hidden columns at the exact padded boundary',()=>{
  let layout='table',deps:unknown[]=[],stop:(()=>void)|undefined,fit=()=>{},disconnects=0;
  const panel={current:{clientWidth:684}},columns=[{width:140},{width:140},{width:140}];
  const modules:Record<string,unknown>={
    react:{memo:(fn:unknown)=>fn,useState:()=>[layout,(next:string)=>{layout=next;}],useLayoutEffect:(run:()=>()=>void,next:unknown[])=>{
      if(next.length!==deps.length||next.some((value,i)=>value!==deps[i])){stop?.();deps=next;stop=run();}
    }},'react/jsx-runtime':jsx,'../lib/table':{tableLayout},
  };
  const context={exports:{} as {useTableLayout:typeof useTableLayout},require:(name:string)=>modules[name]??{},
    getComputedStyle:()=>({paddingLeft:'22px',paddingRight:'22px'}),
    ResizeObserver:class{constructor(callback:()=>void){fit=callback;}observe(){}disconnect(){disconnects++;}},
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/AnalyticsTable.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const read=(visible=columns)=>context.exports.useTableLayout(panel as any,visible,240);
  read();assert.equal(read(),'table');
  panel.current.clientWidth=683;fit();assert.equal(read(),'list');
  panel.current.clientWidth=684;fit();assert.equal(read(),'table');
  panel.current.clientWidth=404;fit();assert.equal(read(),'list');
  read(columns.slice(0,1));assert.equal(read(columns.slice(0,1)),'table','hiding columns changes the same decision used by the toolbar');
  panel.current.clientWidth=403;fit();assert.equal(read(columns.slice(0,1)),'list');
  assert.equal(disconnects,1,'unchanged width budgets keep one observer');stop?.();assert.equal(disconnects,2);
});
