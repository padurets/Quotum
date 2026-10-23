import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';

type Node={type:unknown;props:Record<string,any>};
function nodes(value:unknown):Node[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];const node=value as Node;return [node,...nodes(node.props.children)];}

test('actual heatmap cells share one description across pointer, focus and an open detail',()=>{
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props}),source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),memo:(f:unknown)=>f,createPortal:(node:unknown)=>node,
    useMemo:(read:()=>unknown)=>read(),useLocale:()=> 'en',formatLocale:()=> 'en',heatDateLabel:(date:string)=>date,heatIntervalLabel:()=> '12:00–13:00',
    exactAgentHours:String,calendarLevel:()=>1,CALENDAR_OPACITY:[0,.2],CATEGORY_COLORS:['blue'],MIN_TIME_RANGE:60_000,t:(key:string)=>key,useBubble:()=>({current:null}),Popover:'popover',PopoverHeading:'heading',
  };
  const active=new Map<string,{hooks:ReturnType<typeof preparationFixture>;item:any;view:Node[]}>();
  runInNewContext(ts.transpileModule(source+'\nexports.Bucket=Bucket;exports.HeatmapPreview=HeatmapPreview;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const preview=new context.exports.HeatmapPreview();
  const panel={current:{}};
  for(const key of ['a','b'])active.set(key,{hooks:preparationFixture(),item:{key,date:key,from:0,to:3_600_000,cell:{agentMs:1},x:0,y:0,width:10,height:10,dayRange:{from:0,to:86_400_000}},view:[]});
  const render=()=>{for(const cell of active.values()){Object.assign(context,cell.hooks,{useSyncExternalStore:(_listen:unknown,read:()=>unknown)=>read()});cell.hooks.begin();cell.view=nodes(context.exports.Bucket({item:cell.item,span:3_600_000,zone:'UTC',tab:true,selected:false,focus:()=>{},openRange:()=>{},panel,onKey:()=>{},preview}));cell.hooks.commit();}};
  const cell=(key:string)=>active.get(key)!.view,root=(key:string)=>cell(key).find(n=>n.props.role==='gridcell')!,popover=(key:string)=>cell(key).find(n=>n.type==='popover')!;
  const descriptions=()=>[...active.values()].flatMap(c=>c.view).filter(n=>n.props.role==='tooltip').length;
  render();
  root('a').props.onPointerEnter({pointerType:'mouse'});render();assert.equal(descriptions(),1);
  popover('b').props.buttonProps.onFocus({currentTarget:{matches:()=>true}});render();
  assert.equal(descriptions(),1,'keyboard focus replaces the old pointer description');
  popover('b').props.onOpenChange(true);render();
  assert.equal(descriptions(),0,'an open detail suppresses every hover or focus preview');
  root('a').props.onPointerEnter({pointerType:'mouse'});render();assert.equal(descriptions(),0);
  popover('b').props.onOpenChange(false);render();assert.equal(descriptions(),0,'closing does not resurrect an old interaction');
  root('a').props.onPointerEnter({pointerType:'touch'});render();assert.equal(descriptions(),0,'touch reads through the detail, without a hover preview');
  popover('a').props.buttonProps.onFocus({currentTarget:{matches:()=>false}});render();assert.equal(descriptions(),0,'touch focus never opens a second preview');
  const notifications:string[]=[],stops=['a','b',...Array.from({length:100},(_,i)=>'other'+i)].map(key=>preview.subscribe(key,()=>notifications.push(key)));
  root('a').props.onPointerEnter({pointerType:'mouse'});render();
  popover('b').props.buttonProps.onFocus({currentTarget:{matches:()=>true}});render();
  root('a').props.onPointerLeave();render();assert.equal(descriptions(),1,'an old pointer leaving cannot dismiss the keyboard description');
  assert.deepEqual(notifications,['a','a','b'],'only the former and new descriptions hear an interaction');
  root('a').props.onPointerMove({pointerType:'mouse'});render();
  assert.equal(cell('a').filter(n=>n.props.role==='tooltip').length,1,'moving within the old hovered cell takes ownership back from the keyboard');
  assert.equal(cell('b').filter(n=>n.props.role==='tooltip').length,0);
  popover('b').props.onOpenChange(true);render();preview.retire('b');active.delete('b');
  root('a').props.onPointerEnter({pointerType:'mouse'});render();assert.equal(descriptions(),1,'retiring an open cell releases its preview suppression');
  stops.forEach(stop=>stop());
});
