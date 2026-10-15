import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {periodValues} from '../../server/periodValues';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {observationDeadline} from '../../server/domain/resources';
import {providerOf} from '../../server/domain/providers';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as money from '../lib/money';
import {quotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import {t,setLocale} from '../i18n';

type Node={type:unknown;props:Record<string,unknown>};
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props});
const runtime={jsx,jsxs:jsx,Fragment:'fragment'};
const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
function nodes(value:unknown):Node[] {
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;
  if(typeof node.type==='function')return nodes(node.type(node.props));
  return [node,...nodes(node.props.children),...nodes(node.props.trigger)];
}

test('retained unlimited credits and confirmed zero are measurements in the card and footer in both languages',()=>{
  const now=1_800_000_000_000,at=now-600_000,edge=now-300_000,store=new Store(':memory:',now-3_600_000);
  try {
    const directory=new Directory(store.db),user=directory.createUser('evidence@example.test','Evidence','unused',now-3_600_000),id=store.source('codex','unlimited',now-3_600_000);
    store.hold(id,user.id,now-3_600_000);
    store.record(id,{observedAt:at,staleAfterMs:3_600_000,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'unlimited',hasCredits:true}]});
    const read=(to=edge)=>periodValues(store,store.sources(directory.boards(user.id)[0].id),user.id,to,()=>{})[0];
    const value=read();assert.equal(value.creditBalance?.status,'unlimited');assert.deepEqual(value.windows,[]);assert.deepEqual(value.meters,[]);
    const reading={value,basis:{range:{from:now-3_600_000,to:edge}},loading:false,error:null};
    const source={...value,budget:{enabled:true}};
    const context={exports:{} as Record<string,(props:unknown)=>Node>,components:{} as Record<string,(props:unknown)=>Node>,require:()=>runtime,...money,t,observationDeadline,
      useMeasurementClock:()=>edge,stamp:String,day:String,rateText:String,StatusMark:'status',Popover:'popover',MoneyCard:'money-card',ErrorLine:'error',BudgetKeyMetrics:'keys',
      usePeriodValues:()=>reading,useTimeRange:()=>reading.basis.range,useCurrencyContext:()=>defaultCurrencyContext,quotaPeriods,hasSubscriptionCaps,providerOf,
      isWindowHidden:()=>false,planOf:()=>null,keyShown:()=>true,MeasurementClock:{Provider:'clock'},PeriodStatus:'period-status',QuotaCard:'quota',Limit:'limit',AllHidden:'hidden',
      MoneyValues:undefined as unknown,CardTray:({funds}:{funds:unknown})=>({type:'footer',props:{children:funds}}),
    };
    const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
    const funds=code('../components/MoneyCard.tsx');run(funds.slice(funds.indexOf('export function MoneyValues('),funds.indexOf('/** Safe supplier facts')));context.MoneyValues=context.exports.MoneyValues;
    const card=code('../components/SourceCard.tsx');run(card.slice(card.indexOf('function CardMeasurements('))+'\nglobalThis.components={CardMeasurements,CardFooter};');
    const props={source,arrange:{view:EMPTY_VIEW},boardId:'b'};
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      const body=nodes(context.components.CardMeasurements(props)),footer=nodes(context.components.CardFooter(props));
      assert.equal(body.some(node=>node.props.children===t('period.noEvidence')),false);
      assert.ok(footer.some(node=>node.type==='b'&&node.props.children==='∞'),'the retained unlimited observation reaches the actual funds renderer');
      assert.equal(footer.find(node=>node.type==='status')?.props.label,[t('money.additionalFunds'),t('money.unlimited')].join('\n'));
    }
    store.record(id,{observedAt:edge-10_000,staleAfterMs:3_600_000,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'0',hasCredits:true}]});
    reading.value=read();
    const zero=reading.value.meters.find(m=>m.id==='balance:credits')!;
    assert.equal(zero.amount,'0');
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      assert.equal(nodes(context.components.CardMeasurements(props)).some(node=>node.props.children===t('period.noEvidence')),false);
      assert.ok(nodes(context.components.CardFooter(props)).some(node=>node.type==='b'&&node.props.children===money.money('0',zero.unit,true,defaultCurrencyContext,zero.scale)));
    }
    reading.value=read(at);reading.basis.range.to=at;
    assert.deepEqual(reading.value.meters,[]);assert.equal(reading.value.creditBalance,undefined);
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      assert.ok(nodes(context.components.CardMeasurements(props)).some(node=>node.props.children===t('period.noEvidence')),'a successful read before the first observation still discloses the missing evidence');
    }
  } finally {setLocale('en');store.close();}
});
