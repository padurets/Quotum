import {CATEGORY_COLORS} from '../../server/domain/categoryColors';
import type {ProjectColorPins} from '../../server/domain/projectColors';
import {resolveProjectColors,OTHER_COLOR,type ProjectIdentity} from '../lib/projectColors';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {activityScale,groupColors} from '../lib/activity';
import type {ActivityGroup} from '../lib/types';
import {plotGroupsPrepared, type PlotBuffer, type PlotGroup} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {groupRegistry} from '../lib/plotRegistry';
import {cellStart} from '../../server/domain/history';
import {niceTicks} from '../lib/periods';
import {navigationKey} from '../lib/axisNavigation';
import {preparationFixture} from './preparationFixture';

test('the actual activity edge painter advances clipped bars without preparing the interior again', () => {
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const paintEdges = () => {');
  const region = source.slice(start, source.indexOf('  // Input uses the committed groups', start));
  const attributes = new Map<string, string>(), path = new Map<string, string>();
  const clips: number[][] = []; let draft: {token: number} | null = null;
  const node = (values: Map<string, string>) => ({getAttribute: (name: string) => values.get(name), setAttribute: (name: string, value: string) => values.set(name, value)});
  const context = {bandClip: {current: {}}, mask: {current: node(attributes)}, edges: {current: {querySelectorAll: () => [node(path)]}},
    currentActivity: {}, activity: {by: {source: [{key: 's', cells: [[0, 25_000], [60_000, 60_000], [120_000, 5_000]]}]}},
    strip: null, groups: [{group: {key: 's'}}], from: 15_000, to: 135_000, by: 'source', barMs: 60_000, vertical: {max: 60_000}, height: 100, perMs: 0.001,
    left: 0, right: 0, width: 120, scale: 1, x: (at: number) => at / 1000, y: (ms: number) => 100 - ms / 1000,
    axis: {held: false, visualGeometry: () => ({})}, pan: {get: () => draft}, painted: {current: ''}, clipPlot: (_node: unknown, ...bounds: number[]) => clips.push(bounds), cellStart,
    paint: null as unknown as () => void,
  };
  runInNewContext(ts.transpileModule(region + '\nglobalThis.paint=paintEdges;', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  context.paint();
  assert.equal(attributes.get('x'), '60'); assert.equal(attributes.get('width'), '60', 'the interior is drawn from the retained paths');
  assert.equal(path.get('d'), 'M0.5,75.0H59.5V100.0H0.5ZM120.5,95.0H179.5V100.0H120.5Z');
  context.from = 30_000; context.to = 150_000;
  context.activity = {by: {source: [{key: 's', cells: [[0, 10_000], [60_000, 60_000], [120_000, 5_000]]}]}};
  context.paint();
  assert.equal(path.get('d'), 'M0.5,90.0H59.5V100.0H0.5ZM120.5,95.0H179.5V100.0H120.5Z', 'only the exact boundary height changes');
  const retained = path.get('d');
  for (const released of [false, true]) {
    draft = released ? null : {token: 1}; context.axis.held = released;
    context.from = 1_000_000; context.to = 1_120_000; clips.length = 0;
    context.paint();
    assert.deepEqual(clips, [[0, 120, 120]], 'an unread moving frame keeps the retained drawing visible until its strip arrives');
    assert.equal(path.get('d'), retained, 'the previous boundaries do not pretend to describe the gesture');
  }
});

test('ordinary Activity frames allocate unpinned colours by current rank while metadata retains the numeric basis', () => {
  const hooks=preparationFixture();let preparations=0;
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const prepared = usePrepared(');
  const region=source.slice(start,source.indexOf('  const currentGroups=',start));
  type Model={identities:ProjectIdentity[]};
  type Presentation={model:Model|null;identities:ProjectIdentity[]};
  const context={...hooks,resolveProjectColors,groupRegistry,
    usePrepared:(work:()=>Generator<void,unknown,void>,deps:readonly unknown[],scope:unknown=null,enabled=true)=>hooks.usePrepared(()=>{preparations++;return work();},deps,scope,enabled),
    groups:[] as ActivityGroup[],colors:[] as string[],shown:[] as {group:ActivityGroup;color:string;name:string}[],strip:null,registry:{current:null},
    pins:[] as ProjectColorPins,colorsReady:true,authority:0,history:{board:'b'},drawing:{range:'24h'},by:'project',arrange:{view:{}},titles:{},prefs:{},locale:'en',
    render:null as unknown as ()=>Presentation,
  };
  runInNewContext(ts.transpileModule(`function render(){${region}\nreturn {model:prepared.value,identities:presentation.identities};}\nglobalThis.render=render;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const frame=(names:string[])=>{
    context.groups=names.map(name=>({key:JSON.stringify(name),name,agentMs:60_000,activeMs:60_000,agents:1,cells:[]}));
    context.colors=groupColors(context.groups,'project',{} as Parameters<typeof groupColors>[2],()=> '');
    context.shown=context.groups.map((group,i)=>({group,color:context.colors[i],name:group.name!}));
  };
  const render=()=>{hooks.begin();const result=context.render();hooks.commit();return result;};
  const settle=()=>{render();hooks.finish();return render();};
  const colors=(value:Presentation)=>[...value.identities].map(group=>group.color);
  const names=Array.from({length:10},(_,i)=>'P'+i);
  frame(names);const initial=settle();
  assert.deepEqual(colors(initial),[...CATEGORY_COLORS,OTHER_COLOR]);
  frame(['P9',...names.slice(0,9)]);
  assert.equal(render().model,initial.model,'pending data keeps the displayed frame');
  hooks.finish();const ranked=render();
  assert.deepEqual(colors(ranked),[...CATEGORY_COLORS,OTHER_COLOR],'a new ordinary numeric model uses its current rank');
  assert.equal(ranked.identities[0].name,'P9');assert.equal(ranked.identities[0].color,CATEGORY_COLORS[0]);
  assert.equal(ranked.identities.at(-1)!.name,'P8');assert.equal(ranked.identities.at(-1)!.color,OTHER_COLOR);

  const beforeColors=preparations;
  context.pins=ranked.identities.slice(0,9).map((group,i)=>[group.name!,CATEGORY_COLORS[i]]);
  assert.equal(render().model,ranked.model);
  context.pins=context.pins.map(([name,color],i)=>[name,i===0?CATEGORY_COLORS[1]:color]);
  const repeated=render();
  assert.equal(repeated.model,ranked.model);assert.equal(repeated.identities.at(-1)!.color,OTHER_COLOR,'releasing a manual slot does not promote a neutral survivor');
  assert.equal(preparations,beforeColors,'colour-only changes do not prepare another numeric model');
  const beforeReset=preparations;context.pins=[];
  const reset=render();assert.equal(reset.model,ranked.model);assert.equal(reset.identities.at(-1)!.color,OTHER_COLOR);assert.equal(preparations,beforeReset);

  frame(names);render();context.pins=[['P2',CATEGORY_COLORS[0]]];render();hooks.finish();
  assert.equal(render().identities.find(group=>group.name==='P2')!.color,CATEGORY_COLORS[0],'pending numeric preparation resolves the latest pins when it commits');
});

test('actual Activity composition resolves retained stacks and the new legend together while replacement prepares', () => {
  const parent=preparationFixture(),child=preparationFixture(),length=24*3_600_000;
  let groupPreparations=0,stackPreparations=0,draws=0;
  class CountedPaths extends StackPaths {override *drawPrepared(...args:Parameters<StackPaths['drawPrepared']>){draws++;return yield*super.drawPrepared(...args);}}
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const prepared = usePrepared('),region=source.slice(start,source.indexOf('  const currentGroups=',start));
  const elementStart=source.indexOf('<Stacks\n'),element=source.slice(elementStart,source.indexOf('/>',elementStart)+2);
  const legendStart=source.indexOf('<div className="legend">'),legend=source.slice(legendStart,source.indexOf('</div>',legendStart)+6);
  const axis={box:{current:null},svg:{current:null},width:400,scale:1,hover:null,drag:null,clip:'c',handlers:{},basis:{from:0,to:length,end:length},active:false,screenX:(at:number)=>at,commitDrawing:()=>{}};
  type Row={group:ActivityGroup;color:string;name:string};
  type Frame={element:React.ReactElement<Record<string,unknown>>;legend:React.ReactNode;prepared:{value:unknown}};
  const context={...parent,React,memo:(fn:unknown)=>fn,useEffect:()=>{},useId:()=> 'c',seriesFocusStyle:()=>({}),
    StackPaths:CountedPaths,stacksHeight:()=>160,activityScale,niceTicks,cellStart,navigationKey,MINUTE:60_000,CSS:{escape:(id:string)=>id},pan:{active:()=>null,subscribe:()=>()=>{}},
    useLocale:()=> 'en',useTimeAxis:()=>axis,useTip:()=>({tip:{current:null},style:{}}),PlotLayer:()=>null,PlotOverlay:()=>null,activitySeriesKey:(_by:string,key:string)=>key,
    clock:()=>'',shortDay:()=>'',workHours:()=>'',stamp:()=>'',t:(key:string)=>key,LegendItem:()=>null,groupName:(group:{name:string|null})=>group.name??'',
    EMPTY_CELLS:[],registry:{current:null},groups:[] as ActivityGroup[],colors:[] as string[],shown:[] as Row[],strip:null,by:'project',prefs:{},locale:'en',
    history:{board:'b'},authority:1,arrange:{view:{}},titles:{},drawing:{range:'24h',since:0},pins:[['A',CATEGORY_COLORS[8]]] as ProjectColorPins,colorsReady:true,resolveProjectColors,groupRegistry,
    activity:{barMs:60_000,by:{project:[] as ActivityGroup[]},cells:[]},drawnActivity:{barMs:60_000,by:{project:[] as ActivityGroup[]},cells:[]},currentGroups:[] as ActivityGroup[],
    EMPTY_ACTIVITY:{},emptyFrame:null,panning:null,answered:true,error:undefined,from:0,to:length,since:null,onBase:()=>{},setTimeRange:()=>{},plot:undefined,navigation:{context:'b',range:'24h'},
    render:null as unknown as ()=>Frame,Stacks:null as unknown as (props:object)=>React.ReactNode,StackArtwork:null as unknown as (props:object)=>React.ReactNode,
  };
  runInNewContext(ts.transpileModule(`function render(){${region}\nreturn {element:(${element}),legend:(${legend}),prepared};}\nglobalThis.render=render;\n${source.slice(source.indexOf('const StackArtwork = memo(function StackArtwork('))}\nglobalThis.Stacks=Stacks;globalThis.StackArtwork=StackArtwork;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,context);
  const frame=(names:string[])=>{
    context.groups=names.map(name=>({key:JSON.stringify(name),name,cells:Array.from({length:480},(_,i):[number,number]=>[i*60_000,60_000]),agentMs:60_000,activeMs:60_000,agents:1}));
    context.colors=groupColors(context.groups,'project',{} as Parameters<typeof groupColors>[2],()=> '');
    context.shown=context.groups.map((group,i)=>({group,color:context.colors[i],name:group.name!}));
    context.activity=context.drawnActivity={barMs:60_000,by:{project:context.groups},cells:[]};context.currentGroups=context.groups;
  };
  const nodes=(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[]=>Array.isArray(node)?node.flatMap(nodes):React.isValidElement<Record<string,unknown>>(node)?node.type===context.StackArtwork?nodes(context.StackArtwork(node.props)):[node,...nodes(node.props.children as React.ReactNode)]:[];
  const render=()=>{
    let current!:Frame,paths!:React.ReactElement<Record<string,unknown>>[];
    // React flushes a parent's state from a child's layout effect before painting.
    for(let i=0;i<2;i++){
      Object.assign(context,parent,{usePrepared:(work:()=>Generator<void,unknown,void>,deps:readonly unknown[],scope:unknown,enabled:boolean)=>parent.usePrepared(()=>{groupPreparations++;return work();},deps,scope,enabled)});
      parent.begin();current=context.render();parent.commit();
      Object.assign(context,child,{usePrepared:(work:()=>Generator<void,unknown,void>,deps:readonly unknown[],scope:unknown,enabled:boolean)=>child.usePrepared(()=>{stackPreparations++;return work();},deps,scope,enabled)});
      child.begin();paths=nodes(context.Stacks(current.element.props)).filter(node=>node.props.className==='activity-stack');child.commit();
    }
    return {current,paths,legend:nodes(current.legend).filter(node=>node.type===context.LegendItem)};
  };
  const settle=()=>{for(let i=0;i<4;i++){render();parent.finish();child.finish();}return render();};
  const fills=(value:ReturnType<typeof render>,name:string)=>value.paths.filter(node=>node.key===JSON.stringify(name)).map(node=>node.props.fill);
  const legendColor=(value:ReturnType<typeof render>,name:string)=>value.legend.find(node=>node.props.name===name)?.props.color;
  frame(['A','B']);const initial=settle();
  assert.deepEqual(fills(initial,'A'),[CATEGORY_COLORS[8],CATEGORY_COLORS[8]]);
  frame(['B']);render();parent.finish();const pending=render();child.tick();
  const geometry=initial.paths.filter(node=>node.props.d!==undefined).map(node=>node.props.d);
  assert.deepEqual(pending.paths.filter(node=>node.props.d!==undefined).map(node=>node.props.d),geometry);
  assert.deepEqual(fills(pending,'A'),[CATEGORY_COLORS[8],CATEGORY_COLORS[8]],'removed parent membership must not revive a raw automatic colour on retained interior or edge paths');
  const before={groups:groupPreparations,stacks:stackPreparations,draws,model:pending.current.prepared.value,jobs:child.scheduler.size};
  context.pins=[['A',CATEGORY_COLORS[0]]];const repainted=render();
  assert.deepEqual(fills(repainted,'A'),[CATEGORY_COLORS[0],CATEGORY_COLORS[0]],'retained membership uses the latest pin');
  assert.deepEqual(fills(repainted,'B'),[CATEGORY_COLORS[1],CATEGORY_COLORS[1]],'the retained manual reservation displaces its conflicting automatic neighbour');
  assert.equal(legendColor(repainted,'B'),CATEGORY_COLORS[1],'the new legend and both retained plot layers share one resolution');
  assert.equal(repainted.current.prepared.value,before.model);assert.equal(groupPreparations,before.groups);assert.equal(stackPreparations,before.stacks);assert.equal(draws,before.draws);assert.equal(child.scheduler.size,before.jobs);
  child.finish();const replacement=render();
  assert.deepEqual(fills(replacement,'A'),[]);assert.deepEqual(fills(replacement,'B'),[CATEGORY_COLORS[0],CATEGORY_COLORS[0]]);
  assert.equal(legendColor(replacement,'B'),CATEGORY_COLORS[0],'a committed replacement releases the absent reservation');

  context.pins=[];frame(['A','B']);settle();frame(['B']);render();parent.finish();render();child.finish();
  const unpinned=render();assert.deepEqual(fills(unpinned,'B'),[CATEGORY_COLORS[0],CATEGORY_COLORS[0]]);assert.equal(legendColor(unpinned,'B'),CATEGORY_COLORS[0],'ordinary unpinned replacement still allocates by current rank');
});

test('actual Activity generators hold one coherent model and produce exact stacks after interrupted preparation', () => {
  const H = 3_600_000, length = 30 * 24 * H, barMs = 2 * H;
  const buffer = (start: number): PlotBuffer => {
    const activityCells: PlotBuffer['activityCells'] = new Map();
    for (let i = 0; i < 480; i++) {
      const at = start + i * barMs, parts = new Map(Array.from({length: 30}, (_, j) => [JSON.stringify(`s${j}`), {ms: (j + 1) * 60_000, name: `s${j}` }]));
      activityCells.set(at, {at, agentMs: 465 * 60_000, activeMs: 0, refs: new Set(), parts: {source: parts, project: parts, device: parts}});
    }
    return {token: 1, epoch: 1, version: start, from: start, to: start + 480 * barMs, cell: barMs, length, barMs, coverage: [[start, start + 480 * barMs]], activityCells, series: [], events: [], knownFrom: start};
  };
  const parent = preparationFixture(), child = preparationFixture(); let aggregates = 0, draws = 0, tickFrame: [number, number] = [0, 0];
  class CountedPaths extends StackPaths {override *drawPrepared(...args: Parameters<StackPaths['drawPrepared']>) {draws++; return yield* super.drawPrepared(...args);}}
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const prepared = usePrepared(');
  const region = source.slice(start, source.indexOf('  const currentGroups=', start));
  const stacksStart = source.indexOf('const StackArtwork = memo(function StackArtwork(');
  assert.ok(stacksStart >= 0, 'the fixture includes the actual prepared stack artwork');
  type Model = {identities: {key: string; name: string | null}[]; shown: {group: PlotGroup; color: string; name: string}[]; strip: PlotBuffer};
  const navigation = {context: 'test', range: 'range'};
  const axis = {box: {current: null}, svg: {current: null}, width: 400, scale: 1, hover: null, drag: null, clip: 'c', handlers: {}, basis: {from: 0, to: length, end: length}, active: false, screenX: (at: number) => 48 + (at - axis.basis.from) / length * 340, commitDrawing: () => {}};
  const context = {resolveProjectColors,pins:[] as ProjectColorPins,paint:new Map<string,string>(),colorsReady:true,drawing:{range:undefined},navigationKey, React, ...parent, memo: (fn: unknown) => fn, useState: child.useState, useEffect: () => {}, seriesFocusStyle:()=>({}), useId: () => 'c',
    EMPTY_CELLS: [], registry: {current: null}, groups: [], colors: [], shown: [], strip: buffer(0), by: 'project', prefs: {}, locale: 'en', history: {board: 'b'}, authority: 0, arrange: {view: {}}, titles: {},
    groupRegistry, groupName: (group: {key: string}) => group.key, activitySeriesKey: (_by: string, key: string) => key,
    plotGroupsPrepared: function* (...args: Parameters<typeof plotGroupsPrepared>) {aggregates++; return yield* plotGroupsPrepared(...args);},
    StackPaths: CountedPaths, stacksHeight: () => 160, activityScale, niceTicks: (...args: Parameters<typeof niceTicks>) => {tickFrame = [args[0], args[1]]; return niceTicks(...args);}, cellStart, MINUTE: 60_000,
    CSS: {escape: (id: string) => id}, pan: {active: () => 1, subscribe: () => () => {}}, useLocale: () => 'en',
    useTimeAxis: () => axis,
    useTip: () => ({tip: {current: null}, style: {}}), PlotLayer: () => null, PlotOverlay: () => null, Tooltip: () => null,
    clock: () => '', shortDay: () => '', workHours: () => '', stamp: () => '', t: (key: string) => key,
    prepareParent: null as unknown as () => {value: Model | null; ready: boolean}, Stacks: null as unknown as (props: object) => React.ReactNode, StackArtwork: null as unknown as (props: object) => React.ReactNode,
  };
  runInNewContext(ts.transpileModule(`function prepareParent(){${region}\nglobalThis.paint=paint;return prepared;}\n${source.slice(stacksStart)}\nglobalThis.prepareParent=prepareParent;globalThis.Stacks=Stacks;globalThis.StackArtwork=StackArtwork;`, {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText, context);
  const renderParent = () => {Object.assign(context, parent); parent.begin(); return context.prepareParent();};
  assert.equal(renderParent().value, null); assert.equal(aggregates, 0); parent.commit(); parent.finish();
  const first = renderParent().value!; assert.equal(first.identities.length, 30); assert.equal(aggregates, 1);
  const replacement = buffer(barMs); replacement.coverage = [[replacement.from, replacement.to - barMs]];
  replacement.activityCells.get(replacement.to - barMs)!.parts.project.set('pending', {ms: 60_000, name: 'New group'});
  context.strip = replacement; assert.equal(renderParent().value, first); parent.commit(); parent.tick();
  context.strip = buffer(2 * barMs); renderParent(); parent.commit(); parent.tick();
  context.strip = replacement; renderParent(); parent.commit(); parent.tick();
  const pendingAggregates=aggregates;context.pins=[['s0',CATEGORY_COLORS[8]]];renderParent();parent.commit();
  assert.equal(aggregates,pendingAggregates,'a colour update during yielded preparation does not replace its numeric work');
  parent.finish();
  const current = renderParent().value!;
  assert.equal(context.paint.get(JSON.stringify('s0')),CATEGORY_COLORS[8],'a completed pending drawing resolves the latest manual colour');
  assert.equal(context.paint.get(JSON.stringify('s8')),CATEGORY_COLORS[0]);
  assert.equal(current.identities.find(group => group.key === 'pending')?.name, 'New group');
  assert.equal(current.shown.find(row => row.group.key === 'pending')!.group.cells.length, 0, 'an unread bar contributes no height');
  const pathsOf = (node: React.ReactNode): string[] => {
    if (Array.isArray(node)) return node.flatMap(pathsOf);
    if (!React.isValidElement<{className?: string; d?: string; children?: React.ReactNode}>(node)) return [];
    if (node.type === context.StackArtwork) return pathsOf(context.StackArtwork(node.props));
    return node.props.className === 'activity-stack' && node.props.d !== undefined ? [node.props.d] : pathsOf(node.props.children);
  };
  const props = {activity: {barMs}, origin: 0, groups: current.shown,paint:context.paint, from: 0, to: length, unknownTo: null, plot: undefined, onBase: () => {}, onSelect: () => {}, strip: current.strip as PlotBuffer | null, prepared: true, navigation, by: 'project', empty: null};
  const renderChild = () => {Object.assign(context, child); child.begin(); return pathsOf(context.Stacks(props));};
  assert.deepEqual(renderChild(), []); assert.equal(draws, 0); child.commit(); child.finish();
  const actual = renderChild();
  const expected = new StackPaths().draw(current.shown, 0, 340 / length, barMs, 160, activityScale(465 * 60_000).max);
  assert.ok(actual.some(path => path.length > 0), 'prepared stacks contain nonempty geometry');
  assert.deepEqual([...actual], expected); assert.equal(draws, 1);
  const beforePalette=aggregates;
  context.pins=[['s0',CATEGORY_COLORS[1]]];
  assert.equal(renderParent().value,current);parent.commit();
  assert.equal(aggregates,beforePalette,'a colour-only update does not restart group preparation');
  props.paint=context.paint;
  assert.equal(props.paint.get(JSON.stringify('s0')),CATEGORY_COLORS[1]);
  assert.equal(props.paint.get(JSON.stringify('s1')),CATEGORY_COLORS[8],'only the conflicting automatic slot moves');
  assert.equal(props.paint.get(JSON.stringify('s8')),CATEGORY_COLORS[0]);
  assert.equal(props.paint.get(JSON.stringify('s9')),'var(--other)','neutral survivors are not promoted');
  assert.deepEqual([...renderChild()],expected);child.commit();child.finish();assert.equal(draws,1,'paint changes never rebuild numeric stack paths');
  context.pins=[];renderParent();parent.commit();props.paint=context.paint;renderChild();child.commit();child.finish();
  assert.equal(draws,1);assert.equal(props.paint.get(JSON.stringify('s9')),'var(--other)');
  props.from += 60_000; props.to += 60_000;
  axis.basis = {from: props.from, to: props.to, end: props.to};
  assert.deepEqual([...renderChild()], expected); child.commit(); child.finish();
  assert.equal(draws, 1, 'clock movement cannot redraw numeric stacks');
  props.prepared = false; props.from += barMs; props.to += barMs;
  axis.basis = {from: props.from, to: props.to, end: props.to};
  renderChild(); child.commit(); child.finish(); assert.equal(draws, 1, 'unready parent input cannot prepare borrowed data');
  props.prepared = true; renderChild(); child.commit(); child.finish(); assert.equal(draws, 2, 'reenabling schedules only the latest ready owner');
  props.strip = null; renderChild(); child.commit(); child.finish(); renderChild(); assert.equal(draws, 3);
  props.from += 60_000; props.to += 60_000; axis.basis = {from: props.from, to: props.to, end: props.to};
  renderChild(); child.commit(); child.finish();
  assert.equal(draws, 3); assert.deepEqual(tickFrame, [props.from, props.to], 'new clock ticks enter the current axis without redrawing its retained stacks');
});
