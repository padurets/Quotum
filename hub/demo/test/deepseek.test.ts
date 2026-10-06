import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEEPSEEK_SCENES,deepSeekPayload,demoRates} from '../deepseek.js';
import {deepSeekMeasurement} from '../../server/connectors/deepseek.js';
import {Store} from '../../server/store/store.js';
import {composeMeters} from '../../server/domain/meterHistory.js';
import {balanceGroups} from '../../ui/lib/money.js';
import type {Card} from '../../ui/lib/types.js';

test('every durable DeepSeek catalogue code is backed by actual parsed and retained state',()=>{
  const codes=new Set<string>();
  for(const scene of DEEPSEEK_SCENES) {
    const store=new Store(':memory:',1);try {
      const id=store.source('deepseek','1'.repeat(24),1);
      const record=(at:number,answer:unknown)=>{const measured=deepSeekMeasurement(answer,at);store.record(id,measured);const quote=store.currencies.save(demoRates(at));if(!measured.meters.some(m=>m.unit==='USD'))for(const native of measured.meters)store.currencies.record(id,native,'USD',quote);};
      record(1,deepSeekPayload(scene.id,true));
      if(scene.id==='recovery') {
        record(60_010,{is_available:true,balance_infos:[]});record(60_020,deepSeekPayload(scene.id));
      }else record(60_001,deepSeekPayload(scene.id));
      if(scene.id==='stale'||scene.id==='rejected')store.fail(id,scene.id==='stale'?'connector_failed':'credential_rejected');
      const state=store.state(id),derived=(state.meters??[]).flatMap(m=>m.unit==='USD'?[]:store.currencies.project(id,m,'USD',60_001)??[]),card:Card={...state,meters:[...(state.meters??[]),...derived],stale:false,owners:[],measureIntervalMs:null},groups=balanceGroups(card),seen=new Set<string>();
      for(const group of groups){seen.add(group.total.unit);if(group.components.length===2)seen.add('components');if(group.total.amount==='110000000')seen.add('total-110');if(group.total.amount==='0')seen.add('zero');if(BigInt(group.total.amount)>0n)seen.add('positive');}
      if(groups.length===2)seen.add('separate-currencies');
      if(groups.some(g=>g.approximate&&g.total.unit==='USD'))seen.add('usd-estimate');
      if(state.balanceStatus?.isAvailable===false)seen.add('unavailable-funds');
      if(state.balanceStatus?.partial)seen.add('partial');
      if(state.meters?.some(m=>m.unit==='USD'&&m.stale))seen.add('stale-USD');
      if(!groups.length){seen.add('no-balance');if(!state.meters?.length)seen.add('no-zero');}
      const history=composeMeters([{from:0,meterSeries:store.meters.cells({unit:'CNY',ids:[[id,'balance:CNY']]},0,180_000,60_000)}],60_000,0,180_000);
      if(history.every(s=>s.spent===null&&s.topup===null))seen.add('balance-only');
      if(store.meters.spans(id,'balance:USD',0,180_000).some(s=>s.interruptedAt!==undefined))seen.add('hard-gap');
      if(state.error==='connector_failed'){seen.add('stale');if(groups.length)seen.add('last-good');}
      if(state.error==='credential_rejected'){seen.add('private-rejected');seen.add('public-unmeasured');}
      if(scene.id==='recovery'){assert.equal(store.meters.readings(id,'balance:CNY',0,180_000).length,1);if(history[0].points.some(p=>p.at===60_020)){seen.add('same-value-recovery');seen.add('actual-anchor');}}
      // Identity, expiry and sharing labels are exercised through actual owner routes
      // in server/test/deepseek.test.ts; the catalogue's Work fixture declares them.
      if(scene.id==='work'){seen.add('named-account');seen.add('unknown-expiry');seen.add('sharing-label');}
      for(const code of scene.expect){assert.ok(seen.has(code),scene.id+': '+code);codes.add(code);}
    }finally{store.close();}
  }
  assert.ok(codes.size>=20);
});
