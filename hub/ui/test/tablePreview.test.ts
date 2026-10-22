import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

test('a descendant ellipsis opens complete details even when the bounded wrapper itself fits',()=>{
  let cursor=0,measure=()=>{},scans=0;const slots:any[]=[];
  const child={closest:()=>null,clientHeight:20,clientWidth:100,scrollHeight:20,scrollWidth:500},assistive={closest:()=>({}),clientHeight:1,clientWidth:1,scrollHeight:20,scrollWidth:500},content={closest:()=>null,clientHeight:38,clientWidth:100,scrollHeight:38,scrollWidth:100,querySelectorAll:()=>{scans++;return [child,assistive];}};
  const root={closest:()=>null},hooks={useState:(initial:unknown)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:unknown)=>{slots[at]=next;}];},useRef:(_initial:unknown)=>{const at=cursor++;return slots[at]??(slots[at]={current:at===0?root:content});},useLayoutEffect:(run:()=>void)=>run()};
  const Popover=()=>null,modules:Record<string,unknown>={react:hooks,'react/jsx-runtime':jsx,'./Popover':{Popover},'../i18n':{t:()=> 'Complete cell details'}};
  const context={exports:{} as typeof import('../components/TablePreview'),require:(name:string)=>modules[name],ResizeObserver:class{constructor(run:()=>void){measure=run;}observe(){}disconnect(){}}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/TablePreview.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const children=jsx.jsx('button',{className:'agents-open',children:'A complete project name'});
  const render=()=>{cursor=0;return context.exports.TablePreview({children,label:'Project'});};
  render();const full=render();const popup=full.props.children[1];assert.equal(popup.type,Popover);assert.equal(popup.props.children.props.children,children,'the disclosure retains all content and accessible actions');
  child.scrollWidth=100;measure();assert.equal(render().props.children[1],false,'screen-reader-only labels do not add a disclosure to an ordinary cell');
  const before=scans;content.clientHeight=0;child.scrollWidth=500;measure();render();
  assert.equal(scans,before,'a hidden widget never scans and measures its descendants');
  content.clientHeight=38;measure();assert.equal(render().props.children[1].type,Popover,'becoming visible restores complete details');
});

test('fitting semantic details resolve the portal after the first DOM commit',()=>{
 let cursor=0,dirty=false;const slots:any[]=[],effects:(()=>void)[]=[],panel={owner:'panel'};
 const domRoot={closest:()=>panel},domContent={closest:()=>null,clientHeight:20,clientWidth:100,scrollHeight:20,scrollWidth:100,querySelectorAll:()=>[]};
 const hooks={useRef:(current:any)=>{const i=cursor++;return slots[i]??(slots[i]={current});},useState:(initial:any)=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(next:any)=>{dirty||=!Object.is(slots[i],next);slots[i]=next;}];},useLayoutEffect:(run:any)=>effects.push(run)};
 const jsx=(type:any,props:any)=>({type,props});
 const context:any={exports:{},ResizeObserver:class{observe(){}disconnect(){}},require:(name:string)=>name==='react'?hooks:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='./Popover'?{Popover:'popover'}:{t:()=> 'Details'}};
 let source=readFileSync(new URL('../components/TablePreview.tsx',import.meta.url),'utf8');

 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 const render=()=>{cursor=0;return context.exports.TablePreview({children:'123.46 USD',label:'Amount',details:'123.456789 USD'});};
 const first=render();assert.equal(first.props.children[0].props.children.props.portal,undefined);
 first.props.ref.current=domRoot;first.props.children[0].props.ref.current=domContent;
 effects.splice(0).forEach(run=>run());
 assert.ok(dirty,'a fitting semantic cell must publish its committed panel before the first interaction');
 const next=render();assert.equal(next.props.children[0].props.children.props.portal,panel,'the Popover must escape bounded content overflow on its first open');
});
