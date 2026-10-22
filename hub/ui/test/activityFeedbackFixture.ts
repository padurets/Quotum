import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ActivitySelection,type ActivitySelectionEnv} from '../lib/activitySelection';
import {HistoryPool} from '../lib/historyPool';
import {defaultFilters,matchesSource,workFilter} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import {ACTIVITY} from '../../server/domain/widgets';
import {chartMuteKey} from '../lib/prefs';
import {mutedKey} from '../lib/activity';
import {workChange} from '../lib/workChanges';
import {periodOf} from '../lib/periods';
import {timeRangeKey} from '../lib/timeRange';
import {fixture,drawings,flush} from './periodRuntimeFixture';

const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Drawing=Awaited<ReturnType<typeof drawings>>;
type Effect={deps?:readonly unknown[];stop?:()=>void};

/** Production hook and parent subscription, with persistent slots and commit effects. */
export function activityFeedback(h:Fixture,d:Drawing,options:{send?:ActivitySelectionEnv['send'];muted?:Record<string,boolean>}={}){
  const pool=new HistoryPool(),slots:any[]=[],effects:(()=>void)[]=[];
  let cursor=0,active=true,queued=false,renders=0,reads=0,fault:Error|null=null;
  let muted=options.muted??{},filters=defaultFilters(),paused=false,reader:ActivitySelection;
  const initial=d.renderActivity();
  assert.ok(initial.drawing&&initial.drawing.board===h.board,'the production drawing must be admitted before interaction');
  assert.ok(h.period.activityProjectionState(initial.drawing).ready,'the real upstream work must be ready');
  const slot=<T>(create:()=>T):T=>{const at=cursor++;return slots[at]??(slots[at]=create());};
  const renderLater=()=>{if(!active||queued||fault)return;queued=true;queueMicrotask(()=>{queued=false;render();});};
  const useLayoutEffect=(effect:()=>void|(()=>void),deps?:readonly unknown[])=>{
    const box=slot<Effect>(()=>({}));
    if(deps&&box.deps&&deps.length===box.deps.length&&deps.every((value,i)=>Object.is(value,box.deps![i])))return;
    effects.push(()=>{box.stop?.();box.deps=deps;box.stop=effect()??undefined;});
  };
  const context={exports:{} as any,ACTIVITY,ActivitySelection,workChange,matchesSource,historyPool:pool,hubNow:h.clock.hubNow,page:h.page,boardPeriod:h.period,
    fetchPeriod:async(board:string,request:Parameters<ActivitySelectionEnv['send']>[1],signal:AbortSignal,reserve:(bytes:number)=>boolean)=>{
      // A broken feedback loop must fail a bounded assertion rather than hang the suite.
      if(++reads>12)return new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('fixture stopped')),{once:true}));
      return options.send?options.send(board,request,signal,reserve):expandPeriod(JSON.parse(h.reader.read(board,h.alice.id,request)));
    },
    useState:(create:()=>ActivitySelection)=>[slot(create)],useRef:(current:unknown)=>slot(()=>({current})),
    useLayoutEffect,useEffect:useLayoutEffect,
    useSyncExternalStore:(subscribe:(listener:()=>void)=>()=>void,get:()=>unknown)=>{
      const box=slot<{value:unknown;stop:()=>void}>(()=>{
        const value={value:get(),stop:()=>{}};
        value.stop=subscribe(()=>{const next=get();if(!Object.is(value.value,next)){value.value=next;renderLater();}});
        return value;
      });
      return box.value=get();
    },
    useTimeRange:h.selectedRange,timeRange:h.selectedRange,usePref:()=>h.settings.range,periodOf,timeRangeKey,
    effectiveFilters:()=>filters,workFilter,defaultFilters,onDataFilters:()=>()=>{},UNAUTHORIZED:'unauthorized',
    window:{dispatchEvent:()=>{}},
  };
  // These are the actual parent lines; a get-only store stub would miss the loop.
  const parent=source.slice(source.indexOf('  const subset=useActivitySubset('),source.indexOf('  const numeric=useMemo('));
  assert.ok(parent.includes('useSyncExternalStore(subset.subscribe,subset.get)'));
  runInNewContext(compile(source.slice(source.indexOf('export function activityMutedKeys('),source.indexOf('function useSubsetNumbers('))+
    '\nexports.consume=function(drawing,by,muted,authority,allOff){'+parent+'return {subset,local};};'),context);
  function render(){
    if(!active||fault)return;
    if(++renders>40){fault=new Error(`Activity feedback did not settle: ${renders} renders, ${reads} reads`);return;}
    cursor=0;const frame=d.renderActivity();
    reader=context.exports.consume(frame.drawing,'project',muted,frame.presentation,paused).subset;
    effects.splice(0).forEach(effect=>effect());
  }
  const legend={exports:{} as any,require:createRequire(import.meta.url),memo:(value:unknown)=>value,ACTIVITY,chartMuteKey,mutedKey,
    useLocale:()=>{},useId:()=> 'feedback-legend',useState:()=>[false,()=>{}],seriesFocusStyle:()=>({}),
    LegendAmount:()=>null,SelectedLegendAmount:()=>null,LegendMetrics:()=>null,SelectedLegendMetrics:()=>null,t:(key:string)=>key,
    setMuted:(key:string,on:boolean)=>{muted={...muted,[key]:on};renderLater();},
  };
  runInNewContext(compile(source.slice(source.indexOf('const LegendItem = memo'),source.indexOf('/** Keep dormant'))+'\nexports.LegendItem=LegendItem;'),legend);
  render();
  return {pool,get reader(){return reader!;},get reads(){return reads;},get renders(){return renders;},
    click:(key:string)=>{const entry=legend.exports.LegendItem({history:null,group:null,groupKey:key,by:'project',name:key,color:'#123456',muted:false,subset:reader});entry.props.children[0].props.onClick();},
    update:()=>renderLater(),pause:(value:boolean)=>{paused=value;renderLater();},filters:(value:typeof filters)=>{filters=value;renderLater();},
    async settle(){await flush();assert.equal(fault,null,fault?.message);},
    async close(){active=false;for(const box of slots)box?.stop?.();reader!.reset();await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);},
  };
}
