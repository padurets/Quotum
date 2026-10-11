import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {harness, H, NOW} from './historyAuthorityFixture';
import {test} from 'node:test';
import {preparationFixture} from './preparationFixture';
import {activityScale,
  activityEmpty,groupColors,mutedKey} from '../lib/activity';
import {plotGroupsPrepared} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {groupRegistry} from '../lib/plotRegistry';
import {cellStart} from '../../server/domain/history';
import {niceTicks} from '../lib/periods';
import {navigationKey} from '../lib/axisNavigation';
import {cardId,isHidden} from '../lib/view';

/** Executes the history-to-SVG path with explicit render, commit and preparation phases. */
function consumer(h: ReturnType<typeof harness>) {
  const parent=preparationFixture(),child=preparationFixture();
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  const axis={box:{current:null},svg:{current:null},width:400,scale:1,hover:null,drag:null,clip:'c',handlers:{},basis:{from:NOW-H,to:NOW,end:NOW},active:false,screenX:(at:number)=>48+(at-(NOW-H))/H*340,commitDrawing:()=>{}};
  const EMPTY_ACTIVITY={since:0,known:null,barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
  const titles={removed:{provider:'codex',title:'Removed'},kept:{provider:'codex',title:'Kept'}};
  let panning:number|null=null;
  const prefs={range:'1h',activityBy:'project',muted:{}};
  const context={
    exports:{} as any,React,...parent,memo:(f:any)=>f,useMemo:(f:any,deps:any[])=>{const slot=parent.useRef(null) as any;if(!slot.current||deps.some((v,i)=>!Object.is(v,slot.current.deps[i])))slot.current={deps,value:f()};return slot.current.value;},
    useEffect:()=>{},useId:()=> 'c',useHistory:()=>h.render(),useHistoryPlot:()=>h.loader.getPlot(),usePlot:()=>({plot:undefined,onBase:()=>{}}),
    useLineup:()=>h.page.get().board!.lineup,usePersonalBoard:()=>false,useTitles:()=>titles,
    usePrefs:()=>prefs,useLocale:()=> 'en',useTimeRange:()=>null,useBoardId:()=> 'b',
    axisNavigation:()=>({context:'b',range:'1h'}),useClock:()=>NOW,usePanning:()=>panning,
    pan:{get:()=>null,active:()=>null,subscribe:()=>()=>{}},useHistoryBegins:()=>0,frameOf:()=>({from:NOW-H,to:NOW,live:true}),measuredTo:()=>NOW,
    activityEmpty,groupColors,groupRegistry,mutedKey,plotGroupsPrepared,StackPaths,stacksHeight:()=>160,activityScale,niceTicks,cellStart,MINUTE:60_000,EMPTY_ACTIVITY,groupName:(g:any)=>g.name??g.key,cardId,isHidden,t:(s:any)=>s,
    quotaHistory:{retry:()=>{}},AnalyticsPanel:()=>null,ActivitySettings:()=>null,Totals:()=>null,LegendItem:()=>null,
    setTimeRange:()=>{},navigationKey,useTimeAxis:()=>axis,useTip:()=>({tip:{current:null},style:{}}),
    PlotLayer:()=>null,PlotOverlay:()=>null,Tooltip:()=>null,clock:()=>'',shortDay:()=>'',workHours:()=>'',stamp:()=>'',
    CSS:{escape:(id:any)=>id},Stacks:null as any};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('export const Activity ='))+'\nglobalThis.Stacks=Stacks;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,context);
  function find(node:any,type:any):any{if(Array.isArray(node))return node.map(n=>find(n,type)).find(Boolean);if(!React.isValidElement(node))return null;if(node.type===type)return node;return find((node.props as any).children,type);}
  const pathsOf=(node:any):string[]=>{if(Array.isArray(node))return node.flatMap(pathsOf);if(!React.isValidElement(node))return [];const p=node.props as any;return p.className==='activity-stack'&&p.d!==undefined?[p.d]:pathsOf(p.children);};
  let latestParent:any;const renderParent=()=>{Object.assign(context,parent);parent.begin();latestParent=context.exports.Activity({arrange:{view:h.page.get().board!.view}});return find(latestParent,context.Stacks).props;};
  const renderChild=(props:any)=>{Object.assign(context,child);child.begin();return pathsOf(context.Stacks(props));};

    const names=(node:any):string[]=>{if(Array.isArray(node))return node.flatMap(names);if(!React.isValidElement(node))return [];const props=node.props as any;return node.type===context.LegendItem?[props.name]:names(props.children);};
    const render=()=>{const props=renderParent();parent.commit();const paths=renderChild(props);child.commit();return {paths,names:names(latestParent),ready:props.prepared};};
    const settle=()=>{for(let i=0;i<4;i++){render();parent.finish();child.finish();}return render();};
    return {render,settle,pan:()=>{panning=1;axis.active=true;}};
}

for(const failure of [false,true])test(`activity retires final SVG and legend while exact replacement ${failure?'fails':'waits'}`,async()=>{
  const h=harness(true);try{
    await h.start();const c=consumer(h),initial=c.settle();assert.equal(initial.paths.length,2);assert.ok(initial.names.includes('removed project'));
    h.exact(false);h.event({type:'lineup',data:{sources:['kept']}});
    assert.deepEqual(c.render().paths,[],'the final consumer retires before another preparation task');
    await h.answerCells();if(failure)h.exact(false,'history_failed');
    const pending=c.settle();assert.deepEqual(pending.paths,[]);assert.deepEqual(pending.names,[]);
    h.exact(true);const fresh=c.settle();assert.equal(fresh.paths.length,1);assert.deepEqual(fresh.names,['kept project']);
  }finally{h.close();}
});

test('an authority change during a gesture retires the legend seed even if fresh cells beat the empty preparation',async()=>{
  const h=harness(true);try{
    await h.start();const c=consumer(h);c.settle();await h.pan();c.pan();await h.answerCells();c.settle();
    const token=h.loader.getPlot()!.token;
    h.exact(false);h.event({type:'lineup',data:{sources:['kept']}});c.render();
    await h.answerCells();assert.equal(h.loader.getPlot()!.token,token);
    assert.deepEqual(c.settle().names,['kept project'],'the actual legend contains only the new authorized strip');
  }finally{h.close();}
});

test('a same-ID authority replacement before the next React render cannot borrow its prepared paths',async()=>{
  const h=harness(true);try{
    const initial=await h.start();const c=consumer(h);assert.equal(c.settle().paths.length,2);
    h.event({type:'snapshot',data:{...h.snapshot(),historyStart:NOW-H/2}});await h.answerCells();
    assert.ok(h.loader.get().presentation>initial.presentation);assert.equal(h.loader.get().history!.board,'b');
    assert.deepEqual(c.render().paths,[],'there was no intermediate null-history render to clear context text');
    assert.equal(c.settle().paths.length,2,'the authorized replacement can prepare normally');
  }finally{h.close();}
});

test('same-authority period changes and transient errors retain the final activity drawing',async()=>{
  const h=harness(true);try{
    await h.start();const c=consumer(h),initial=c.settle();h.exact(false);h.choose('6h');await h.answerCells();
    assert.deepEqual(c.render().paths,initial.paths);h.exact(false,'history_failed');assert.deepEqual(c.settle().paths,initial.paths);
  }finally{h.close();}
});
