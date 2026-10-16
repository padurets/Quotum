import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

type FocusTarget={name:string;isConnected:boolean;focus:()=>void};

function fixture() {
  const effects:(()=>void|(()=>void))[]=[];
  const layers:{overlay:{inert:boolean};frame:{inert:boolean}}[]=[];
  let panel:any;
  const target=(name:string):FocusTarget=>({name,isConnected:true,focus(){document.activeElement=this;}});
  const body=target('body'),trigger=target('trigger'),row=target('row'),root={inert:false};
  const document={activeElement:body,body,documentElement:{style:{overflow:''}},getElementById:()=>root,addEventListener(){},removeEventListener(){}};
  const jsx=(type:unknown,props:any)=>{if(props?.role==='dialog')props.ref.current=panel;return {type,props};};
  const context={document,exports:{} as {Modal:(props:any)=>unknown},require:(name:string)=>{
    if(name==='react')return {useRef:(current:unknown)=>({current}),useState:(initial:()=>unknown)=>[initial()],useLayoutEffect:(effect:typeof effects[number])=>effects.push(effect)};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='react-dom')return {createPortal:(value:unknown)=>value};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    return {};
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Kit.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const mount=()=>{
    const overlay={inert:false};
    const frame={inert:false};
    layers.push({overlay,frame});
    const own:any={...target('dialog'),parentElement:frame,closest:(selector:string)=>{assert.equal(selector,'.overlay');return overlay;},contains:(value:unknown)=>value===own,querySelector:()=>null,querySelectorAll:()=>[]};
    panel=own;
    context.exports.Modal({title:'Details',children:null,restore:()=>row});
    const cleanup=effects.shift()!() as ()=>void;
    return()=>{own.isConnected=false;cleanup();};
  };
  return {body,trigger,row,root,document,mount,layers};
}

test('a contextual dialog returns to its object row when navigation left focus on the body',()=>{
  const f=fixture(),close=f.mount();close();
  assert.equal(f.document.activeElement,f.row);
  assert.equal(f.root.inert,false);
});

test('a dialog preserves its connected opener instead of replacing it with the fallback',()=>{
  const f=fixture();f.document.activeElement=f.trigger;
  const close=f.mount();close();
  assert.equal(f.document.activeElement,f.trigger);
});

test('discarding nested contextual dialogs restores their object after both close',()=>{
  const f=fixture(),closeDetails=f.mount(),closeConfirmation=f.mount();
  closeDetails();closeConfirmation();
  assert.equal(f.document.activeElement,f.row);
  assert.equal(f.root.inert,false);
});

test('nested dialogs block the whole lower overlay and restore it when the top closes',()=>{
  const f=fixture(),closeDetails=f.mount(),details=f.document.activeElement,closeConfirmation=f.mount();
  assert.equal(f.layers[0].overlay.inert,true);
  assert.equal(f.layers[0].frame.inert,false);
  assert.equal(f.layers[1].overlay.inert,false);
  closeConfirmation();
  assert.equal(f.layers[0].overlay.inert,false);
  assert.equal(f.document.activeElement,details);
  assert.equal(f.root.inert,true);
  closeDetails();
  assert.equal(f.root.inert,false);
});
