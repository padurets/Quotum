import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {tableLayout} from '../lib/table';

/** Runs the production table with controlled box reads and observer deliveries. */
function fixture() {
 const source = readFileSync(new URL('../components/AnalyticsTable.tsx', import.meta.url), 'utf8');
 const hooks:any[]=[],pending:any[]=[],observers:any[]=[];let cursor=0,reads=0,styles=0;
 const element=(width:number,left=22,right=22)=>({width,left,right,get clientWidth(){reads++;return this.width;}});
 let root=element(384),columns=[{id:'value',title:'Value',width:120}],nameWidth=240;
 const react={useRef:(initial:any)=>{const index=cursor++;return hooks[index]??= {current:initial};},useState:(initial:any)=>{const index=cursor++;hooks[index]??= {value:initial};return [hooks[index].value,(next:any)=>{hooks[index].value=typeof next==='function'?next(hooks[index].value):next;}];},useLayoutEffect:(run:any,deps:any[])=>{const index=cursor++,was=hooks[index];if(!was||deps.some((value,i)=>value!==was.deps[i])){hooks[index]={deps,cleanup:was?.cleanup};pending.push({index,run});}},Fragment:'fragment'};
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
 const modules: Record<string, unknown> = {'react':react,'react/jsx-runtime':jsx,'../lib/table':{tableLayout},'../lib/clock':{},'../lib/view':{},'../i18n':{},'./Popover':{}};
 const context={exports:{} as any,require:(name:string)=>modules[name],getComputedStyle:(target:any)=>{styles++;return {paddingLeft:String(target.left),paddingRight:String(target.right)};},ResizeObserver:class {targets=new Set();constructor(private readonly run:any){observers.push(this);}observe(target:any){this.targets.add(target);}disconnect(){this.targets.clear();}deliver(){if(this.targets.has(root))this.run([{target:root}],this);}}};
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 const render=()=>{cursor=0;const node=context.exports.AnalyticsTable({columns,rows:[],name:'Name',nameWidth});node.props.ref({parentElement:root});for(const {index,run} of pending.splice(0)){hooks[index].cleanup?.();hooks[index].cleanup=run();}return node;};
 render();
 return {render,get reads(){return reads;},get styles(){return styles;},get root(){return root;},get layout(){return render().type==='ul'?'list':'table';},columns:(width:number)=>{columns=[{id:'value',title:'Value',width}];render();},resize:(width:number,left=22,right=22)=>{root.width=width;root.left=left;root.right=right;observers.forEach(observer=>observer.deliver());},replace:(width:number)=>{root=element(width);},cleanup:()=>hooks.forEach(hook=>hook.cleanup?.()),observers};
}
const checks=[
 ['changed columns fit the previously observed box without another native read',(f:any)=>{assert.equal(f.layout,'table');assert.equal(f.reads,1);f.columns(121);assert.equal(f.layout,'list');assert.equal(f.reads,1);assert.equal(f.styles,1);}],
 ['an observed resize supplies the latest width to later column changes',(f:any)=>{f.resize(500);assert.equal(f.layout,'table');f.columns(240);assert.equal(f.layout,'list');assert.equal(f.reads,2);f.resize(700);assert.equal(f.layout,'table');}],
 ['an unseen replacement keeps the actual-size fallback',(f:any)=>{f.replace(0);f.columns(121);assert.equal(f.layout,'list');assert.equal(f.reads,2);}],
 ['fractional padding retains the exact old threshold',(f:any)=>{f.resize(359,8.25,10.875);assert.equal(f.layout,'list');f.columns(119);assert.equal(f.layout,'table');}],
 ['an observed zero is valid and recovers on a later resize',(f:any)=>{f.resize(0);assert.equal(f.layout,'list');f.columns(0);assert.equal(f.layout,'list');f.resize(400);assert.equal(f.layout,'table');}],
 ['unmount releases every observer',(f:any)=>{f.columns(121);f.cleanup();assert.ok(f.observers.every((observer: {targets: Set<object>})=>observer.targets.size===0));}],
] as const;

for (const [name, check] of checks) test(name, () => {
  const f = fixture();
  try {check(f);} finally {f.cleanup();}
});
