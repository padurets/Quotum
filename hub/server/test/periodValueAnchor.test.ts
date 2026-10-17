import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withValueStates,hasPeriodValue,periodValueAt,type PeriodValues} from '../domain/periodValues.js';

const rate={id:'recorded',source:'codex-default',base:'credits:codex',date:0,fetchedAt:18,from:'1000000',to:'40000'};
const selected:PeriodValues={id:'s',provider:'codex',windows:[],keys:[],validFor:{from:20,to:30},meters:[
  {id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'9007199254740993',scale:12,at:19,staleAfterMs:100,validUntil:120,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null},
  {id:'fx:USD:balance:credits',kind:'balance',unit:'USD',amount:'360287970',scale:6,at:19,staleAfterMs:100,validUntil:120,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null,
    conversion:{original:{meterId:'balance:credits',amount:'9007199254740993',unit:'credits:codex',at:19,scale:12},rate}},
]};
const earlier:PeriodValues[]=[{...selected,validFor:{from:0,to:10},meters:[]},{...selected,validFor:{from:10,to:20},meters:selected.meters.map(meter=>({...meter,amount:'0',at:9,...(meter.conversion?{conversion:{...meter.conversion,original:{...meter.conversion.original,amount:'0',at:9}}}:{})}))}];
const projection=(value:PeriodValues|undefined)=>{if(!value)return value;const {states:_states,...native}=value;return native;};

test('a retained value anchor restores exact native and converted facts after recurrent earlier navigation',()=>{
  const value=withValueStates(selected,earlier,()=>{}),before=JSON.stringify(value);
  let current=value;
  for(const to of [5,25,15,20,5,29,0,25]){
    const sequence=current.states!,next=periodValueAt(current,to);assert.ok(next);current=next;
    if(sequence.start)assert.strictEqual(current.states,sequence);
    const expected=to>=20?selected:to>=10?earlier[1]:earlier[0];assert.deepEqual(projection(current),expected);
    assert.ok(current.states!.start);assert.equal(current.states!.start!.meters[0].conversion,undefined);
    if(to>=20){
      assert.strictEqual(current.meters,current.states!.start!.meters);
      assert.deepEqual(current.meters[1].conversion,{original:{meterId:'balance:credits',amount:'9007199254740993',unit:'credits:codex',at:19,scale:12},rate});
    }
  }
  assert.equal(hasPeriodValue(current,30),false);assert.equal(periodValueAt(current,30),undefined);
  assert.equal(JSON.stringify(value),before,'replay cannot mutate the retained original value or its program');
});

test('current valid values take precedence over an overlapping saved anchor',()=>{
  const first=periodValueAt(withValueStates(selected,earlier,()=>{}),5)!;
  const current={...first,validFor:{from:20,to:22},meters:[]};
  assert.equal(hasPeriodValue(current,21),true);assert.strictEqual(periodValueAt(current,21),current);
  assert.deepEqual(periodValueAt(current,25)!.meters,selected.meters);
});

test('anchor availability uses only its explicit half-open interval and keeps missing distinct from zero',()=>{
  const first=periodValueAt(withValueStates(selected,earlier,()=>{}),5)!;
  assert.equal(periodValueAt(first,5)!.meters.length,0);assert.equal(periodValueAt(first,15)!.meters[0].amount,'0');
  assert.equal(hasPeriodValue(first,20),true);assert.equal(hasPeriodValue(first,29),true);assert.equal(hasPeriodValue(first,30),false);
  assert.equal(hasPeriodValue(first,-1),false);assert.equal(periodValueAt(first,-1),undefined);
  const partial={...first,states:{...first.states!,start:{...first.states!.start!,validFor:{from:20,to:25}}}};
  assert.equal(hasPeriodValue(partial,24),true);assert.equal(hasPeriodValue(partial,25),false);
  const missing={...first,states:{...first.states!,start:{...first.states!.start!,validFor:undefined}}};
  assert.equal(hasPeriodValue(missing,25),false);assert.equal(periodValueAt(missing,25),undefined);
});

test('existing full value programs remain usable when no saved anchor has an interval',()=>{
  const base={...selected,validFor:undefined},value=withValueStates(base,[...earlier,selected],()=>{});
  const first=periodValueAt(value,5)!;assert.ok(first);assert.equal(first.states!.start!.validFor,undefined);
  assert.deepEqual(projection(periodValueAt(first,25)),selected);assert.equal(hasPeriodValue(first,30),false);
});
