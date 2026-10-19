import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as format from '../lib/format';
import * as agents from '../lib/agents';
import {PageClock} from '../lib/clock';
import {t,setLocale} from '../i18n';
import type {LiveSession} from '../lib/types';

const minute=60_000,now=new Date(2026,9,19,12).getTime();
const source=readFileSync(new URL('../components/Agents.tsx',import.meta.url),'utf8');
const lastActivity=source.slice(source.indexOf('function LastActivity('),source.indexOf('/** A dimension shown'));
const compile=(code:string,context:object)=>runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);

/** Keep the production parent and time leaf; only the surrounding clock is supplied. */
function leaf(useClock:(changesAt:(now:number)=>number|null)=>number,hubNow:()=>number) {
  const modules:Record<string,unknown>={'react/jsx-runtime':jsxRuntime,'../lib/format':format,'../lib/agents':agents,'../lib/clock':{useClock,hubNow}};
  const time={exports:{} as {RecentActivity:React.ComponentType<{at:number}>},require:(name:string)=>modules[name]};
  compile(readFileSync(new URL('../components/Time.tsx',import.meta.url),'utf8'),time);
  const context={exports:{},LastActivity:null as unknown as (props:{group:agents.AgentGroup;still:boolean})=>React.ReactElement,require:()=>jsxRuntime,...format,t,hubNow,RecentActivity:time.exports.RecentActivity};
  compile(lastActivity+'\nglobalThis.LastActivity=LastActivity;',context);
  return context.LastActivity;
}

function group(change:Partial<LiveSession>={}) {
  const session:LiveSession={ref:'retained',device:{id:'d',name:'Laptop'},origin:'terminal',project:'Project',folder:null,startedAt:now-10*minute,lastWorkedAt:now-5*minute,working:false,workedMs:minute,...change};
  return agents.groupsOf([{session,source:null}],'none')[0];
}

test('last activity preserves working, unknown, retained and static measurement states without adding clocks to the sizing copy',()=>{
  let calls=0,due:number|null=null;
  const draw=leaf(changesAt=>{calls++;due=changesAt(now);return now;},()=>now);
  const render=(value:agents.AgentGroup,still:boolean)=>{calls=0;due=null;return renderToStaticMarkup(React.createElement(draw,{group:value,still}));};
  try {
    for(const locale of ['en','ru'] as const)for(const ref of ['retained',undefined])for(const still of [false,true]) {
      setLocale(locale);
      assert.equal(render(group({ref,working:true}),still),t('time.now'));
      assert.equal(calls,0,'working state depends on presence, not a timer');
      const unknown=render(group({ref,lastWorkedAt:null}),still);
      assert.ok(unknown.includes(t('agents.activityUnknown'))&&unknown.includes('—'));
      assert.equal(calls,0,'unknown work has no deadline');
      const html=render(group({ref}),still);
      assert.ok(html.includes(`title="${format.stamp(now-5*minute)}"`));
      assert.ok(html.includes(`>${t('time.minutesAgo',{n:5})}</span>`));
      assert.equal(calls,still?0:1,'the static measurement never mounts the timed leaf');
      assert.equal(html.includes('data-time="activity"'),!still);
      if(!still)assert.equal(due,now+minute);
    }
    const historical=render(group({lastWorkedAt:now-3*24*60*minute}),false);
    assert.ok(historical.includes(`>${format.stamp(now-3*24*60*minute)}</span>`));
    assert.equal(due,null,'old retained work keeps its date without future wakes');
  } finally {setLocale('en');}
});

test('the actual relative time leaf advances on the page clock without rebuilding its parent or receiving new work',()=>{
  let time=now,index=0,subscriptions=0,leafRenders=0,parentRenders=0,html='';
  let rerender=()=>{},stop:(()=>void)|undefined;
  const slots:unknown[]=[];
  const clock=new PageClock({now:()=>time,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  const context={clock,hubNow:clock.hubNow,exports:{} as {useClock:(changesAt:(now:number)=>number|null)=>number},
    useState:(initial:()=>unknown)=>{const at=index++;if(!(at in slots))slots[at]=initial();return [slots[at]];},
    useRef:(initial:unknown)=>slots[index++]??(slots[index-1]={current:initial}),
    useSyncExternalStore:(subscribe:(listener:()=>void)=>()=>void,get:()=>number)=>{if(!stop){subscriptions++;stop=subscribe(()=>rerender());}return get();},
    useLayoutEffect:(effect:()=>void)=>effect()};
  const clockSource=readFileSync(new URL('../lib/clock.ts',import.meta.url),'utf8');
  compile(clockSource.slice(clockSource.indexOf('export function useClock(')),context);
  const draw=leaf(context.exports.useClock,clock.hubNow),at=now-59_000;
  const parent=()=>{parentRenders++;return draw({group:group({lastWorkedAt:at}),still:false});};
  const child=parent();
  rerender=()=>{index=0;leafRenders++;html=renderToStaticMarkup(child);};
  try {
    setLocale('en');rerender();
    assert.ok(html.includes('data-time="activity"')&&html.includes('>now</span>'));
    assert.equal(subscriptions,1);
    time=at+minute-1;clock.wakeDue();assert.equal(leafRenders,1);
    time++;clock.wakeDue();assert.ok(html.includes('>1m ago</span>'));assert.equal(leafRenders,2);
    time=at+2*minute;clock.wakeDue();assert.ok(html.includes('>2m ago</span>'));assert.equal(leafRenders,3);
    assert.ok(html.includes(`title="${format.stamp(at)}"`));
    assert.equal(parentRenders,1,'a quiet parent retains the same child element through both clock wakes');
    assert.equal(subscriptions,1,'the leaf retains one page-clock subscription');
  } finally {stop?.();setLocale('en');}
});
