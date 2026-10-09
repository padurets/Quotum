import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {byActivity,columnsOf,groupsOf,sortedGroups,visibleAgentsSort,type AgentsSort} from '../lib/agents';
import {columnShown,AGENTS} from '../lib/view';
import {EMPTY_VIEW} from '../../server/domain/view';
import type {WorkedSession} from '../../server/domain/periodWork';

/** Capture the actual component's selector before any DOM hooks are needed. */
function order(sort:AgentsSort,open=false,hidden=false,running=false){
  const source=readFileSync(new URL('../components/Agents.tsx',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('export const AgentsPanel'));
  let select:(rows:WorkedSession[])=>unknown=()=>null;
  const done={};
  const context={exports:{} as {AgentsPanel:(props:unknown)=>unknown},memo:(f:unknown)=>f,useLocale:()=>{},useLineup:()=>['s'],useTitles:()=>({s:{title:'Source',provider:'codex'}}),
    usePrefs:()=>({agentsSort:sort,agentsBy:'project'}),useState:()=>[open?{group:null}:null,()=>{}],useCallback:(f:unknown)=>f,
    usePeriodSessions:(f:typeof select)=>{select=f;throw done;},columnsOf,columnShown,AGENTS,groupsOf,sortedGroups,visibleAgentsSort,byActivity,
    require:()=>({})};
  runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  try{context.exports.AgentsPanel({arrange:{view:{...EMPTY_VIEW,columns:hidden?{[AGENTS]:['worked']}:{},shownColumns:running?{[AGENTS]:['running']}:{}}}});}catch(error){assert.equal(error,done);}
  return (rows:WorkedSession[])=>JSON.stringify(select(rows));
}
const row=(ref:string,project:string,workedMs:number):WorkedSession=>({ref,source:'s',device:{id:'d',name:'Machine'},origin:'terminal',project,folder:null,startedAt:0,workedMs,lastWorkedAt:100,working:false});

test('rolling totals render the agent panel only when its visible order changes',()=>{
  const before=[row('a','A',100),row('b','B',90)],after=[row('a','A',70),row('b','B',80)];
  for(const sort of [null,{column:'activity',descending:true},{column:'project',descending:false}] as AgentsSort[]){
    const read=order(sort);assert.equal(read(before),read(after));
  }
  const sorted=order({column:'worked',descending:true});assert.notEqual(sorted(before),sorted(after));
  const hidden=order({column:'worked',descending:true},false,true);assert.equal(hidden(before),hidden(after));
});

test('an open group dialog also follows changing worked order within its group',()=>{
  const before=[row('a','A',100),row('b','A',90)],after=[row('a','A',70),row('b','A',80)];
  const closed=order({column:'worked',descending:true});assert.equal(closed(before),closed(after));
  const opened=order({column:'worked',descending:true},true);assert.notEqual(opened(before),opened(after));
});

test('an open running-time sort reorders expired presence without changing the retained roster',()=>{
  const before=[{...row('a','A',100),currentPresence:{working:false,startedAt:0,through:100}},{...row('b','A',90),currentPresence:{working:false,startedAt:50,through:200}}];
  const after=[row('a','A',100),before[1]];
  // Running is deliberately hidden by default; changing a hidden sort does nothing.
  const hidden=order({column:'running',descending:false},true);assert.equal(hidden(before),hidden(after));
  const visible=order({column:'running',descending:false},true,false,true);assert.notEqual(visible(before),visible(after));
});
