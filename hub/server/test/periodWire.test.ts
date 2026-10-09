import {test} from 'node:test';
import assert from 'node:assert/strict';
import {periodDictionary,expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import type {PeriodReply} from '../domain/periodRead.js';
import type {MeterSemantics} from '../domain/meters.js';
import {compactJSON} from '../history.js';

test('period dictionaries preserve exact observations, null inheritance and recorded rate paths',()=>{
  const rate={id:'recorded',source:'manual',base:'credits:codex',from:'1000000',to:'40000',date:3,fetchedAt:4};
  const semantics:MeterSemantics={limit:null,resetAt:null,minutes:null,scope:null,label:null,scale:6,
    conversion:{original:{meterId:'balance:credits',amount:'9007199254740993001',unit:'credits:codex',at:1001,scale:12},rate,steps:[rate]}};
  const later={...semantics,conversion:{...semantics.conversion!,original:{...semantics.conversion!.original,at:2001}}};
  const basis={run:'r',revision:'1',evaluatedAt:3000,evidenceCut:3000,range:{from:0,to:3000}};
  const reply:PeriodReply={basis,funds:{state:'complete',basis,value:{now:3000,run:'r',historyStart:0,known:{work:0,sources:{}},chunks:[{
    from:0,to:3000,series:[],resets:[],grants:[],activity:{sessions:[],devices:{},cells:[]},
    meterSeries:[{source:'s',meter:'balance:credits',kind:'balance',unit:'USD',semantics:null,cells:[[0,'360287970189639720',null,null,2000,
      {semantics:later,openSemantics:semantics,observations:[{at:1001,value:'360287970189639720',validUntil:2001,semantics:structuredClone(semantics)},{at:2001,value:'360287970189639720',validUntil:3000},{at:3000,value:'360287970189639720',validUntil:3001,semantics:null}]}]]}],
  }]}}};
  const original=structuredClone(reply);let reserved=0;
  const dictionary=periodDictionary(reply,bytes=>{reserved+=bytes;});
  const json=compactJSON({...reply,moneySemantics:dictionary.moneySemantics,rateLegs:dictionary.rateLegs},dictionary.replacer);
  const wire=JSON.parse(json) as PeriodWireReply;
  assert.ok(reserved>0);assert.equal(wire.moneySemantics!.length,1);assert.equal(wire.rateLegs!.length,1);
  assert.ok(json.length<compactJSON(reply).length);
  assert.deepEqual(expandPeriod(wire),reply);
  assert.deepEqual(reply,original,'packing cannot mutate shared cells or their provenance');
  assert.equal(expandPeriod(wire),wire,'an expanded reply can be consumed again');
  const broken=JSON.parse(json);broken.rateLegs=[];
  assert.throws(()=>expandPeriod(broken),/invalid_period_rate/);
  const missing=JSON.parse(json);missing.moneySemantics=[];
  assert.throws(()=>expandPeriod(missing),/invalid_period_semantics/);
});
