import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {seriesFocusStyle} from '../components/seriesFocus';

export function arbiter(modules:Record<string,unknown>={}) {
  const properties=new Map<string,string>(),events=new Map<string,(event:any)=>void>(),globalEvents=new Map<string,(event:any)=>void>(),timers=new Map<number,()=>void>();
  let writes=0,phase=()=>{},shift=false,active:number|null=null,folding=false,changed=()=>{},observing=false;
  class Button {
    dataset:Record<string,string>;pressed='false';visible=true;attached=true;isConnected=true;
    constructor(key:string){this.dataset={seriesKey:key};}
    closest(){return this;}contains(target:unknown){return target===this;}getAttribute(){return this.pressed;}setAttribute(_key:string,value:string){this.pressed=value;}matches(){return this.visible;}
  }
  const buttons=[new Button('source@window'),new Button('Group 😀'),new Button('third')], [a,b,c]=buttons;
  const root={querySelector:()=>folding?{}:null,querySelectorAll:()=>buttons.filter(button=>button.attached),contains:(button:Button)=>button.attached,
    style:{setProperty:(key:string,value:string)=>{writes++;properties.set(key,value);},removeProperty:(key:string)=>{writes++;properties.delete(key);}},
    addEventListener:(name:string,run:(event:any)=>void)=>events.set(name,run),removeEventListener:(name:string)=>events.delete(name)};
  const phaseState={active:()=>active,shifting:()=>shift,onPhase:(run:()=>void)=>{phase=run;return()=>{};}};
  const context={exports:{} as {useSeriesFocus:(...args:any[])=>any;SeriesFocus:new()=>{attach:(panel:unknown,phase:unknown)=>()=>void;get:()=>string|null;refresh:()=>void;reset:()=>void;dismiss:()=>void;subscribe:(run:()=>void)=>()=>void}},Element:Button,require:(name:string)=>modules[name]??(name==='../lib/pan'?{pan:phaseState}:{}),
    setTimeout:(run:()=>void)=>{timers.set(1,()=>{timers.delete(1);run();});return 1;},clearTimeout:(id:number)=>timers.delete(id),
    addEventListener:(name:string,run:(event:any)=>void)=>globalEvents.set(name,run),removeEventListener:(name:string)=>globalEvents.delete(name),
    MutationObserver:class{constructor(run:()=>void){changed=run;}observe(){observing=true;}disconnect(){observing=false;}}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/seriesFocus.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const controller=new context.exports.SeriesFocus(),cleanup=controller.attach(root,{active:()=>active,shifting:()=>shift,onPhase:(run:()=>void)=>{phase=run;return()=>{};}});
  const send=(type:string,target:Button|null,relatedTarget:Button|null=null,pointerType='mouse')=>events.get(type)!({type,target,relatedTarget,pointerType});
  const multiplier=(key:string)=>{
    const value=seriesFocusStyle(key)['--series-focus' as keyof ReturnType<typeof seriesFocusStyle>] as string;
    const variable=value.match(/var\((--series-[\w-]+)/)![1];return Number(properties.get(variable)??properties.get('--chart-focus')??1);
  };
  return {a,b,c,buttons,controller,cleanup,properties,events,globalEvents,timers,send,root,hook:context.exports.useSeriesFocus,
    click:(button:Button)=>send('click',button),hover:(button:Button)=>send('pointerover',button),leave:()=>send('pointerout',a),
    matrix:()=>buttons.filter(button=>button.attached).map(button=>multiplier(button.dataset.seriesKey)),
    shift:(value:boolean)=>{shift=value;phase();},pan:(value:number|null)=>{active=value;phase();},fold:(value:boolean)=>{folding=value;changed();},
    get writes(){return writes;},get observing(){return observing;}};
}
