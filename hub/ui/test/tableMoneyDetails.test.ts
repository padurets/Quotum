import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {money,activeHours} from '../lib/money';
import {moneyTableValues,moneyWorkValues,moneySeriesDetail} from '../lib/moneyTable';
import {moneyTotal} from '../lib/moneyView';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {t,setLocale} from '../i18n';

const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const visibleText=(value:any):string=>Array.isArray(value)?value.map(visibleText).join(''):value&&typeof value==='object'?visibleText(typeof value.type==='function'?value.type(value.props):value.props?.children):typeof value==='string'?value:'';

for(const locale of ['en','ru'] as const)for(const layout of ['table','list'] as const)for(const overflow of [false,true])test(`${locale} ${layout} ${overflow?'overflowing':'fitting'} monetary cells disclose exact values and provenance`,()=>{
  setLocale(locale);
  try{
    let cursor=0;const slots:any[]=[],content={closest:()=>null,clientHeight:20,clientWidth:100,scrollHeight:20,scrollWidth:overflow?500:100,querySelectorAll:()=>[]},root={closest:()=>null};
    const hooks={useRef:()=>{const i=cursor++;return slots[i]??(slots[i]={current:i===0?root:content});},useState:(initial:any)=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(value:any)=>slots[i]=value];},useLayoutEffect:(effect:()=>void)=>effect()};
    const preview:any={exports:{},ResizeObserver:class{observe(){}disconnect(){}},require:(name:string)=>name==='react'?hooks:name==='react/jsx-runtime'?jsx:name==='./Popover'?{Popover:'popover'}:{t}};
    runInNewContext(compile(code('../components/TablePreview.tsx')),preview);
    const table:any={exports:{},require:(name:string)=>name==='react/jsx-runtime'?jsx:name==='./TablePreview'?preview.exports:name==='./TableWidget'?{TableHeading:'heading'}:name==='./TableCell'?{tableCell:(_key:string,cell:any,render:any)=>render('at' in cell?cell.at(1000):cell,'money-value'),TableDetails:({details}:any)=>typeof details==='string'?details:details.at(1000)}:{t}};
    runInNewContext(compile(code('../components/AnalyticsTable.tsx')),table);
    const history={live:true,range:'1h',since:0,to:3_600_000},amount='1234567890123456789';
    let value=amount;
    const work={source:'wallet',unit:'USD',activeMs:3_600_000,agentMs:3_600_000,spent:'123456789',duringWork:'123456789',eligibleActiveMs:3_600_000,eligibleAgentMs:3_600_000,coveredMs:3_600_000,knownFrom:0,partial:false,estimate:true};
    const producer:any={exports:{},require:()=>jsx,history,context:defaultCurrencyContext,hubNow:()=>1000,t,stamp:String,money,activeHours,moneyTableValues,moneyWorkValues,moneyTotal,
      boardPeriod:{moneyAt:(s:any)=>({...s,end:value}),rangeAt:()=>({from:0,to:3_600_000}),moneyWorkAt:(_source:string,at:number)=>({...work,eligibleActiveMs:work.eligibleActiveMs+at-1000}),cellChangesAt:(_scope:string,now:number,read:(at:number)=>string)=>read(now)===read(now+1)?null:now+1}};
    const source=code('../components/MoneyAnalytics.tsx');
    runInNewContext(compile(source.slice(source.indexOf('  const cellAt='),source.indexOf('  // Retained rows stay mounted'))+'\nexports.cell=cellOf;'),producer);
    const series={sourceId:'wallet',meterId:'balance',kind:'balance',role:'total',unit:'USD',start:amount,end:amount,spent:'0',topup:'123456789',coveredMs:3_600_000,semantics:{conversion:{original:{unit:'CNY'},rate:{source:'ecb'}}},unlocated:[],topupUnlocated:[],points:[]};
    const hint=moneySeriesDetail(series as any,defaultCurrencyContext),cell=producer.exports.cell(series,'value');
    assert.ok(hint.includes('ECB'),'the shared row context carries recorded conversion provenance');
    const render=(still=false)=>table.exports.AnalyticsTable({columns:[{id:'value',title:t('money.balance'),width:140}],rows:[{key:'wallet',name:'Full wallet name',hint,cells:{value:cell}}],name:'Resource',layout,lead:'value',still});
    const open=()=>{
      const entry=nodes(render()).find(node=>node.type===preview.exports.TablePreview&&node.props.details);
      assert.ok(entry,'exact semantics reach the metric through the existing timed-cell callback');
      cursor=0;preview.exports.TablePreview(entry.props);cursor=0;
      const view=preview.exports.TablePreview(entry.props),popover=nodes(view).find(node=>node.type==='popover');
      assert.ok(popover,'keyboard/touch details do not depend on spatial truncation');
      const text=visibleText(popover.props.children.props.children);
      assert.ok(text.includes(money(value,'USD',true)));assert.ok(text.includes('Full wallet name'));assert.ok(text.includes(hint));
      assert.ok(!visibleText(popover.props.trigger).includes(money(value,'USD',true)),'the ordinary amount keeps its compact rounding');
      return text;
    };
    open();value='987654321';assert.ok(open().includes(money(value,'USD',true)),'a timed replacement supplies its own current detail');
    const measured=nodes(render(true)).filter(node=>node.type===preview.exports.TablePreview&&node.props.details);
    assert.ok(measured.length);assert.ok(measured.every(node=>node.props.still),'static measurement never adds interactive controls');
    const topup=producer.exports.cell(series,'topup').at(1000);assert.ok(topup.details.at(1000).includes(money(series.topup,'USD',true)));
    const zero=producer.exports.cell({...series,topup:'0'},'topup').at(1000);assert.ok(zero.details.at(1000).includes(money('0','USD',true)));
    const rateCell=producer.exports.cell(series,'rate'),rate=rateCell.at(1000);assert.ok(rate.details.at(1000).includes(money(work.spent,'USD',true)));assert.ok(rate.details.at(1000).includes(t('money.workEstimate')));
    assert.equal(rateCell.changesAt(1000),null,'closed precise details cannot wake unchanged rounded cells');
    assert.equal(rate.details.changesAt(1000),1001,'an open precise estimate owns its separate shared-clock boundary');
  }finally{setLocale('en');}
});

test('the actual shared detail consumer reads its exact clock only after the disclosure mounts',()=>{
  let now=1000,clockReads=0,detailReads=0;
  const detail={at:(at:number)=>{detailReads++;return 'Exact '+at;},changesAt:(at:number)=>at+1};
  const context:any={exports:{},require:(name:string)=>name==='react/jsx-runtime'?jsx:name==='react'?{useMemo:(read:()=>unknown)=>read(),Fragment:jsx.Fragment}:{hubNow:()=>now,useClock:(changesAt:(at:number)=>number|null)=>{clockReads++;assert.equal(changesAt(now),now+1);return now;}}};
  runInNewContext(compile(code('../components/TableCell.tsx')),context);
  const retained=context.exports.TableDetails({details:detail});assert.equal(clockReads,0);assert.equal(detailReads,0,'constructing a closed disclosure creates no precision work');
  const first=retained.type(retained.props);assert.equal(first.props['data-time'],'table-details');assert.equal(first.props.children,'Exact 1000');
  now++;const next=retained.type(retained.props);assert.equal(next.props.children,'Exact 1001');assert.equal(clockReads,2);assert.equal(detailReads,2);
});
