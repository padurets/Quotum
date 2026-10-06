import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deepSeek,deepSeekMeasurement} from '../connectors/deepseek.js';
import {cnyInUsd,deepSeekUsd,deepSeekRateReader,parseUsdRate} from '../connectors/deepseekUsd.js';
import {ConnectorTransport} from '../connectors/transport.js';
import {Store} from '../store/store.js';
import {composeMeters} from '../domain/meterHistory.js';
import {publicSourceState} from '../projection.js';

const DAY=86_400_000,date=Date.UTC(2026,9,5),at=date+12*3_600_000;
const xml=(day='2026-10-05',usd='1',cny='7')=>`<Cube><Cube time='${day}'><Cube currency='USD' rate='${usd}'/><Cube currency='CNY' rate='${cny}'/></Cube></Cube>`;
const rate=()=>parseUsdRate(xml(),at);
const row=(currency='CNY',total='110')=>({currency,total_balance:total,granted_balance:'10',topped_up_balance:'100'});
const measurement=(time=at,rows=[row()])=>deepSeekMeasurement({is_available:true,balance_infos:rows},time);

test('ECB dates and positive exact quotes are validated before conversion',()=>{
  assert.deepEqual(rate(),{date,at,usdPerEur:'1000000',cnyPerEur:'7000000'});
  for(const invalid of [xml('2026-10-06'),xml('2026-09-20'),xml('2026-02-30'),xml('2026-10-05','0'),xml().replace("currency='CNY'","currency='EUR'"),xml().replace('</Cube>',"<Cube currency='USD' rate='2'/></Cube>"),'x'.repeat(65_537)])assert.throws(()=>parseUsdRate(invalid,at));
  assert.equal(cnyInUsd('110000000',rate()),'15714286');
  assert.equal(cnyInUsd('-110000000',rate()),'-15714286');assert.equal(cnyInUsd('0',rate()),'0');
  assert.equal(cnyInUsd('9007199254740993',{...rate(),usdPerEur:'1000000',cnyPerEur:'2000000'}),'4503599627370497');
});

test('native USD wins; CNY-only estimates preserve original measurements and never combine currencies',()=>{
  const native=measurement(at,[row(),row('USD','37')]);assert.equal(deepSeekUsd(native,rate()),native);
  const original=measurement(),converted=deepSeekUsd(original,rate());
  assert.deepEqual(converted.meters.slice(0,3),original.meters);
  assert.deepEqual(converted.meters.slice(3).map(m=>[m.id,m.unit,m.amount]),[
    ['converted:balance:USD','USD','15714286'],['converted:granted:USD','USD','1428571'],['converted:topped_up:USD','USD','14285714'],
  ]);
  assert.ok(converted.meters.slice(3).every(m=>m.scope==='ecb:2026-10-05'&&m.label==='≈ CNY → USD (ECB)'&&m.at===at));
  const unavailable=deepSeekUsd(original);assert.deepEqual(unavailable.meters,original.meters);assert.ok(unavailable.balanceStatus?.issues.includes('rate_unavailable'));
  assert.deepEqual(deepSeekUsd(original,{...rate(),date:date-7*DAY}).meters,original.meters);
});

test('the fixed public rate read is bounded, cached and receives no provider credentials',async()=>{
  let now=at,calls=0;
  const read:typeof fetch=async(input,options)=>{
    calls++;assert.equal(input,'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    assert.equal(options?.redirect,'error');assert.ok(options?.signal);
    assert.deepEqual(options?.headers,{Accept:'application/xml'});
    return new Response(xml(),{headers:{'Content-Type':'application/xml'}});
  };
  const get=deepSeekRateReader(read,()=>now);assert.deepEqual(await get(),rate());assert.deepEqual(await get(),rate());assert.equal(calls,1);
  now+=13*3_600_000;assert.ok(await get());assert.equal(calls,2);
  const failed=deepSeekRateReader(async()=>new Response('bad gateway',{status:503}),()=>at);
  assert.equal(await failed(),undefined);assert.equal(await failed(),undefined);
  const oversized=deepSeekRateReader(async()=>new Response('x'.repeat(65_537),{headers:{'Content-Type':'application/xml'}}),()=>at);assert.equal(await oversized(),undefined);
  const controller=new AbortController();controller.abort();
  const cancelled=deepSeekRateReader(async(_input,options)=>{assert.equal(options?.signal?.aborted,true);throw new DOMException('cancelled','AbortError');},()=>at);
  assert.equal(await cancelled(controller.signal),undefined);
});

test('the actual connector reads a rate only for CNY and keeps the secret in its balance transport',async()=>{
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),secret=Buffer.from('sk-'+'a'.repeat(32));let calls=0,rows=[row()];
  transport.send=async(operation,token)=>{assert.equal(operation,'balance');assert.equal(token,secret);return {is_available:true,balance_infos:rows};};
  const adapter=deepSeek(transport,()=>at,async(signal)=>{assert.equal(signal,undefined);calls++;return rate();});
  try {
    assert.ok((await adapter.identify(secret)).measurement?.meters.some(m=>m.id==='converted:balance:USD'));assert.equal(calls,1);
    rows=[row('USD','37')];const native=await adapter.identify(secret);assert.equal(calls,1);assert.ok(!native.measurement?.usdRate);
    rows=[row(),row('USD','37')];await adapter.identify(secret);assert.equal(calls,1);
  }finally{transport.close();}
});

test('originals, USD estimates and rate provenance survive restart without inferred spending',()=>{
  const dir=mkdtempSync(join(tmpdir(),'quotum-usd-')),file=join(dir,'hub.sqlite');let store=new Store(file,at);
  try {
    const id=store.source('deepseek','1'.repeat(24),at);
    const first=deepSeekUsd(measurement(),rate());
    store.record(id,{...first,usdRate:{...rate(),private:'SECRET_CANARY'} as ReturnType<typeof rate>});
    const nextAt=at+DAY,nextRate=parseUsdRate(xml('2026-10-06','2','7'),nextAt);
    store.record(id,deepSeekUsd(measurement(nextAt),nextRate));
    assert.equal(store.meters.readings(id,'balance:CNY',0,nextAt+1).length,1);
    assert.equal(store.meters.readings(id,'converted:balance:USD',0,nextAt+1).length,2);
    assert.equal(JSON.stringify(store.state(id)).includes('SECRET_CANARY'),false);
    const contexts=store.meters.contexts.history(id,'usdRate',0,nextAt+1);assert.equal(contexts.length,2);assert.equal(contexts[0].value.type,'usdRate');
    store.close();store=new Store(file,nextAt);
    assert.deepEqual(publicSourceState(store.state(id)).usdRate,nextRate);
    const series=composeMeters([{from:at,meterSeries:store.meters.cells({unit:'USD',ids:[[id,'converted:balance:USD']]},at,nextAt+60_000,60_000)}],60_000,at,nextAt+60_000)[0];
    assert.equal(series.spent,null);assert.equal(series.topup,null);assert.ok(series.semantics?.label?.includes('≈'));
    store.record(id,deepSeekUsd(measurement(nextAt+120_000)));
    assert.equal(store.state(id).meters?.find(m=>m.id==='converted:balance:USD')?.stale,true);
    assert.equal(store.state(id).meters?.find(m=>m.id==='balance:CNY')?.stale,false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
