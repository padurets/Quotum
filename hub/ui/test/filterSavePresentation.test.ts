import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError,messageOf} from '../lib/http';
import {t,setLocale} from '../i18n';

test('filter save failures use the existing action chrome with accessible details and retry',()=>{
  const source=readFileSync(new URL('../components/DataFilters.tsx',import.meta.url),'utf8');
  const jsx=(type:unknown,props:Record<string,any>)=>({type,props});
  let saves=0,owner=true;
  const state={saved:{revision:1},current:{},dirty:true,saving:false,error:null as unknown};
  const context={exports:{} as {FilterSaveActions:()=>{props:Record<string,any>}},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),
    t,messageOf,useDataFilters:()=>state,useRole:()=>owner?'owner':'reader',executableWorkFilters:()=>true,useRemovalFocus:()=>()=>{},
    dataFilters:{restore:()=>{},save:()=>{saves++;}},Save:'save',RotateCcw:'restore',TriangleAlert:'warning',ErrorLine:'error',Popover:'popover'};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('export function FilterSaveActions')),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  try{
    for(const locale of ['en','ru'] as const){
      setLocale(locale);state.error=null;
      const healthy=context.exports.FilterSaveActions();assert.equal(healthy.props.className,'filter-save-actions');
      state.error=new ApiError(503,'unavailable');
      const failed=context.exports.FilterSaveActions(),children=failed.props.children;
      assert.equal(failed.props.className,healthy.props.className);
      assert.ok(!children.some((child:any)=>child?.type==='error'),'no error paragraph becomes another header row');
      const disclosure=children.find((child:any)=>child?.props.className==='reader-state is-warn').props.children;
      assert.equal(disclosure.type,'popover');assert.equal(disclosure.props.label,messageOf(state.error));
      const [error,retry]=disclosure.props.children.props.children;
      assert.equal(error.props.error,state.error);assert.equal(retry.props.children,t('filters.save'));
      retry.props.onClick();assert.equal(saves,locale==='en'?1:2);
      state.saving=true;assert.equal(context.exports.FilterSaveActions().props.children[2].props.children.props.children.props.children[1].props.disabled,true);state.saving=false;
      owner=false;assert.equal(context.exports.FilterSaveActions().props.children[2].props.children.props.children.props.children[1],false);owner=true;
    }
  }finally{setLocale('en');}
});
