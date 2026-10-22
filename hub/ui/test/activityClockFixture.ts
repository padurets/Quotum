import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {PageClock} from '../lib/clock';
import {projectColorBindings} from './projectColorBindings';
import {ACTIVITY} from '../../server/domain/widgets';
import {num,workHours,stamp} from '../lib/format';
import {atOnce,activityEmpty,activitySeriesKey,activityGroupName as groupName} from '../lib/activity';
import {t} from '../i18n';
import {cellLabel} from '../lib/periods';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
const clockSource=readFileSync(new URL('../lib/clock.ts',import.meta.url),'utf8');
const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

/** Persistent hook slots, real PageClock subscriptions and the production numerical renderer. */
export function activityClockConsumer(name:string,clock:PageClock,period:any,initial:any,panning:()=>number|null=()=>null,panAt:()=>number=()=>clock.hubNow()) {
  let cursor=0,dirty=true,renders=0,props=initial,output='',node:any;
  const focus={get:()=>null,subscribe:()=>()=>{}};
  props={focus,groups:[],titles:{},...props};
  const slots:any[]=[],effects:(()=>void)[]=[],stops:(()=>void)[]=[];
  const slot=(create:()=>any)=>{const at=cursor++;return slots[at]??(slots[at]=create());};
  const useRef=(current:any)=>slot(()=>({current}));
  const context:any={...projectColorBindings(),ACTIVITY,exports:{},require,memo:(value:any)=>value,useLocale:()=>{},usePanning:panning,boardPeriod:period,pan:{get:()=>panning()===null?null:{now:panAt()}},
    useId:()=> 'legend-description',seriesFocusStyle:()=>({}),useRef,useState:(initial:any)=>{const box=slot(()=>({value:typeof initial==='function'?initial():initial}));return [box.value,(value:any)=>{box.value=value;dirty=true;}];},
    useSyncExternalStore:(subscribe:any,read:any)=>{const box=slot(()=>{const value={current:read()};stops.push(subscribe(()=>{const next=read();if(!Object.is(next,value.current)){value.current=next;dirty=true;}}));return value;});return box.current=read();},
    LABELS:{source:'activity.bySource',project:'activity.byProject',device:'activity.byDevice'},groupName,useLayoutEffect:(effect:any)=>effects.push(effect),clock,hubNow:clock.hubNow,num,workHours,stamp,atOnce,activityEmpty,activitySeriesKey,t,cellLabel,
    Tooltip:({children}:any)=>React.createElement('div',{className:'tooltip'},children),
  };
  runInNewContext(compile(clockSource.slice(clockSource.indexOf('export function useClock'))),context);context.useClock=context.exports.useClock;
  const numbers=source.slice(source.indexOf('function Metrics('),source.indexOf('/** Keyboard descriptions'));
  const totals=source.slice(source.indexOf('const Totals=memo'),source.indexOf('type ActivityRegistry='));
  const readout=source.slice(source.indexOf('function ActivityReadout('),source.indexOf('const Stacks ='));
  const legend=source.slice(source.indexOf('const LegendItem = memo'),source.indexOf('/** Only this small region'));
  runInNewContext(compile(numbers+legend+totals+readout+`\nexports.component=${name};`),context);
  const render=()=>{if(dirty){dirty=false;cursor=0;node=context.exports.component(props);output=renderToStaticMarkup(node);renders++;while(effects.length)effects.shift()!();}return output;};
  return {element:()=>node,render,focus:(visible:boolean)=>node.props.children[0].props.onFocus({currentTarget:{matches:()=>visible}}),update:(next:any)=>{props={focus,groups:[],titles:{},...next};dirty=true;return render();},get renders(){return renders;},close:()=>stops.forEach(stop=>stop())};
}
