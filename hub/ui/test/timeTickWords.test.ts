import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import * as periods from '../lib/periods';
import {clock, shortDay} from '../lib/format';
import {setLocale} from '../i18n';

const H=3_600_000;
type Range={from:number;to:number};

/** Run the actual tick declarations and the actual SVG text expression of each chart. */
function words(file:'Activity'|'Chart',presentation:Range,width:number,strip:Range|null=null){
  const source=readFileSync(new URL(`../components/${file}.tsx`,import.meta.url),'utf8');
  const tree=ts.createSourceFile(`${file}.tsx`,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const declarations:string[]=[];
  let label='';
  const bindingNames=(name:ts.BindingName):string[]=>ts.isIdentifier(name)?[name.text]:name.elements.flatMap(element=>ts.isBindingElement(element)?bindingNames(element.name):[]);
  const visit=(node:ts.Node)=>{
    if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>bindingNames(declaration.name).some(name=>['tickFrom','ticks','tickWords'].includes(name))))declarations.push(node.getText(tree));
    if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='PlotLayer'){
      const ticks=node.openingElement.attributes.properties.find(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(tree)==='ticks');
      const findText=(child:ts.Node)=>{
        if(ts.isJsxElement(child)&&child.openingElement.tagName.getText(tree)==='text'){
          const value=child.children.find(ts.isJsxExpression);
          if(value?.expression)label=value.expression.getText(tree);
        }
        ts.forEachChild(child,findText);
      };
      if(ticks)findText(ticks);
    }
    ts.forEachChild(node,visit);
  };
  visit(tree);
  assert.ok(label&&declarations.some(declaration=>declaration.includes('niceTicks')),'the current chart owns the exercised text and timestamp calculation');
  const context={...periods,clock,shortDay,presentation,strip,width,narrow:width<560,read:null as unknown as ()=>{at:number;text:string}[]};
  runInNewContext(ts.transpileModule(`globalThis.read=()=>{${declarations.join('\n')}\nreturn ticks.map((tick,index)=>({at:tick,text:${label}}));};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return [...context.read()].map(value=>({...value}));
}

for(const locale of ['en','ru'] as const)for(const file of ['Activity','Chart'] as const)test(`${file} retains calendar context on a wide multi-day axis in ${locale}`,()=>{
  setLocale(locale);
  const presentation={from:new Date(2026,9,20,3,17,17).getTime(),to:new Date(2026,9,23,3,17,17).getTime()};
  const result=words(file,presentation,788);
  assert.deepEqual(result.map(value=>value.at),periods.niceTicks(presentation.from,presentation.to,7,presentation).ticks,'formatting cannot move the timestamps');
  assert.deepEqual(result.map(value=>new Date(value.at).getDate()),[20,21,21,22,22,23]);
  const expected=result.map((value,index)=>index===2||index===4?clock(value.at):shortDay(value.at));
  assert.deepEqual(result.map(value=>value.text),expected,'different calendar days cannot be represented only by repeated clock labels');
  setLocale('en');
});

for(const file of ['Activity','Chart'] as const)test(`${file} formats the presented interval independently of a borrowed strip`,()=>{
  setLocale('en');
  const to=Date.UTC(2026,9,23,3,17,17),presentation={from:to-72*H,to},strip={from:to-96*H,to:to+24*H};
  const plain=words(file,presentation,788),borrowed=words(file,presentation,788,strip).filter(value=>value.at>=presentation.from&&value.at<=presentation.to);
  assert.deepEqual(borrowed,plain,'offscreen ticks must not remove the first represented day');
  const narrow=words(file,presentation,400);
  assert.ok(narrow.every(value=>value.text===shortDay(value.at)),'daily ticks keep their compact dates');
  const ready={from:to-24*H,to};
  assert.notDeepEqual(words(file,ready,788),plain,'a coherent replacement uses its own interval');
});

for(const zone of ['UTC','Europe/Moscow','America/New_York','Australia/Lord_Howe'])test(`tick dates follow local days, including clock transitions, in ${zone}`,()=>{
  const code=`
    import assert from 'node:assert/strict';
    import {timeTickWords} from ${JSON.stringify(new URL('../lib/periods.ts',import.meta.url).href)};
    import {clock,shortDay} from ${JSON.stringify(new URL('../lib/format.ts',import.meta.url).href)};
    import {setLocale} from ${JSON.stringify(new URL('../i18n/index.ts',import.meta.url).href)};
    for(const locale of ['en','ru']){
      setLocale(locale);
      const ticks=[[20,18],[20,20],[20,23],[21,1],[21,6],[22,1]].map(([day,hour])=>new Date(2026,9,day,hour).getTime());
      const presentation={from:ticks[1]-1,to:ticks[4]+1};
      assert.deepEqual(timeTickWords(ticks,false,presentation),ticks.map((at,index)=>[0,1,3,5].includes(index)?shortDay(at):clock(at)));
      assert.deepEqual(timeTickWords(ticks,true,presentation),ticks.map(shortDay));
      const future=[8,12,16,20,24,28].map(hour=>new Date(2026,9,20,hour).getTime());
      assert.deepEqual(timeTickWords(future,false,{from:future[0]-1,to:future.at(-1)+1}),future.map((at,index)=>index===0||index===4?shortDay(at):clock(at)));
      const transitions=process.env.TZ==='America/New_York'?[
        ['2026-11-01T00:30:00-04:00','2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00','2026-11-01T02:30:00-05:00','2026-11-02T00:30:00-05:00'],
        ['2026-03-08T00:30:00-05:00','2026-03-08T01:30:00-05:00','2026-03-08T03:30:00-04:00','2026-03-09T00:30:00-04:00']
      ]:process.env.TZ==='Australia/Lord_Howe'?[
        ['2026-10-04T00:30:00+10:30','2026-10-04T01:30:00+10:30','2026-10-04T02:30:00+11:00','2026-10-04T03:30:00+11:00','2026-10-05T00:30:00+11:00']
      ]:[];
      for(const stamps of transitions){
        const ticks=stamps.map(Date.parse);
        assert.deepEqual(timeTickWords(ticks,false,{from:ticks[0],to:ticks.at(-1)}),ticks.map((at,index)=>index===0||index===ticks.length-1?shortDay(at):clock(at)));
      }
    }
  `;
  execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,TZ:zone},stdio:'pipe'});
});
