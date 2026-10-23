import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {nodeOf,rendered,NODES} from '../../bench/probe';
import {nameRenderer} from './nameFixture';

const Fragment=Symbol('Fragment'),jsx=(type:any,props:any)=>({type,props:props??{}});
let now=1000,clockReads=0;
const clockEnabled:boolean[]=[];
const hooks={Fragment,useMemo:(read:()=>unknown)=>read(),useRef:(current:unknown)=>({current}),useState:(initial:any)=>[typeof initial==='function'?initial():initial,()=>{}],useLayoutEffect:()=>{}};
function load(file:string,modules:Record<string,unknown>){
  const context={exports:{} as any,require:(name:string)=>{assert.ok(name in modules,name);return modules[name];}};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.exports;
}
const runtime={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment}},popover={Popover:()=>null,HideRow:()=>null,SlidersIcon:()=>null,SwitchRow:()=>null};
const cells=load('../components/TableCell.tsx',{...runtime,'../lib/clock':{hubNow:()=>now,useClock:(changesAt:(at:number)=>number|null,_context:unknown,enabled=true)=>{
  clockEnabled.push(enabled);if(enabled)clockReads++;else assert.equal(changesAt(now),null,'a static cell has no clock deadline');return now;
}}});
const previews=load('../components/TablePreview.tsx',{...runtime,'./Popover':popover,'../i18n':{t:(key:string)=>key}});
const tables=load('../components/AnalyticsTable.tsx',{...runtime,'./Kit':{Name:nameRenderer(runtime['react/jsx-runtime'])},'../lib/view':{},'../i18n':{t:(key:string)=>key},'./Popover':popover,'./TableWidget':{TableHeading:()=>null},'./TableCell':cells,'./TablePreview':previews});

class Host {
  constructor(readonly tag:string,readonly props:any,readonly parent:Host|null){}
  hasAttribute(name:string){return this.props[name]!==undefined&&this.props[name]!==null;}
  getAttribute(name:string){return this.hasAttribute(name)?String(this.props[name]):null;}
  closest(selector:string):Host|null {
    for(let node:Host|null=this;node;node=node.parent)if(selector.split(',').some(value=>{
      value=value.trim();if(value==='[data-time]')return node!.hasAttribute('data-time');
      const [tag,...classes]=value.split('.');return (!tag||tag===node!.tag)&&classes.length>0&&classes.every(name=>(node!.props.className??'').split(/\s+/).includes(name));
    }))return node;return null;
  }
}

// Execute actual cells and wrappers, then use the benchmark's own host attribution.
// Marking the whole row or table would incorrectly admit the static-cell control.
for(const layout of ['list','table'] as const)for(const still of [false,true])for(const at of [1000,2000])test(`${layout} ${still?'measurement':'visible'} cell clock boundary at ${at}`,()=>{
  now=at;clockReads=0;clockEnabled.length=0;
  const all:any[]=[],hostRoot=new Host('section',{className:'panel forecast'},null),root:any={tag:5,flags:0,stateNode:hostRoot,child:null,sibling:null,return:null,alternate:null};
  const build=(element:any,parent:any,hostParent:Host):any=>{
    if(element==null||typeof element==='boolean')return null;
    if(Array.isArray(element)){let first:any=null,last:any=null;for(const child of element){const next=build(child,parent,hostParent);if(next){if(last)last.sibling=next;else first=next;last=next;while(last.sibling)last=last.sibling;}}return first;}
    if(typeof element!=='object')return {tag:6,flags:0,stateNode:null,child:null,sibling:null,return:parent,alternate:null};
    const host=typeof element.type==='string',component=typeof element.type==='function';
    const fiber:any={tag:host?5:component?0:7,flags:component?1:0,stateNode:host?new Host(element.type,element.props,hostParent):null,child:null,sibling:null,return:parent,alternate:null,type:element.type,props:element.props};all.push(fiber);
    fiber.child=build(component?element.type(element.props):element.props.children,fiber,host?fiber.stateNode:hostParent);return fiber;
  };
  const timed=(time:string)=>({time,changesAt:(at:number)=>at+1000,at:(at:number)=>({content:at<2000?'2m':'1m'})});
  root.child=build(jsx(tables.AnalyticsTable,{columns:[{id:'now',title:'Now',width:100},{id:'forecast',title:'Forecast',width:100},{id:'static',title:'Static',width:100}],rows:[{key:'fixture',name:'Fixture',cells:{now:timed('lead-clock'),forecast:timed('detail-clock'),static:{content:'Unchanged'}}}],name:'Limit',lead:'now',layout,still}),root,hostRoot);
  const wrappers=all.filter(fiber=>fiber.type?.name==='Timed');
  const clocks=wrappers.filter(fiber=>'at' in fiber.props.cell),staticCells=wrappers.filter(fiber=>!('at' in fiber.props.cell));
  assert.equal(wrappers.length,still?0:3,'visible cells preserve their hook boundary across changing evidence');
  assert.equal(clocks.length,still?0:2);assert.equal(clockReads,still?0:2);
  assert.deepEqual(clockEnabled,still?[]:[true,true,false],'only the two timed cells enable clock subscriptions');
  for(const fiber of staticCells)assert.equal(nodeOf(fiber,NODES),hostRoot,'a disabled clock wrapper remains ordinary table data');
  for(const fiber of clocks){
    const time=fiber.props.cell.time;
    assert.ok(rendered(root).includes(fiber));
    assert.equal((nodeOf(fiber,NODES) as Host).getAttribute('data-time'),time,'each time component owns its first host');
    const under=(child:any)=>{for(let node=child.return;node;node=node.return)if(node===fiber)return true;return false;};
    const preview=all.find(child=>under(child)&&child.type===previews.TablePreview);assert.ok(preview);
    assert.equal((nodeOf(preview,NODES) as Host).getAttribute('data-time'),time,'preview rendering stays within that cell');
  }
  const stable=all.find(fiber=>fiber.type===previews.TablePreview&&fiber.props.label==='Static');assert.ok(stable);
  assert.equal(nodeOf(stable,NODES),hostRoot,'ordinary data rendering still belongs to the table');
  if(still)assert.ok(all.every(fiber=>!fiber.stateNode?.hasAttribute('data-time')),'measurement has no time markers');
});
