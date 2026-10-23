import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Pan} from '../lib/pan';
import {Preparations,prepare} from '../lib/prepare';
import {navigationAt,navigationKey,axisNavigation} from '../lib/axisNavigation';
import {activityScale} from '../lib/activity';
import {StackPaths} from '../lib/stackPaths';
import {clock,shortDay,workHours} from '../lib/format';
import {cellStart,targetOf} from '../../server/domain/history';
import {plotTarget, plotBar} from '../lib/historyPlot';
import {tickKeyframes,tickVisible,tickPresentation} from '../lib/axisTicks';
import {niceTicks,timeTickWords} from '../lib/periods';
const M=60000,H=3600000;
const source=(file:string)=>readFileSync(new URL('../../'+file,import.meta.url),'utf8');
function section(text:string,start:string,end?:string){
 const from=text.indexOf(start),to=end===undefined?text.length:text.indexOf(end,from+start.length);
 assert.ok(from>=0&&to>from,`required production section: ${start} → ${end??'EOF'}`);
 return text.slice(from,to);
}
/** Mount the actual chart hooks and DOM painters; keep RAF and React commits independent. */
export function activityAxisFixture(live:boolean,scenario:{range?:{from:number;to:number};periodMs?:number;now?:number;cells?:[number,number][];landmarks?:number[];warmup?:boolean}={}){
 let selected:any=live?null:scenario.range??{from:9*M,to:11*M},dirty=true,index=0,renderCount=0,now=scenario.now??100*M,nextFrame=0,tree:any=null,flushCause='initial';
 const periodMs=scenario.periodMs??2*M,initialFrom=selected?.from??now-periodMs,initialTo=selected?.to??now;
 const states:any[]=[],effects:Function[]=[],tasks:Function[]=[],rafs=new Map<number,Function>(),commits:any[]=[],trace:any[]=[];
 const scheduler=new Preparations({now:()=>0,post:(run:Function)=>tasks.push(run)});
 const useRef=(current:any)=>states[index++]??(states[index-1]={current});
 const useState=(initial:any)=>{const at=index++;if(!(at in states))states[at]=typeof initial==='function'?initial():initial;return [states[at],(value:any)=>{const next=typeof value==='function'?value(states[at]):value;if(!Object.is(next,states[at])){states[at]=next;dirty=true;trace.push({event:'setState',cause:flushCause});}}];};
 const useLayoutEffect=(effect:Function,deps?:any[])=>{const at=index++,old=states[at];if(deps&&old?.deps&&deps.length===old.deps.length&&deps.every((v,i)=>Object.is(v,old.deps[i])))return;effects.push(()=>{old?.stop?.();states[at]={deps,stop:effect()};});};
 const useMemo=(read:Function,deps:any[])=>{const slot=useRef(null);if(!slot.current||deps.some((v,i)=>!Object.is(v,slot.current.deps[i])))slot.current={deps,value:read()};return slot.current.value;};
 const useSyncExternalStore=(subscribe:Function,get:Function)=>{useLayoutEffect(()=>subscribe(()=>{dirty=true;trace.push({event:'external-store',cause:flushCause});}),[subscribe]);return get();};
 const props:any={history:null,detailFrame:null,renderDetails:()=>({summary:null,legend:null}),activity:{barMs:M,cells:[],by:{source:[]}},origin:initialFrom,groups:[],paint:new Map([['s','red']]),registry:null,from:initialFrom,to:initialTo,unknownTo:null,onSelect:()=>{},plot:300,onBase:()=>{},strip:null,prepared:true,authority:0,navigation:{context:'test',range:live?'live':`${selected.from}-${selected.to}`},by:'source',empty:null};
 const cells=scenario.cells??(live?[[97*M,12*H],[98*M,H],[99*M,H]]:[[9*M,H],[10*M,H],[11*M,H],[12*M,12*H]]);
 props.groups=[{group:{key:'s',name:'S',cells},name:'S',color:'red'}];props.activity.by.source=[props.groups[0].group];props.currentActivity=props.activity;
 const frame=(run:Function)=>{rafs.set(++nextFrame,run);return nextFrame;};
 const choose=(range:any)=>{selected=range;props.from=range?.from??now-periodMs;props.to=range?.to??now;props.navigation={context:'test',range:range?`${range.from}-${range.to}`:'live'};dirty=true;};
 const pan=new Pan({now:()=>now,commit:(range:any)=>{commits.push(range);choose(range);},requestFrame:frame,cancelFrame:id=>rafs.delete(id as number),setTimeout:()=>null,clearTimeout:()=>{}});
 class Host {
  tag:string;props:any={};children:Host[]=[];parent:Host|null=null;style:any={};dataset:any={};attrs=new Map<string,string>();textContent='';isConnected=true;
  constructor(tag:string){this.tag=tag;}
  get firstElementChild(){return this.children[0];}
  get classList(){const node=this;return {contains:(name:string)=>(node.attrs.get('class')??'').split(' ').includes(name),add:(name:string)=>{if(!this.classList.contains(name))this.attrs.set('class',((this.attrs.get('class')??'')+' '+name).trim());},remove:(name:string)=>this.attrs.set('class',(this.attrs.get('class')??'').split(' ').filter(x=>x!==name).join(' ')),toggle:(name:string,on:boolean)=>on?this.classList.add(name):this.classList.remove(name)};}
  setAttribute(name:string,value:string){this.attrs.set(name,value);}
  getAttribute(name:string){return this.attrs.get(name)??null;}
  hasAttribute(name:string){return this.attrs.has(name);}
  removeAttribute(name:string){this.attrs.delete(name);}
  pointers=new Set<number>();
  addEventListener(){}removeEventListener(){}setPointerCapture(id:number){this.pointers.add(id);}hasPointerCapture(id:number){return this.pointers.has(id);}releasePointerCapture(id:number){this.pointers.delete(id);}getBoundingClientRect(){return {width:400,left:0,right:400};}getComputedTextLength(){return this.textContent.length*7;}getAnimations(){return [];}
  matches(selector:string):boolean{const match=selector.match(/^(\w+)?(?:\.([\w-]+))?$/);if(match)return (!match[1]||match[1]===this.tag)&&(!match[2]||this.classList.contains(match[2]));const attr=selector.match(/^\[([^\]]+)\]$/);return !!attr&&this.hasAttribute(attr[1]);}
  querySelectorAll(selector:string):Host[]{const parts=selector.split(' ');const all=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);if(selector==='*')return all;return all.filter(node=>{if(!node.matches(parts.at(-1)!))return false;let parent=node.parent;for(let i=parts.length-2;i>=0;i--){while(parent&&!parent.matches(parts[i]))parent=parent.parent;if(!parent)return false;parent=parent.parent;}return true;});}
  querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
 }
 const hosts=new Map<string,Host>(),Fragment=Symbol('Fragment');
 const createElement=(type:any,props:any,...children:any[])=>({type,props:{...props,children:children.length===1?children[0]:children}});
 function commitHost(node:any,path:string,parent:Host|null):Host[]{
  if(node==null||node===false)return [];if(Array.isArray(node))return node.flatMap((n,i)=>commitHost(n,path+'.'+(n?.props?.key??i),parent));if(typeof node==='string'||typeof node==='number')return [];
  if(node.type===Fragment)return commitHost(node.props.children,path+'.fragment',parent);
  if(typeof node.type==='function')return commitHost(node.type(node.props),path+'.fn',parent);
  const host=hosts.get(path)??new Host(node.type);hosts.set(path,host);host.parent=parent;const old=host.props,p=node.props;
  for(const [key,value]of Object.entries(p)){if(key==='children'||key==='ref'||key==='key'||key.startsWith('on'))continue;if(key==='style'){for(const [k,v]of Object.entries(value as object??{}))if(!Object.is(old.style?.[k],v))host.style[k]=v;continue;}if(Object.is(old[key],value))continue;if(value==null||value===false)host.removeAttribute(key==='className'?'class':key);else host.setAttribute(key==='className'?'class':key,String(value));if(key.startsWith('data-'))host.dataset[key.slice(5).replace(/-([a-z])/g,(_a,b)=>b.toUpperCase())]=String(value);}
  const text=(v:any):string=>Array.isArray(v)?v.map(text).join(''):typeof v==='string'||typeof v==='number'?String(v):'';
  const nextText=text(p.children);if(nextText!==text(old.children))host.textContent=nextText;
  host.children=commitHost(p.children,path+'.children',host);host.props=p;if(p.ref){if(typeof p.ref==='function')p.ref(host);else p.ref.current=host;}return [host];
 }
 const hooks={useRef,useState,useLayoutEffect,useEffect:useLayoutEffect,useMemo,useSyncExternalStore};
 const context:any={...hooks,React:{createElement,Fragment},memo:(fn:any)=>fn,useId:()=>useRef('id').current,pan,usePanning:()=>useSyncExternalStore(pan.onPhase,pan.active),useShifting:()=>useSyncExternalStore(pan.onPhase,pan.shifting),hubNow:()=>now,timeRange:()=>selected,periodOf:()=>({ms:periodMs}),prefs:()=>({range:'2m'}),useHistoryBegins:()=>0,useSizing:()=>({width:'400'}),axisNavigation,navigationAt,navigationKey,tickKeyframes,tickVisible,tickPresentation,requestAnimationFrame:frame,cancelAnimationFrame:(id:number)=>rafs.delete(id),ResizeObserver:class{observe(){}disconnect(){}},document:{timeline:{currentTime:0},fonts:{addEventListener(){},removeEventListener(){}}},window:{},matchMedia:()=>({matches:true}),performance:{now:()=>0},useLocale:()=> 'en',useTip:()=>({tip:{current:null},style:{}}),activityScale,stacksHeight:()=>160,StackPaths,niceTicks,timeTickWords,MINUTE:M,cellStart,plotBar,plotTarget,targetOf,seriesFocusStyle:()=>({}),activitySeriesKey:(_by:string,key:string)=>key,workHours,clock,shortDay,stamp:()=>'',t:(key:string)=>key,CSS:{escape:(s:string)=>s},getComputedStyle:()=>({transform:'none'}),slideOf:null};
 const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText;
 context.exports={};context.require=(name:string)=>name==='react'?hooks:{prepare:(owner:any,work:any,valid:any,ready:any)=>prepare(owner,work,valid,ready,scheduler),preparations:()=>scheduler};
 runInNewContext(compile(source('ui/components/prepared.ts')),context);Object.assign(context,context.exports);
 const axis=source('ui/components/timeAxis.ts');runInNewContext(compile(section(axis,'const HOLD_MS','export type DrawingGeometry')+section(axis,'export function slideOf').replace('export function slideOf','function slideOf').replace('export function useTimeAxis','function useTimeAxis')+'\nglobalThis.useTimeAxis=useTimeAxis;'),context);
 const layers=source('ui/components/PlotLayer.tsx');runInNewContext(compile(section(layers,'export function PlotLayer').replaceAll('export function','function')+'\nglobalThis.PlotLayer=PlotLayer;globalThis.PlotOverlay=PlotOverlay;globalThis.clipPlot=clipPlot;'),context);
 const activity=section(source('ui/components/Activity.tsx'),'const StackArtwork = memo(function StackArtwork(');
 assert.ok(activity.includes('const Stacks = memo(function Stacks('),'the artwork and its actual chart consumer are loaded together');
 runInNewContext(compile(activity+'\nglobalThis.Stacks=Stacks;'),context);
 function flush(){let count=0;while(dirty){if(count++>50)throw Error('render loop');dirty=false;index=0;effects.length=0;const vnode=context.Stacks(props);tree=commitHost(vnode,'root',null)[0];effects.splice(0).forEach(run=>run());renderCount++;}}
 function settle(){for(let count=0;count<1000&&(dirty||tasks.length);count++){flush();while(tasks.length)tasks.shift()!();}assert.ok(!dirty&&!tasks.length);}
 const required=<T,>(value:T|null|undefined,label:string):T=>{assert.ok(value!==null&&value!==undefined,`required production node: ${label}`);return value;};
 const band=()=>required<Host>(tree.querySelector('path.activity-stack')?.parent?.parent,'activity value band');
 function snapshot(label:string){
  const transform=band().getAttribute('transform'),ratio=Number(transform?.match(/scale\(1 ([^)]+)\)/)?.[1]??1);
  const path=required<string>(tree.querySelector('path.activity-stack')?.getAttribute('d'),'prepared stack path');
  const ys=required<Host>(tree.querySelector('.activity-value-axis'),'activity value axis').children.map(row=>required(row.querySelector('text'),'value label').textContent);
  const axis=required<Host>(tree.querySelector('svg'),'chart SVG'),main=required<Host>(tree.querySelector('[data-plot-main]'),'main movement owner'),slides=required(main.querySelector('.slides'),'main slides');
  const matrix=slides.style.transform??'',a=Number(matrix.match(/scaleX\(([-.\d]+)\)/)?.[1]??1),b=Number(matrix.match(/translateX\(([-.\d]+)px\)/)?.[1]??0),offset=Number(main.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1]??0);
  const drawFrom=Number(axis.dataset.drawFrom),drawTo=Number(axis.dataset.drawTo);assert.ok(Number.isFinite(drawFrom)&&Number.isFinite(drawTo),'the actual axis committed its drawing bounds');
  const landmarks=(scenario.landmarks??[live?98*M:10*M,live?99*M:11*M]).map(at=>a*(48+(at-drawFrom)/Math.max(M,drawTo-drawFrom)*340)+b+offset);
  const timeTicks=required<Host>(tree.querySelector('.time-ticks'),'time labels').children.map(node=>({at:Number(node.props.key),text:node.textContent,position:Number(node.getAttribute('x'))+Number(node.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1]??0)+offset,visible:node.style.visibility!=='hidden'}));
  const unknown=tree.querySelector('.activity-unknown rect'),hatch=unknown?{x:Number(unknown.getAttribute('x')),width:Number(unknown.getAttribute('width'))}:null;
  const mask=tree.querySelector('clipPath rect'),maskBounds=mask?{from:a*Number(mask.getAttribute('x'))+b+offset,to:a*(Number(mask.getAttribute('x'))+Number(mask.getAttribute('width')))+b+offset}:null;
  const clip=required<Host>(tree.querySelector('.is-band'),'stationary band clip'),crop=clip.firstElementChild!,next=crop.firstElementChild!;
  const shift=(node:Host)=>Number(node.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1]??0),inset=parseFloat(clip.style.left),clipSpan=400-inset-parseFloat(clip.style.right);
  const bandBounds={from:inset+shift(crop),to:inset+shift(crop)+shift(next)+clipSpan,visible:clip.style.visibility!=='hidden'};
  const lowTop=Number([...path.matchAll(/M[^,]*,([-.\d]+)/g)][live?1:0]?.[1]??NaN);assert.ok(Number.isFinite(lowTop),'the measured stack has a real path landmark');
  const inverse=(px:number)=>drawFrom+((px-offset-b)/a-48)/340*Math.max(M,drawTo-drawFrom);
  const viewport={from:inverse(48),to:inverse(388)};
  const originShift=Number(tree.querySelector('path.activity-stack')?.parent?.getAttribute('transform')?.match(/translate\(([-.\d]+)/)?.[1]??0);
  const bars=[...path.matchAll(/M([-.\d]+),([-.\d]+)[HL]([-.\d]+)/g)].map(match=>({from:a*(originShift+Number(match[1]))+b+offset,to:a*(originShift+Number(match[3]))+b+offset,x:a*(originShift+(Number(match[1])+Number(match[3]))/2)+b+offset,y:272+(Number(match[2])-272)*ratio}));
  const edgePaths=tree.querySelectorAll('path.activity-stack').slice(1).map((node:Host)=>node.getAttribute('d')??'');
  const lowBarY=272+(lowTop-272)*ratio;return {label,transform,ratio,labels:ys,landmarks,timeTicks,hatch,viewport,bars,bandBounds,maskBounds,edgePaths,lowBarY,path,preparing:scheduler.size,tasks:tasks.length,panEnd:axis.dataset.panEnd,drawReady:axis.dataset.drawReady,renderCount,pendingRender:dirty,rafs:rafs.size,selected};
 }
 function runFrame(){flushCause='RAF';const callbacks=[...rafs.values()];rafs.clear();callbacks.forEach(run=>run());return snapshot('after-native-RAF-before-React');}
 function begin(){flushCause='begin';const length=selected?selected.to-selected.from:periodMs;return pan.begin({source:Symbol('input'),input:'pointer',selected,length,now,historyStart:0,span:length,width:340})!;}
 const pointerEvent=(x:number)=>({shiftKey:true,pointerType:'mouse',button:0,clientX:x,pointerId:1,currentTarget:tree,target:tree,preventDefault(){}});
 const pointerDown=(x=200)=>{tree.props.onPointerDown(pointerEvent(x));return required(pan.active(),'actual pointer gesture');};
 const pointerMove=(x:number)=>tree.props.onPointerMove(pointerEvent(x));
 const pointerUp=(x=200)=>tree.props.onPointerUp(pointerEvent(x));
 settle();
 if(!live&&scenario.warmup!==false){const token=begin();flush();pan.move(token,170);runFrame();settle();flushCause='finish';pan.finish(token);flush();runFrame();settle();assert.equal(selected.from,10*M);}
 return {pan,choose,begin,pointerDown,pointerMove,pointerUp,flush,settle,runFrame,snapshot,props,commits,trace,stageModel:()=>{props.groups=props.groups.map((row:any)=>({...row,group:{...row.group,cells:[...row.group.cells]}}));dirty=true;},parentUpdate:()=>{dirty=true;},setCause:(name:string)=>flushCause=name,pendingFrames:()=>[...rafs.values()]};
}
