import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextTableSort,tablePages,visibleTableSort,type TableSort} from '../lib/table';
import {nextAgentsSort,agentsLayout,columnsOf,type AgentColumn} from '../lib/agents';
import {columnShown} from '../lib/view';
import {EMPTY_VIEW} from '../../server/domain/view';
import {AGENTS} from '../../server/domain/widgets';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as tables from '../lib/table';
import type {TableWidget} from '../components/TableWidget';

test('default session disclosure columns fit the shared wide dialog and stay compact on a narrow screen',()=>{
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8'),maximum=Number(css.match(/\.dialog-frame\.is-wide\s*\{\s*max-width:\s*(\d+)px/)![1]);
  for(const by of ['project','machine','subscription'] as const){
    const columns=columnsOf(by,true).rest.filter(column=>columnShown(EMPTY_VIEW,AGENTS,column));
    assert.ok(columns.includes('client'),'default Client participates in the real disclosure geometry');
    for(const viewport of [1024,1280])assert.equal(agentsLayout(columns,Math.min(maximum,viewport-32)-2),'table',`${by} disclosure fits its default columns at ${viewport}`);
    assert.equal(agentsLayout(columns,Math.min(maximum,390-32)-2),'list',`${by} uses the existing narrow list`);
  }
});

/** Commit the real hook against measured rows, without a browser or a second React runtime. */
function widgetFixture(){
  let cursor=0,changed=false,key='period-a',rowReads=0,keys=Array.from({length:57},(_,i)=>'row-'+i);
  const slots:any[]=[],effects:(()=>void)[]=[],reports:{min:number;natural:number;shown:number}[]=[];
  const observers:{callback:(entries:any[])=>void;targets:Set<unknown>}[]=[];
  const sizing={manual:true,allocated:560,width:'wide',report:(value:any)=>{if(value)reports.push(value);}};
  const root={clientWidth:1200,height:0,fill:0,closest:()=>root,getBoundingClientRect:()=>({width:root.clientWidth,height:root.clientWidth?root.height:0})};
  const sameDeps=(a:unknown[]|undefined,b:unknown[]|undefined)=>!!a&&!!b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  const hooks={
    useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return [slots[at],(next:any)=>{const value=typeof next==='function'?next(slots[at]):next;if(!Object.is(value,slots[at])){slots[at]=value;changed=true;}}];},
    useRef:(current:unknown)=>{const at=cursor++;return slots[at]??(slots[at]={current});},
    useMemo:(read:()=>unknown,deps:unknown[])=>{const at=cursor++;if(!slots[at]||!sameDeps(slots[at].deps,deps))slots[at]={deps,value:read()};return slots[at].value;},
    useLayoutEffect:(effect:()=>void,deps?:unknown[])=>{const at=cursor++;if(!slots[at]||!sameDeps(slots[at].deps,deps)){slots[at]={deps};effects.push(effect);}},
  };
  const modules:Record<string,unknown>={react:hooks,'react/jsx-runtime':{},'../lib/table':tables,'../i18n':{useLocale:()=> 'en'},'./Popover':{},'./sizing':{
    useSizing:()=>sizing,fillOf:()=>root.fill,pixels:(n:number)=>Math.round(n*64)/64,same:(a:number|undefined,b:number|undefined)=>a===b||a!==undefined&&b!==undefined&&Math.abs(a-b)<1,
  }};
  const context={exports:{} as {TableSurface:'surface',useTableWidget:typeof import('../components/TableWidget').useTableWidget},require:(name:string)=>modules[name],
    getComputedStyle:()=>({paddingLeft:'22',paddingRight:'22',borderBottomWidth:'0'}),ResizeObserver:class {
      record:{callback:(entries:any[])=>void;targets:Set<unknown>};constructor(callback:(entries:any[])=>void){this.record={callback,targets:new Set()};observers.push(this.record);}
      observe(target:unknown){this.record.targets.add(target);}disconnect(){this.record.targets.clear();}
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/TableWidget.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const height=(id:string)=>id==='row-55'?220:root.clientWidth<800?80:44;
  const body=(ids:string[])=>({getBoundingClientRect:()=>({height:root.clientWidth?ids.reduce((sum,id)=>sum+height(id),0):0}),children:ids.map((id,index)=>({firstElementChild:{},hasAttribute:()=>false,getBoundingClientRect:()=>{rowReads++;const top=100+ids.slice(0,index).reduce((sum,id)=>sum+height(id),0),h=root.clientWidth?height(id):0;return {top,bottom:top+h,height:h};}}))});
  const render=()=>{
    let widget:TableWidget;
    for(let i=0;i<20;i++){
      changed=false;cursor=0;effects.length=0;
      widget=context.exports.useTableWidget({current:root as unknown as HTMLElement},[120,120,180,180],180,keys,key);
      const current=keys.slice(widget.from,widget.to),footer=80;
      const head=widget.layout==='table'?56:18;
      const natural=140-head+widget.surfaceHeight+footer;
      widget.surface.current={getBoundingClientRect:()=>({height:widget.surfaceHeight})} as HTMLDivElement;
      root.height=Math.max(sizing.allocated,natural);root.fill=root.height-natural;
      widget.live.current=body(current) as unknown as HTMLElement;
      widget.measured.current=body(keys.slice(widget.measureFrom,widget.measureTo)) as unknown as HTMLElement;
      widget.footer.current={getBoundingClientRect:()=>({height:footer})} as HTMLElement;
      widget.measuredFooter.current={getBoundingClientRect:()=>({height:80})} as HTMLElement;
      widget.measuredSingleFooter.current={getBoundingClientRect:()=>({height:46})} as HTMLElement;
      for(const effect of effects)effect();
      if(!changed)return widget;
    }
    throw new Error('the shared table did not settle before paint');
  };
  const original=keys;
  return {render,reports,keys:()=>keys,shown:(widget:TableWidget)=>keys.slice(widget.from,widget.to),resize:(height:number)=>{sizing.allocated=height;},narrow:()=>{root.clientWidth=350;sizing.width='narrow';},reset:()=>{key='period-b';},clear:()=>{keys=[];},limit:(n:number)=>{keys=original.slice(0,n);},height:()=>root.height,rowReads:()=>rowReads,
    hide:(notify=true)=>{root.clientWidth=0;if(notify)for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root,borderBoxSize:[{inlineSize:0,blockSize:0}]}]);},
    show:(width=1200)=>{root.clientWidth=width;sizing.width=width<800?'narrow':'wide';for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root,borderBoxSize:[{inlineSize:width,blockSize:root.height}]}]);},
    fill:()=>{root.height+=48;root.fill+=48;for(const observer of observers)if(observer.targets.has(root))observer.callback([]);}};
}

test('a fill-only notification does not reread candidate rows or report another layout',()=>{
  const f=widgetFixture();f.render();const reads=f.rowReads(),reports=f.reports.length;
  f.fill();assert.equal(f.rowReads(),reads);assert.equal(f.reports.length,reports);
});

test('a hidden table retains its page and geometry without measuring rows, then measures them on reveal',()=>{
  const f=widgetFixture();let before=f.render();before.onPage(2);before=f.render();
  const reads=f.rowReads(),reports=f.reports.length;
  f.hide();const hidden=f.render();
  assert.equal(f.rowReads(),reads,'a zero-width root has no row geometry to measure');
  assert.equal(f.reports.length,reports,'hidden measurements cannot replace useful sizing reports');
  assert.deepEqual([hidden.page,hidden.from,hidden.to,hidden.surfaceHeight],[before.page,before.from,before.to,before.surfaceHeight]);
  f.fill();assert.equal(f.rowReads(),reads,'unrelated notifications cannot resume a hidden table');
  f.show();const shown=f.render();
  assert.ok(f.rowReads()>reads,'returning to the same width still requires fresh row geometry');
  assert.deepEqual([shown.page,shown.from,shown.to,shown.surfaceHeight],[before.page,before.from,before.to,before.surfaceHeight]);
});

test('a synchronous zero width before its observer notification keeps the complete page until recovery',()=>{
  const f=widgetFixture();let before=f.render();before.onPage(2);before=f.render();
  const reads=f.rowReads();f.hide(false);const hidden=f.render();
  assert.equal(f.rowReads(),reads);
  assert.deepEqual([hidden.page,hidden.from,hidden.to,hidden.surfaceHeight],[before.page,before.from,before.to,before.surfaceHeight]);
  f.show();const shown=f.render();
  assert.ok(f.rowReads()>reads);
  assert.deepEqual([shown.page,shown.from,shown.to,shown.surfaceHeight],[before.page,before.from,before.to,before.surfaceHeight]);
});

test('an initially hidden table and a hidden wide table both resume into a real narrow layout',()=>{
  for(const initiallyHidden of [false,true]){
    const f=widgetFixture();if(!initiallyHidden)f.render();f.hide();f.render();const reads=f.rowReads();
    f.show(350);const shown=f.render();
    assert.equal(shown.layout,'list');assert.ok(f.rowReads()>reads);
    assert.equal(f.height(),560);assert.ok(shown.to>shown.from&&shown.to<f.keys().length);
    assert.ok(f.reports.every(report=>report.min>0&&Number.isFinite(report.natural)));
  }
});

test('the real shared hook pages all rows once, fits height, resets and clamps before paint',()=>{
  const f=widgetFixture(),seen:string[]=[];let widget=f.render();
  assert.equal(widget.layout,'table');assert.equal(f.height(),560);
  while(true){seen.push(...f.shown(widget));assert.equal(f.height(),560);if(widget.page+1===widget.pages)break;widget.onPage(widget.page+1);widget=f.render();}
  assert.deepEqual(seen,f.keys());
  f.reset();widget=f.render();assert.equal(widget.page,0);
  const larger=widget.to-widget.from;f.resize(420);widget=f.render();assert.ok(widget.to-widget.from<larger);assert.equal(f.height(),420);
  f.narrow();widget=f.render();assert.equal(widget.layout,'list');assert.equal(f.height(),420);
  widget.onPage(999);widget=f.render();assert.ok(widget.page>=0&&widget.page<widget.pages);
  f.limit(2);widget=f.render();assert.equal(widget.page,0);f.limit(57);widget=f.render();assert.equal(widget.page,0,'growth must not resurrect the retired page');
  f.clear();widget=f.render();assert.equal(widget.page,0);assert.equal(widget.pages,1);assert.equal(widget.to,0);
  assert.ok(f.reports.every(report=>Number.isFinite(report.min)&&report.natural>=report.min));
});

test('a tall widget fits more than fifty rows and removes pages when the whole selection fits',()=>{
  const f=widgetFixture();f.render();f.resize(3000);const widget=f.render();
  assert.equal(widget.pages,1);assert.equal(widget.from,0);assert.equal(widget.to,57);
  assert.equal(widget.measureTo,57,'every fitting row was measured, including the late tall row');
  assert.equal(f.height(),3000);
  f.resize(2500);const smaller=f.render();assert.ok(smaller.pages>1);assert.ok(smaller.to>50);
  assert.equal(f.height(),2500);
});

test('session table columns use ascending, descending, reset and explicit menu reset',()=>{
  function cycle<Id extends string>(next:(sort:TableSort<Id>,column:Id|null,cycle?:boolean)=>TableSort<Id>,column:Id){
    const up=next(null,column);assert.deepEqual(up,{column,descending:false});
    const down=next(up,column);assert.deepEqual(down,{column,descending:true});
    assert.equal(next(down,column),null);
    assert.equal(next(down,null),null);
    assert.deepEqual(next(down,column,false),up);
  }
  cycle<AgentColumn>(nextAgentsSort,'project');cycle<AgentColumn>(nextAgentsSort,'active');
  const saved={column:'a',descending:true};assert.equal(visibleTableSort(saved,['b']),null);assert.equal(visibleTableSort(saved,['a','b']),saved);
  assert.equal(nextTableSort(null,null),null);
});

test('page boundaries fit whole variable-height rows with no gaps or duplicates',()=>{
  const keys=['a','b','c','d'],heights=new Map([['a',40],['b',60],['c',50],['d',30]]);
  assert.deepEqual(tablePages(keys,heights,40,150),[0,3]);
  assert.deepEqual(tablePages(keys,heights,40,100),[0,2]);
  assert.deepEqual(tablePages(keys,heights,40,99.5),[0,2]);
  assert.deepEqual(tablePages(keys,heights,40,99.4),[0,1,2]);
  assert.deepEqual(tablePages(keys,new Map([['a',200]]),40,100),[0,1,3]);
  const many=Array.from({length:125},(_,i)=>'row-'+i),starts=tablePages(many,new Map(),44,176);
  const pages=starts.map((from,i)=>many.slice(from,starts[i+1]??many.length));
  assert.deepEqual(pages.flat(),many);assert.ok(pages.every(page=>page.length<=4));
  assert.deepEqual(tablePages(many,new Map(),44,Infinity),[0]);
  assert.deepEqual(tablePages([],new Map(),44,100),[0]);
});

test('identity heights survive reordering and exclusive last-row borders',()=>{
  const heights=new Map([['tall',100],['short',20],['other',30]]);
  assert.deepEqual(tablePages(['short','other','tall'],heights,44,50),[0,2]);
  assert.deepEqual(tablePages(['tall','short','other'],heights,44,50),[0,1]);
  assert.deepEqual(tablePages(['short','other'],heights,44,49,1),[0]);
});
