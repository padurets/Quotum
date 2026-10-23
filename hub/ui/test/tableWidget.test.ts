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
function widgetFixture(border=0,manual=true){
  let cursor=0,changed=false,key='period-a',updates=0,rowReads=0,layoutReads=0,shell=140,keys=Array.from({length:57},(_,i)=>'row-'+i),displayed=true,givenWidth=1200,measuring=false;
  const slots:any[]=[],effects:(()=>void)[]=[],reports:{min:number;natural:number;shown:number}[]=[];
  const observers:{callback:(entries:{target:unknown}[])=>void;targets:Set<unknown>;initial:Set<unknown>}[]=[],rowHeights=new Map<string,number>();
  const sizing={manual,allocated:560,width:'wide',report:(value:any)=>{if(value)reports.push(value);}};
  const root={get clientWidth(){return displayed?givenWidth:0;},set clientWidth(value:number){givenWidth=value;},height:0,fill:0,closest:()=>root,getBoundingClientRect:()=>{layoutReads++;return {width:root.clientWidth,height:displayed?root.height:0};}};
  const panel={current:root as unknown as HTMLElement};
  const sameDeps=(a:unknown[]|undefined,b:unknown[]|undefined)=>!!a&&!!b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  const hooks={
    useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return [slots[at],(next:any)=>{const value=typeof next==='function'?next(slots[at]):next;if(!Object.is(value,slots[at])){updates++;slots[at]=value;changed=true;}}];},
    useRef:(current:unknown)=>{const at=cursor++;return slots[at]??(slots[at]={current});},
    useMemo:(read:()=>unknown,deps:unknown[])=>{const at=cursor++;if(!slots[at]||!sameDeps(slots[at].deps,deps))slots[at]={deps,value:read()};return slots[at].value;},
    useLayoutEffect:(effect:()=>void|(()=>void),deps?:unknown[])=>{const at=cursor++;if(!slots[at]||!sameDeps(slots[at].deps,deps)){const previous=slots[at];slots[at]={deps};effects.push(()=>{previous?.cleanup?.();slots[at].cleanup=effect();});}},
  };
  const element=(type:unknown,props:unknown)=>({type,props});
  const modules:Record<string,unknown>={react:hooks,'react-dom':{flushSync:(callback:()=>void)=>callback()},'react/jsx-runtime':{jsx:element,jsxs:element},'../lib/table':tables,'../i18n':{useLocale:()=> 'en'},'./Popover':{},'./sizing':{
    useSizing:()=>sizing,fillOf:()=>root.fill,pixels:(n:number)=>Math.round(n*64)/64,same:(a:number|undefined,b:number|undefined)=>a===b||a!==undefined&&b!==undefined&&Math.abs(a-b)<1,
  }};
  const context={exports:{} as Pick<typeof import('../components/TableWidget'),'useTableWidget'|'TableMeasure'|'TableSurface'>,require:(name:string)=>modules[name],
    getComputedStyle:()=>({paddingLeft:'22',paddingRight:'22',borderBottomWidth:String(border*2)}),ResizeObserver:class {
      record:{callback:(entries:{target:unknown}[])=>void;targets:Set<unknown>;initial:Set<unknown>};constructor(callback:(entries:{target:unknown}[])=>void){this.record={callback,targets:new Set(),initial:new Set()};observers.push(this.record);}
      observe(target:unknown){this.record.targets.add(target);this.record.initial.add(target);}disconnect(){this.record.targets.clear();this.record.initial.clear();}
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/TableWidget.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const height=(id:string)=>rowHeights.get(id)??(id==='row-55'?220:root.clientWidth<800?80:44);
  const body=()=>{
    const nodes=new Map<string,any>(),box={ids:[] as string[],children:[] as any[],getBoundingClientRect:()=>({height:displayed?box.ids.reduce((sum,id)=>sum+height(id),0):0})};
    return {box,update:(ids:string[])=>{box.ids=ids;box.children=ids.map(id=>{if(!nodes.has(id))nodes.set(id,{rowId:id,firstElementChild:{},hasAttribute:()=>false,getBoundingClientRect:()=>{rowReads++;if(!displayed)return {top:0,bottom:0,height:0,width:0};const top=100+box.ids.slice(0,box.ids.indexOf(id)).reduce((sum,key)=>sum+height(key),0),h=height(id);return {top,bottom:top+h,height:h,width:root.clientWidth-44};}});return nodes.get(id);});return box;}};
  };
  const liveBody=body();let measuredBody:ReturnType<typeof body>|null=null;
  const render=()=>{
    let widget:TableWidget;
    for(let i=0;i<20;i++){
      changed=false;cursor=0;effects.length=0;
      widget=context.exports.useTableWidget(panel,[120,120,180,180],180,keys,key);
      measuring=context.exports.TableMeasure({table:widget,children:null})!==null;
      measuredBody=measuring?measuredBody??body():null;
      const current=keys.slice(widget.from,widget.to),footer=80;
      const head=widget.layout==='table'?56:18;
      const natural=shell-head+widget.surfaceHeight+footer;
      widget.surface.current={getBoundingClientRect:()=>({height:displayed?widget.surfaceHeight:0})} as HTMLDivElement;
      root.height=Math.max(sizing.allocated,natural);root.fill=displayed?root.height-natural:0;
      widget.live.current=liveBody.update(current) as unknown as HTMLElement;
      widget.measured.current=measuredBody?measuredBody.update(keys.slice(widget.measureFrom,widget.measureTo)) as unknown as HTMLElement:null;
      widget.footer.current={getBoundingClientRect:()=>({height:displayed?footer:0})} as HTMLElement;
      widget.measuredFooter.current=measuring?{getBoundingClientRect:()=>({height:displayed?80:0})} as HTMLElement:null;
      widget.measuredSingleFooter.current=measuring?{getBoundingClientRect:()=>({height:displayed?46:0})} as HTMLElement:null;
      for(const effect of effects)effect();
      if(!changed)for(const observer of observers){
        const entries=[...observer.initial].map(target=>({target,borderBoxSize:target===root?[{inlineSize:root.clientWidth,blockSize:displayed?root.height:0}]:(target as {rowId?:string}).rowId?[{inlineSize:displayed?root.clientWidth-44:0,blockSize:displayed?height((target as {rowId:string}).rowId):0}]:undefined}));
        observer.initial.clear();if(entries.length)observer.callback(entries);
      }
      if(!changed)return widget;
    }
    throw new Error('the shared table did not settle before paint');
  };
  const original=keys;
  return {render,reports,keys:()=>keys,shown:(widget:TableWidget)=>keys.slice(widget.from,widget.to),resize:(height:number)=>{sizing.allocated=height;},narrow:()=>{root.clientWidth=350;sizing.width='narrow';},reset:(next='period-b')=>{key=next;},clear:()=>{keys=[];},limit:(n:number)=>{keys=original.slice(0,n);},height:()=>root.height,rowReads:()=>rowReads,layoutReads:()=>layoutReads,updates:()=>updates,measuring:()=>measuring,
    hide:(notify=true)=>{displayed=false;if(notify)for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root,borderBoxSize:[{inlineSize:0,blockSize:0}]}] as any);},
    show:(width=1200)=>{displayed=true;givenWidth=width;sizing.width=width<800?'narrow':'wide';for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root,borderBoxSize:[{inlineSize:width,blockSize:root.height}]}] as any);},
    display:(show:boolean,boxes=true,deliver=true)=>{displayed=show;if(!deliver)return;for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root,...(boxes?{borderBoxSize:[{inlineSize:root.clientWidth,blockSize:show?root.height:0}]}:{})}] as any);},
    reverse:()=>{keys=[...keys].reverse();},
    rowHeights:(changes:Record<string,number>)=>{for(const [id,height]of Object.entries(changes))rowHeights.set(id,height);},
    chrome:(delta:number,nextBorder=border)=>{shell+=delta;border=nextBorder;root.height+=delta;for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root}]);},
    notifyRows:(ids?:string[],boxes=true)=>{let delivered=0;for(const observer of observers){const entries=[...observer.targets].filter(target=>{const id=(target as {rowId?:string}).rowId;return id!==undefined&&(!ids||ids.includes(id));}).map(target=>({target,...(boxes?{borderBoxSize:[{inlineSize:root.clientWidth-44,blockSize:height((target as {rowId:string}).rowId)}]}:{})}));if(entries.length){delivered+=entries.length;observer.callback(entries);}}return delivered;},
    fill:()=>{root.height+=48;root.fill+=48;for(const observer of observers)if(observer.targets.has(root))observer.callback([{target:root}]);}};
}

test('hidden tables remove their measurement tree and observe new rows when shown',()=>{
  for(const narrow of [false,true]){
    const f=widgetFixture();if(narrow)f.narrow();let widget=f.render();
    assert.equal(f.measuring(),true);assert.ok(f.notifyRows()>0);
    widget.onPage(3);f.render();const reads=f.rowReads();
    f.display(false);f.render();
    assert.equal(f.measuring(),false,'a zero-width table has no measurement subtree');
    assert.equal(widget.measured.current,null);assert.equal(f.notifyRows(),0);
    f.reverse();f.reset();widget=f.render();
    assert.equal(widget.count,57);assert.equal(widget.page,0);assert.equal(f.rowReads(),reads);
    f.rowHeights({'row-56':220});f.display(true);widget=f.render();
    assert.equal(f.measuring(),true);assert.equal(f.shown(widget)[0],'row-56');
    assert.ok(f.notifyRows(['row-56'])>0,'the replacement measurement row is observed');
    const min=f.reports.at(-1)!.min;
    f.rowHeights({'row-56':250});f.render();f.notifyRows(['row-56']);widget=f.render();
    assert.equal(f.reports.at(-1)!.min,min,'row growth cannot change the structural shell');assert.equal(f.height(),560);assert.ok(widget.to<57);
  }
});

test('a hidden table keeps its measured geometry while data and page ownership advance',()=>{
  const f=widgetFixture();let widget=f.render();widget.onPage(3);f.render();
  const reports=f.reports.length,reads=f.rowReads(),layouts=f.layoutReads();
  f.display(false);f.render();f.reverse();f.reset();widget=f.render();
  assert.equal(widget.count,57);assert.equal(widget.page,0,'the period still resets a hidden table');
  assert.equal(f.reports.length,reports,'a zero-width box cannot replace useful geometry');
  assert.equal(f.rowReads(),reads,'hidden rows have no layout to measure');
  assert.equal(f.layoutReads(),layouts,'the zero-width observer notification suspends layout reads');
  f.rowHeights({'row-56':220});f.display(true,false);widget=f.render();
  assert.equal(widget.page,0);assert.equal(f.shown(widget)[0],'row-56','hidden changes reach the restored table');
  assert.ok(f.rowReads()>reads,'restoration measures the changed rows before paint');
  assert.equal(f.height(),560);assert.ok(widget.to<57,'zero measurements cannot expand the restored page');
});

test('a hidden selection shrink cannot restore an old page after refill',()=>{
  for(const count of [0,2]){
    const f=widgetFixture();let widget=f.render();widget.onPage(3);f.render();
    f.display(false);f.render();f.limit(count);widget=f.render();
    assert.equal(widget.count,count);assert.equal(widget.page,0);
    f.limit(57);f.render();f.display(true);widget=f.render();
    assert.equal(widget.page,0);assert.equal(f.shown(widget)[0],'row-0');
  }
});

test('a table first mounted hidden measures its first shown layout',()=>{
  const f=widgetFixture();f.display(false);let widget=f.render();
  assert.equal(widget.count,57);assert.equal(f.reports.length,0);assert.equal(f.rowReads(),0);
  f.display(true);widget=f.render();
  assert.equal(widget.layout,'table');assert.equal(f.height(),560);assert.ok(f.rowReads()>0);
  assert.equal(widget.page,0);assert.ok(widget.to<57);
});

test('a zero read before resize observation cannot suspend later measurements',()=>{
  const f=widgetFixture();f.render();const min=f.reports.at(-1)!.min,reads=f.rowReads();
  f.display(false,true,false);f.resize(561);f.render();
  f.rowHeights({'row-0':60,'row-1':28});f.display(true,true,false);f.resize(560);f.render();
  assert.equal(f.reports.at(-1)!.min,min);assert.ok(f.rowReads()>reads);
  assert.equal(f.height(),560,'the observed outer dimensions never changed');
});

test('showing the same-sized panel remeasures balanced row changes',()=>{
  const f=widgetFixture();f.render();const min=f.reports.at(-1)!.min,reads=f.rowReads();
  f.display(false);f.rowHeights({'row-0':60,'row-1':28});f.display(true);f.render();
  assert.equal(f.reports.at(-1)!.min,min,'balanced row changes keep the shell stable');
  assert.ok(f.rowReads()>reads,'matching old outer dimensions cannot reuse hidden row heights');
});

test('a fill-only notification does not reread candidate rows or report another layout',()=>{
  const f=widgetFixture();f.render();const reads=f.rowReads(),reports=f.reports.length;
  f.fill();assert.equal(f.rowReads(),reads);assert.equal(f.reports.length,reports);
});

test('a period reset at page zero reuses its state and measured row geometry',()=>{
  const f=widgetFixture();f.render();const reads=f.rowReads(),reports=f.reports.length,layouts=f.layoutReads(),updates=f.updates();
  f.reset();const widget=f.render();
  assert.equal(widget.page,0);assert.equal(f.rowReads(),reads);assert.equal(f.reports.length,reports);assert.equal(f.layoutReads(),layouts);assert.equal(f.updates(),updates);
  f.fill();f.render();assert.equal(f.rowReads(),reads);assert.equal(f.reports.length,reports);
});

test('panel chrome repaginates without rereading its unchanged measurement rows',()=>{
  const f=widgetFixture();let widget=f.render();const reads=f.rowReads(),count=widget.to-widget.from,min=f.reports.at(-1)!.min;
  f.chrome(48);widget=f.render();
  assert.ok(widget.to-widget.from<count);assert.equal(f.reports.at(-1)!.min,min+48);assert.equal(f.height(),560);
  assert.ok(f.rowReads()-reads<=6,'only the visible area endpoints need another read');
});

test('an allocation change reads pending row growth before resize delivery',()=>{
  const f=widgetFixture();f.render();const min=f.reports.at(-1)!.min,reads=f.rowReads();
  f.rowHeights({'row-0':74,'row-1':14});f.resize(608);f.render();
  assert.ok(f.rowReads()>reads,'allocation reads pending row growth before resize delivery');
  assert.equal(f.reports.at(-1)!.min,min,'row growth cannot change the structural shell');
});

test('a changed border invalidates cached measurement strides',()=>{
  const f=widgetFixture(3);f.render();const min=f.reports.at(-1)!.min;
  f.chrome(48,9);f.render();assert.equal(f.reports.at(-1)!.min,min+48);
});

test('individual row size changes invalidate measurements even when their combined height stays fixed',()=>{
  for(const manual of [true,false]){
    const f=widgetFixture(0,manual);f.render();const min=f.reports.at(-1)!.min,shown=f.height(),reads=f.rowReads();
    f.rowHeights({'row-0':74,'row-1':14});f.render();f.notifyRows(['row-0','row-1']);f.render();
    assert.ok(f.rowReads()>reads,'individual row changes invalidate cached strides');assert.equal(f.reports.at(-1)!.min,min,'row growth cannot change the structural shell');assert.equal(f.height(),shown);
  }
});

test('initial row observations, including the final border, do not force another layout',()=>{
  for(const manual of [true,false])for(const narrow of [false,true]){
    const f=widgetFixture(3,manual);if(narrow)f.narrow();f.render();const reads=f.rowReads(),layouts=f.layoutReads();
    assert.ok(f.notifyRows()>0);f.render();
    assert.equal(f.rowReads(),reads);assert.equal(f.layoutReads(),layouts);
  }
});

test('successive small row changes stay relative to the last actual measurement',()=>{
  const f=widgetFixture();f.render();const reads=f.rowReads(),min=f.reports.at(-1)!.min;
  f.rowHeights({'row-0':44.6,'row-1':43.4});f.notifyRows(['row-0','row-1']);f.render();assert.equal(f.rowReads(),reads);
  f.rowHeights({'row-0':45.2,'row-1':42.8});f.notifyRows(['row-0','row-1']);f.render();assert.ok(f.rowReads()>reads);assert.equal(f.reports.at(-1)!.min,min);
});

test('missing observed border boxes cannot hide balanced row growth',()=>{
  const f=widgetFixture();f.render();const min=f.reports.at(-1)!.min,reads=f.rowReads();
  f.rowHeights({'row-0':74,'row-1':14});f.notifyRows(['row-0','row-1'],false);f.render();
  assert.ok(f.rowReads()>reads,'missing border boxes invalidate cached strides');
  assert.equal(f.reports.at(-1)!.min,min,'row growth cannot change the structural shell');
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
  const reads=f.rowReads();f.hide(false);f.resize(561);const hidden=f.render();
  assert.equal(f.rowReads(),reads);
  assert.deepEqual([hidden.page,hidden.from,hidden.to],[before.page,before.from,before.to]);
  f.resize(560);f.show();const shown=f.render();
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
  f.reset('period-a');widget=f.render();assert.equal(widget.page,0,'returning to the old period must not resurrect its retired page');
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
