import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('plot allocation follows structural width and locale, independently of data results and legend contents',()=>{
  let cursor=0,locale='en',svg=true,rootHeight=500,chartHeight=300,reads=0,plot:number|undefined;
  const slots:any[]=[],effects:(()=>void)[]=[],cleanups:(()=>void)[]=[],reports:any[]=[],observers:any[]=[];
  const sizing={manual:false,allocated:0,width:'wide',report:(r:any)=>{reports.push(r);}};
  const chart={querySelector:()=>svg?{}:null,getBoundingClientRect:()=>{reads++;return {height:chartHeight};}};
  const root={clientWidth:800,querySelector:()=>chart,getBoundingClientRect:()=>{reads++;return {height:rootHeight};}};
  const panel={current:root};
  const react={createContext:()=>({}),useContext:()=>sizing,
    useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:any)=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];},
    useRef:(value:unknown)=>{const at=cursor++;return slots[at]??(slots[at]={current:value});},
    useCallback:(run:unknown)=>{cursor++;return run;},
    useLayoutEffect:(run:()=>void|(()=>void),deps:unknown[])=>{const at=cursor++,old=slots[at];if(!old||deps.some((d,i)=>d!==old[i])){slots[at]=deps;effects.push(()=>{const cleanup=run();if(cleanup)cleanups.push(cleanup);});}},
  };
  const context={exports:{} as {usePlot:(panel:unknown)=>{plot:number|undefined;onBase:(height:number)=>void}},devicePixelRatio:1,
    getComputedStyle:()=>({minHeight:'300',getPropertyValue:()=> '0'}),
    ResizeObserver:class{constructor(public run:()=>void){observers.push(this);}observe(){}disconnect(){}},
    require:(name:string)=>name==='react'?react:{useLocale:()=>locale},
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/sizing.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const render=()=>{cursor=0;effects.length=0;const result=context.exports.usePlot(panel);effects.forEach(run=>run());plot=result.plot;return result;};
  const initial=render();initial.onBase(300);render();assert.equal(reports.at(-1).min,500);assert.equal(plot,undefined);
  const layout=reports.at(-1).layout;
  sizing.manual=true;sizing.allocated=620;render();render();assert.equal(plot,420);
  chartHeight=420;rootHeight=620;observers[0].run();render();assert.equal(reports.at(-1).min,500);assert.equal(reports.at(-1).layout,layout);
  // An empty answer, new legend entries or an error cannot reinterpret the shell.
  rootHeight=640;observers[0].run();render();assert.equal(plot,420);assert.equal(reports.at(-1).natural,500);
  const before=reads;render();assert.equal(reads,before,'ordinary data renders perform no layout reads');
  root.clientWidth=400;sizing.width='narrow';rootHeight=700;render();render();assert.equal(plot,340);assert.notEqual(reports.at(-1).layout,layout);
  locale='ru';rootHeight=720;render();render();assert.equal(plot,320);
  sizing.manual=false;render();render();assert.equal(plot,undefined);
  cleanups.reverse().forEach(run=>run());assert.equal(reports.at(-1),null);
});
