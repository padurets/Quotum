import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest, type Credential} from '../ingest.js';
import {Attention} from '../attention.js';
import {Forecasts, type Why} from '../forecasts.js';
import {Cadence} from '../cadence.js';
import {Duty} from '../duty.js';
import {newSecret} from '../domain/auth.js';
import {parseBatch, toMeasurement} from '../domain/ingest.js';
import {forecastOf} from '../domain/forecast.js';
import type {AttentionEvents} from '../domain/attention.js';
import {config} from '../config.js';
import {readHistory} from './historyRead.js';

const T = Date.parse('2026-10-08T12:00:00Z'), HOUR = 3_600_000;
const account = 'a'.repeat(24), iso = (at: number) => new Date(at).toISOString();
const agent = {version:1,agent:'fixture',machine:{id:'fixture-machine-0123456789',name:'Fixture',os:'linux',arch:'x86_64'}};
const snapshot = (at: number, extra: Record<string,unknown> = {}) => ({provider:'codex',account,observedAt:iso(at),via:'fixture',plan:'pro',staleAfterMs:HOUR,
  windows:[{id:'weekly',kind:'weekly',usedPercent:65,minutes:10080,resetsAt:iso(T+7*24*HOUR)}],...extra});
const batch = (at: number, snapshots: unknown[]) => ({...agent,sentAt:iso(at),snapshots});
const missing = (status = 'missing') => ({windows:[],resourceStatus:{windows:status,resets:'missing'}});
const record = (store: Store, source: string, at: number, extra: Record<string,unknown> = {}) => store.record(source,toMeasurement(parseBatch(batch(at,[snapshot(at,extra)])).snapshots[0]));

test('legacy resource anchors are captured before quota-only and status-only merges', t => {
  for (const lateReset of [false,true]) {
    const store = new Store(':memory:',T), source = store.source('codex',account,T);
    t.after(() => store.close());
    record(store,source,T+10,{staleAfterMs:1000,resets:{available:2}});
    const {resources,delivery,...legacy} = store.state(source);
    store.db.prepare('UPDATE state SET payload=? WHERE source_id=?').run(JSON.stringify(legacy),source);
    record(store,source,T+30,{staleAfterMs:4000});
    assert.deepEqual(store.state(source).resources?.resets,{status:'observed',at:T+10,staleAfterMs:1000,valueAt:T+10,valueStaleAfterMs:1000});
    if (lateReset) {
      const result = record(store,source,T+25,{...missing(),resourceStatus:{windows:'missing',resets:'observed'},staleAfterMs:2000,resets:{available:3}});
      assert.equal(result.resets,true);
      assert.equal(result.delivery,false);
    }
    record(store,source,T+40,missing());
    assert.equal(store.state(source).resources?.resets?.valueAt,T+(lateReset?25:10));
    assert.equal(store.state(source).resources?.resets?.valueStaleAfterMs,lateReset?2000:1000);
    assert.equal(store.state(source).successAt,T+30);
  }
});

test('reset grant continuity depends only on reset status and its own promise', t => {
  for (const order of [[10,25,30],[10,30,25]]) {
    for (const interrupted of [false,true]) {
      const store = new Store(':memory:',T), source = store.source('codex',account,T);
      t.after(() => store.close());
      for (const at of order) {
        record(store,source,T+at,{staleAfterMs:1000,...(at===30?{}:{resets:{available:at===10?2:3}})});
        if (at===10 && interrupted) record(store,source,T+20,missing());
      }
      assert.deepEqual(store.db.prepare("SELECT at,detail FROM events WHERE kind='resets_granted'").all().map(r=>[r.at,r.detail]),interrupted?[]:[[T+25,'1']]);
      assert.equal(store.state(source).resets?.available,3);
      assert.equal(store.state(source).resources?.resets?.at,T+25);
    }
  }
  const store = new Store(':memory:',T), source = store.source('codex',account,T);
  t.after(() => store.close());
  record(store,source,T,{staleAfterMs:10,resets:{available:2}});
  record(store,source,T+15,{staleAfterMs:1000});
  record(store,source,T+25,{resets:{available:3}});
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='resets_granted'").get()?.n,0);
});

for (const mode of ['Auto','fixed']) for (const resource of ['none','duplicate','late credits','equal credits','late resets','fresh credits']) {
test(`${mode} restart with ${resource} before the first check-in retains its delivery policy`, t => {
  const store = new Store(':memory:',T), directory = new Directory(store.db);
  t.after(() => store.close());
  const user = directory.createUser('fixture@example.com','Fixture','x',T), secret = newSecret('qt_m');
  directory.createToken(secret,'fixture',user.id,'fixture',T);
  let ingest = new Ingest(store,directory,new Duty(),new Cadence());
  const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const ask = (at: number) => ingest.checkin(credential,{...agent,paced:true,subscriptions:[{provider:'codex',account,active:false}]},T+at).subscriptions[0];
  const deliver = (now: number, at: number, extra = {}) => ingest.accept(credential,batch(T+now,[snapshot(T+at,{staleAfterMs:420_000,...extra})]),T+now);
  ask(0); deliver(0,0);
  const source = store.findSource('codex',account)!;
  if (mode === 'fixed') {
    store.setMeasureInterval(source,300_000);
    ingest.frequencyChanged(source,T);
  }
  deliver(1_800_000,1_800_000);
  const duty = new Duty();
  ingest = new Ingest(store,directory,duty,new Cadence());
  const fresh = resource === 'fresh credits';
  const baseline = fresh ? 1_850_000 : 1_800_000;
  if (resource !== 'none') {
    const at = resource === 'equal credits' ? 1_800_000 : fresh ? 1_850_000 : 1_500_000;
    const extra = resource.endsWith('credits')
      ? {...missing(),balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'2500'}]}
      : resource === 'late resets' ? {resets:{available:2}} : {};
    const result = deliver(1_860_000,at,extra);
    assert.deepEqual([result.accepted,result.duplicates],resource === 'duplicate' ? [0,1] : [1,0]);
    if (resource.endsWith('credits')) assert.equal(store.state(source).creditBalance?.at,T+at);
    if (resource === 'late resets') assert.equal(store.state(source).resources?.resets?.at,T+at);
  }
  if (!fresh) assert.equal(duty.holder(account),null,'nonadvancing evidence claims no delivery lease');
  assert.deepEqual(store.state(source).delivery,{at:T+baseline,staleAfterMs:420_000});
  assert.equal(store.state(source).successAt,T+1_800_000,'independent resources do not refresh quota data');
  assert.equal(ask(1_860_000).measure,mode === 'Auto' && !fresh);
  assert.deepEqual(ingest.nextMeasurement(source,account,T+1_860_000).value,
    mode === 'fixed' ? {next:T+baseline+300_000,why:'fixed'} : fresh ? {next:T+baseline+120_000,why:'idle'} : null);
});
}

test('nonadvancing resources acknowledge only their sender\'s recent command without satisfying refresh or renewing duty', t => {
  for (const sameDevice of [false,true]) for (const observed of [-10_001,0]) {
    const store = new Store(':memory:',T), directory = new Directory(store.db);
    t.after(() => store.close());
    const user = directory.createUser('fixture@example.com','Fixture','x',T), secret = newSecret('qt_m');
    directory.createToken(secret,'fixture',user.id,'fixture',T);
    let ingest = new Ingest(store,directory,new Duty(),new Cadence());
    const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
    ingest.accept(credential,batch(T,[snapshot(T)]),T);
    const source = store.findSource('codex',account)!;
    const duty = new Duty();
    ingest = new Ingest(store,directory,duty,new Cadence());
    const ask = (at: number) => ingest.checkin(credential,{...agent,paced:true,subscriptions:[{provider:'codex',account,active:false}]},T+at).subscriptions[0];
    assert.equal(ask(20_000).measure,true);
    assert.equal(ingest.requestRefresh(source,T+21_000).status,'accepted');
    const lease = duty.until(account);
    const late = batch(T+25_000,[snapshot(T+observed,{...missing(),staleAfterMs:24*HOUR,balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'2500'}]})]);
    if (!sameDevice) late.machine = {...agent.machine,id:'other-machine-0123456789'};
    assert.equal(ingest.accept(credential,late,T+25_000).accepted,1);
    assert.deepEqual(store.state(source).delivery,{at:T,staleAfterMs:HOUR});
    assert.equal(duty.until(account),lease,'an accepted resource retains the existing lease');
    assert.equal(ingest.refresh(source,T+25_000).value.request?.status,'waiting','refresh still requires a newer delivery');
    assert.equal(ask(110_000).measure,!(sameDevice && observed === 0),'only an eligible acknowledgement ends the unanswered retry');
  }
});

test('unavailable windows invalidate attention and recovery becomes a silent baseline', t => {
  for (const status of ['missing','invalid','unsupported']) {
    const store = new Store(':memory:',T), directory = new Directory(store.db);
    t.after(() => store.close());
    const user = directory.createUser('fixture@example.com','Fixture','x',T), secret = newSecret('qt_m');
    directory.createToken(secret,'fixture',user.id,'fixture',T);
    const ingest = new Ingest(store,directory,new Duty(),new Cadence()), attention = new Attention(store,T);
    ingest.attention = attention;
    const changes: AttentionEvents[] = [];
    attention.onEvents = event => changes.push(event);
    const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
    const deliver = (at: number, used: number | null) => ingest.accept(credential,batch(T+at,[snapshot(T+at,used===null?missing(status):{windows:[{id:'weekly',kind:'weekly',usedPercent:used,minutes:10080,resetsAt:iso(T+7*24*HOUR)}]})]),T+at);
    deliver(0,65); changes.length=0;
    deliver(1000,null);
    const source = store.findSource('codex',account)!;
    assert.deepEqual([...changes],[{candidates:[],invalidations:[{sourceId:source,windowId:'weekly',at:T+1000}]}]);
    deliver(2000,71);
    assert.deepEqual(changes.flatMap(c=>c.candidates),[]);
    deliver(3000,92);
    assert.deepEqual(changes.flatMap(c=>c.candidates).map(c=>c.kind),['critical']);
    const history = readHistory(store,directory.boards(user.id)[0].id,T,1000,{to:T+4000}).series[0];
    assert.equal(history.consumed,21);
    assert.equal(history.coveredMs,1000);
    assert.equal(history.points[0][3],T+1000);
    assert.notEqual(history.points[0][2],history.points[1][2]);
  }
});

test('quota barriers survive restart and retention without changing native facts or TTL', t => {
  const folder = mkdtempSync(path.join(tmpdir(),'quotum-resource-'));
  t.after(() => rmSync(folder,{recursive:true,force:true}));
  const file = path.join(folder,'db.sqlite');
  let store = new Store(file,T), directory = new Directory(store.db);
  const user = directory.createUser('fixture@example.com','Fixture','x',T), board = directory.boards(user.id)[0].id;
  const source = store.source('codex',account,T); store.hold(source,user.id,T);
  const observed = (at: number, used: number) => record(store,source,T+at,{staleAfterMs:4*HOUR,windows:[{id:'weekly',kind:'weekly',usedPercent:used,minutes:10080,resetsAt:iso(T+7*24*HOUR)}]});
  observed(0,10); observed(HOUR,10);
  record(store,source,T+1.5*HOUR,missing());
  observed(2*HOUR,70); observed(3*HOUR,70);
  store.close(); store = new Store(file,T+3*HOUR); t.after(() => store.close());
  const verify = () => {
    const samples = store.seriesSamples(source,'weekly',T,T+3*HOUR);
    assert.equal(samples[1].validUntil,T+1.5*HOUR);
    assert.equal(store.db.prepare('SELECT stale_after_ms FROM samples WHERE source_id=? AND at=?').get(source,T+HOUR)?.stale_after_ms,4*HOUR);
    const forecast = forecastOf({samples,plan:null,since:null},T+3*HOUR,null).forecast;
    assert.equal(forecast.basis?.hours,2);
    assert.equal(forecast.F,30, 'unknown usage never enters the forecast through deltas or the window mean');
    for (const cell of [1000,60_000,HOUR,4*HOUR]) {
      const history = readHistory(store,board,T,cell,{to:T+4*HOUR,now:T+4*HOUR}).series[0];
      assert.equal(history.consumed,0);
      assert.equal(history.coveredMs,2*HOUR);
      if (cell===4*HOUR) assert.equal(history.points[0][3],T,'a cell containing both sides of a gap is unavailable to draw');
    }
  };
  verify();
  store.prune(T+config.retention.sampleDays*24*HOUR);
  verify();
  store.prune(T+1.5*HOUR+config.retention.sampleDays*24*HOUR);
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='quota_unavailable'").get()?.n,1);
  assert.equal(store.seriesSamples(source,'weekly',T,T+3*HOUR)[0].at,T+2*HOUR);
});

test('forecast recovery recomputes its cached anchor and keeps barriers across unusable samples', t => {
  const store = new Store(':memory:',T), source = store.source('codex',account,T);
  t.after(() => store.close());
  const worked: Why[] = [];
  const forecasts = new Forecasts(store,{shift:()=>0,observe:event=>worked.push(event.why)});
  const observed = (at: number, used: number, reset = true) => record(store,source,T+at,{staleAfterMs:4*HOUR,windows:[{id:'weekly',kind:'weekly',usedPercent:used,minutes:10080,...(reset?{resetsAt:iso(T+7*24*HOUR)}:{})}]});
  observed(0,10); observed(HOUR,10);
  forecasts.of(source,T+HOUR);
  observed(HOUR+60_000,10);
  forecasts.of(source,T+HOUR+60_000);
  const count = worked.length;
  record(store,source,T+HOUR+120_000,missing('invalid'));
  observed(HOUR+180_000,70);
  forecasts.of(source,T+HOUR+180_000);
  assert.equal(worked.length,count+1);
  assert.equal(worked.at(-1),'gap');
  observed(2*HOUR,70);
  observed(2*HOUR+60_000,70,false);
  record(store,source,T+2*HOUR+120_000,missing());
  observed(3*HOUR,90); observed(4*HOUR,90);
  const samples = store.seriesSamples(source,'weekly',T,T+4*HOUR);
  const prior = samples.find(s=>s.at===T+2*HOUR)!;
  assert.equal(prior.validUntil,T+2*HOUR+120_000,'the forecast may skip its next sample without skipping the barrier');
  const forecast = forecastOf({samples,plan:null,since:null},T+4*HOUR,null).forecast;
  assert.equal(forecast.F,10);
});

test('a rejected mixed delivery rolls back the quota barrier and its attention invalidation', t => {
  const store = new Store(':memory:',T), directory = new Directory(store.db);
  t.after(() => store.close());
  const user = directory.createUser('fixture@example.com','Fixture','x',T), secret = newSecret('qt_m');
  directory.createToken(secret,'fixture',user.id,'fixture',T);
  const ingest = new Ingest(store,directory,new Duty(),new Cadence()), attention = new Attention(store,T);
  ingest.attention=attention;
  const changes: AttentionEvents[] = []; attention.onEvents=event=>changes.push(event);
  const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
  ingest.accept(credential,batch(T,[snapshot(T)]),T);changes.length=0;
  const source = store.findSource('codex',account)!;
  const previous = store.state(source);
  store.db.exec("CREATE TRIGGER reject_credit BEFORE INSERT ON readings BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  assert.throws(()=>ingest.accept(credential,batch(T+1000,[snapshot(T+1000,{...missing(),balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'1'}]})]),T+1000),/test rollback/);
  assert.equal(store.quotaInterrupted(source,T,T+1000),false);
  assert.deepEqual(store.state(source),previous);
  assert.deepEqual(changes,[]);
});
