import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {chartMuteKey} from '../lib/prefs';

test('the actual quota legend retains phase renders and refreshes values, language, handlers and authority',()=>{
  const source=readFileSync(new URL('../components/History.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const legend = useMemo('),end=source.indexOf('\n  return (',start);
  assert.ok(start>=0&&end>start);
  let saved:{deps:unknown[];value:any}|null=null,nodes=0;
  let muted:Record<string,boolean>={};
  const toggles:{key:string;value:boolean}[]=[],line={key:'s@w',sourceId:'s',windowId:'w',name:'Account',color:'blue',dash:'',current:42};
  const context={lines:[line],muted,widget:'quota-history',locale:'en',history:{} as unknown,error:null as unknown,authority:0,board:'b',
    SeriesLegendItem:'series',num:(value:number)=>String(value),t:()=>context.locale,
    mutedLine:(value:typeof line)=>!!muted[chartMuteKey(context.widget,value.sourceId,value.windowId)],chartMuteKey,
    setMuted:(key:string,value:boolean)=>toggles.push({key,value}),
    useMemo:(read:()=>unknown,deps:unknown[])=>{
      if(!saved||deps.some((value,i)=>!Object.is(value,saved!.deps[i])))saved={deps,value:read()};
      return saved.value;
    },
    node:(tag:unknown,props:Record<string,unknown>|null,...children:unknown[])=>{nodes++;return {tag,props,children};},
    draw:null as unknown as ()=>any};
  runInNewContext(ts.transpileModule(`function draw(){${source.slice(start,end)}\nreturn legend;}\nglobalThis.draw=draw;`,
    {fileName:'legend.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,jsxFactory:'node'}}).outputText,context);
  const first=context.draw(),initialNodes=nodes;
  for(let n=0;n<50;n++)assert.equal(context.draw(),first);
  assert.equal(nodes,initialNodes,'unchanged phase renders create no legend JSX');
  const firstEntry=first.children[0][0];
  assert.equal(firstEntry.children[0].children[0],'42%');
  firstEntry.props.onToggle();assert.deepEqual(toggles.at(-1),{key:chartMuteKey('quota-history','s','w'),value:true});
  muted={[chartMuteKey('quota-history','s','w')]:true};context.muted=muted;
  const hidden=context.draw();assert.notEqual(hidden,first);
  hidden.children[0][0].props.onToggle();assert.equal(toggles.at(-1)!.value,false,'the replacement callback uses current visibility');
  context.lines=[{...line,current:0,name:'Renamed',color:'green'}];
  const changed=context.draw();assert.equal(changed.children[0][0].children[0].children[0],'0%');
  assert.equal(changed.children[0][0].props.name,'Renamed');assert.equal(changed.children[0][0].props.color,'green');
  assert.equal(firstEntry.props.name,'Account','replacing data does not mutate a published legend');
  context.locale='ru';assert.notEqual(context.draw(),changed);
  context.lines=[];context.history=null;context.authority++;context.board='other';
  const retired=context.draw();assert.equal(retired.children[0].length,0);assert.equal(retired.children[1],false);
  context.history={};assert.equal(context.draw().children[1].children[0],'ru');
  context.error=new Error('Unavailable');assert.equal(context.draw().children[1],false,'an error suppresses the empty-history note');
});
