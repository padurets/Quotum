import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {seriesFocusStyle} from '../components/seriesFocus';

test('actual chart artwork retains its JSX on clock and gesture renders and replaces all evidence on new data',()=>{
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8'),start=source.indexOf('  const seriesArtwork='),end=source.indexOf('  return (',start);
  assert.ok(start>=0&&end>start);
  let cursor=0,nodes=0,styles=0;
  const slots:{deps:unknown[];value:unknown}[]=[];
  const useMemo=(read:()=>unknown,deps:unknown[])=>{const i=cursor++;if(!slots[i]||deps.some((value,j)=>!Object.is(value,slots[i].deps[j])))slots[i]={deps,value:read()};return slots[i].value;};
  const line={key:'s w',sourceId:'s',windowId:'w',color:'blue',dash:''};
  const context={useMemo,seriesFocusStyle:(key:string)=>{styles++;return seriesFocusStyle(key);},node:(tag:unknown,props:Record<string,unknown>,...children:unknown[])=>{nodes++;return {tag,props,children};},
    lines:[line],paths:[{line:'M0,0L1,1',parts:[{key:'a',line:'M0,0L1,1'},{key:'b',line:'M2,2L3,3'}],last:[3,3],latest:60,observation:50}],paint:null as unknown as ()=>{seriesArtwork:any[];seriesEnds:any[]}};
  runInNewContext(ts.transpileModule(`function paint(){${source.slice(start,end)}\nreturn {seriesArtwork,seriesEnds};}\nglobalThis.paint=paint;`,{fileName:'artwork.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,jsxFactory:'node'}}).outputText,context);
  const paint=()=>{cursor=0;return context.paint();},first=paint(),initialNodes=nodes,initialStyles=styles;
  assert.equal(first.seriesArtwork[0].props['data-series'],'s w');assert.equal(first.seriesArtwork[0].props['data-observation'],50);
  assert.equal(first.seriesArtwork[0].children[0][1].props.d,'M2,2L3,3');
  assert.equal(first.seriesEnds[0].children[1].props.cx,3);
  for(let i=0;i<50;i++){const current=paint();assert.equal(current.seriesArtwork,first.seriesArtwork);assert.equal(current.seriesEnds,first.seriesEnds);}
  assert.equal(nodes,initialNodes,'unchanged numeric data creates no series or endpoint JSX on a clock or phase render');
  assert.equal(styles,initialStyles,'the chart does not revisit the shared focus helper either');
  context.paths=[{line:'M0,0L8,8',parts:[{key:'new',line:'M0,0L8,8'}],last:[8,8],latest:80,observation:70}];
  const fresh=paint();assert.notEqual(fresh.seriesArtwork,first.seriesArtwork);assert.equal(fresh.seriesArtwork[0].props['data-last'],80);
  assert.equal(fresh.seriesArtwork[0].children[0][0].props.d,'M0,0L8,8');assert.equal(fresh.seriesEnds[0].children[0].props.cx,8);
  assert.equal(first.seriesArtwork[0].props['data-last'],60,'new data leaves the old publication untouched');
  context.lines=[{...line,key:'replacement',sourceId:'replacement'}];const replacement=paint();assert.equal(replacement.seriesArtwork[0].props['data-series'],'replacement w');
  context.lines=[];context.paths=[];const retired=paint();assert.equal(retired.seriesArtwork.length,0);assert.equal(retired.seriesEnds.length,0,'authority retirement cannot retain former artwork');
});
