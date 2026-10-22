import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';

type VNode={type:unknown;props:Record<string,any>};
const nodes=(value:any):VNode[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];

/** Explicit DOM ref-detachment phases; native focus and placement are checked on the demo. */
export function focusReturnFixture(header=false,card=false){
  const hooks=preparationFixture(),calls:{name:string;controlled:boolean}[]=[];
  const document={activeElement:null as Element|null};
  let focus:any;
  class Element{
    isConnected=true;disabled=false;hidden=false;inert=false;visibility='visible';
    parent:Element|null=null;children:Element[]=[];
    constructor(readonly name:string,readonly kind:string,parent?:Element){if(parent){this.parent=parent;parent.children.push(this);}}
    contains(element:Element|null):boolean{return !!element&&(element===this||this.children.some(child=>child.contains(element)));}
    closest(selector:string):Element|null{
      const match=(node:Element)=>selector==='[hidden],[inert]'?node.hidden||node.inert:selector==='.'+node.kind||selector.split(',').includes('.'+node.kind);
      return match(this)?this:this.parent?.closest(selector)??null;
    }
    matches(selector:string){return selector===':disabled'&&this.disabled;}
    getClientRects(){return this.hidden?[]:[{}];}
    querySelector(selector:string):Element|null{return selector===':scope > button'?this.children.find(child=>child.kind==='trigger')??null:selector.includes('h2')?heading:null;}
    querySelectorAll(){return [status,disabled,settings,filter].filter(node=>this.contains(node));}
    focus(){document.activeElement=this;calls.push({name:this.name,controlled:focus.isFocusReturn()});}
    remove(){if(this.contains(document.activeElement))document.activeElement=body;const retire=(node:Element)=>{node.isConnected=false;node.children.forEach(retire);};retire(this);if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  }
  const body=new Element('body','body'),panel=new Element('panel',header?'analytics-head-inner':card?'card':'panel',body),heading=new Element('heading','heading',panel);
  const scope=new Element('error scope','reader-state',panel),picker=new Element('picker','picker',scope),trigger=new Element('error trigger','trigger',picker),surface=new Element('surface','surface',picker),retry=new Element('retry','action',surface);
  const status=trigger,disabled=new Element('disabled control','control',panel),settings=new Element('settings','control',panel),filter=new Element('resource filter','control',panel),outside=new Element('outside','control',body);
  disabled.disabled=true;filter.hidden=!header;settings.hidden=header;
  document.activeElement=body;
  const jsx=(type:unknown,props:Record<string,any>)=>({type,props});
  const useCallback=(fn:unknown,deps:readonly unknown[])=>hooks.useMemo(()=>fn,deps);
  const vm=(file:string,modules:Record<string,any>,slice?:(source:string)=>string)=>{
    const context={exports:{} as any,document,getComputedStyle:(element:Element)=>({visibility:element.visibility}),require:(name:string)=>modules[name]};
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(slice?slice(source):source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);return context.exports;
  };
  focus=vm('../components/focusReturn.ts',{react:{...hooks,useCallback}});
  const modules={'react/jsx-runtime':{jsx,jsxs:jsx},'./focusReturn':focus,'./Popover':{Popover:'popover'},'../i18n':{t:(key:string)=>key},'../lib/timeRange':{timeRangeLabel:()=> 'range'}};
  const read=vm('../components/ReadState.tsx',modules).ReadState;
  let oldScope:VNode|undefined,oldAction:VNode|undefined;
  const detached=new Map<Element,()=>void>();
  const attach=(ref:any,node:Element)=>{if(typeof ref==='function'){const cleanup=ref(node);return typeof cleanup==='function'?cleanup:()=>ref(null);}if(ref){ref.current=node;return()=>{ref.current=null;};}return()=>{};};
  const render=(props:Record<string,unknown>,reverse=false)=>{
    hooks.begin();const tree=read(props),flat=nodes(tree),nextScope=flat.find(node=>node.props.className==='reader-state'),nextAction=flat.find(node=>node.type==='button');hooks.commit();
    const removals:[VNode|undefined,VNode|undefined,Element][]=[[oldScope,nextScope,scope],[oldAction,nextAction,retry]];
    if(reverse)removals.reverse();
    for(const [old,next,node] of removals)if(old&&!next){detached.get(node)?.();detached.delete(node);}
    for(const [old,next,node] of removals)if(old&&!next)node.remove();
    if(nextScope&&!oldScope)detached.set(scope,attach(nextScope.props.ref,scope));if(nextAction&&!oldAction)detached.set(retry,attach(nextAction.props.ref,retry));
    oldScope=nextScope;oldAction=nextAction;return tree;
  };
  return {hooks,document,calls,panel,heading,scope,picker,surface,trigger,retry,settings,filter,outside,render,vm,jsx,focus,attach,node:(name:string,kind:string,parent:Element)=>new Element(name,kind,parent)};
}
