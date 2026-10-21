import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

test('a descendant ellipsis opens complete details even when the bounded wrapper itself fits',()=>{
  let cursor=0,measure=()=>{};const slots:any[]=[];
  const child={clientHeight:20,clientWidth:100,scrollHeight:20,scrollWidth:500},content={clientHeight:38,clientWidth:100,scrollHeight:38,scrollWidth:100,querySelectorAll:()=>[child]};
  const root={closest:()=>null},hooks={useState:(initial:unknown)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:unknown)=>{slots[at]=next;}];},useRef:(_initial:unknown)=>{const at=cursor++;return slots[at]??(slots[at]={current:at===0?root:content});},useLayoutEffect:(run:()=>void)=>run()};
  const Popover=()=>null,modules:Record<string,unknown>={react:hooks,'react/jsx-runtime':jsx,'./Popover':{Popover},'../i18n':{t:()=> 'Complete cell details'}};
  const context={exports:{} as typeof import('../components/TablePreview'),require:(name:string)=>modules[name],ResizeObserver:class{constructor(run:()=>void){measure=run;}observe(){}disconnect(){}}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/TablePreview.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const children=jsx.jsx('button',{className:'agents-open',children:'A complete project name'});
  const render=()=>{cursor=0;return context.exports.TablePreview({children,label:'Project'});};
  render();const full=render();const popup=full.props.children[1];assert.equal(popup.type,Popover);assert.equal(popup.props.children.props.children,children,'the disclosure retains all content and accessible actions');
  child.scrollWidth=100;measure();assert.equal(render().props.children[1],false,'ordinary cells need no extra control');
});
