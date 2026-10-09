import {decodeView} from '../domain/view.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {STEPS,SCHEMA_VERSION,migrate} from '../store/schema.js';
import {Store} from '../store/store.js';
import {CurrencyStore} from '../store/currencies.js';

/**
 * Every step a release shipped, by its hash. A database records which steps it has
 * run, so a shipped step that changes afterwards leaves databases without what it now
 * creates. A new layout is a new step: add its hash here once it is released.
 */
const RELEASED = [
  '02cb748c205697bd5af76c42c46d7bdb09ab4ec3d311a7841f89ccf552fb48ff', // 0.2
  '93bef51f9d1b8ff1ad525301dfeac3f98c87068d6211e6e02f6388bc1de4cfb2', // 0.3
  'f0137f7875aee26476d1eb2b6f010b1365475c6e8cc452e863c282c4104c729b', // 0.4
  '1fd789e182b8d729fc874051306490e42a2b6c37d36cca805ec47464fafdf999', // 0.4
  '2001aa53d351ad58d717191dea8ada0028145647b8372751d54edf73e50c84bf', // 0.5
  '9ff26257825602cd24c4e8b209e8ff9ac70a8713dbc9697720c3b1d0a50d1748', // 0.5
  '559b6e3b19e7c77db182ef425a747de69a2ebe2ddc7c69169616d2746d98bcc6', // 0.6
  '90c23490c93cd2088d4f97f52a579161ea62c476b91469a39e18af1952cdb7bb', // 0.6
  '383d526454a7ae7d0c38b7847e43255c4af60ff8bcceeb478baed4e11b6eac04', // 0.6
];

test('released layout steps never change; new ones come after them', () => {
  const hashes = STEPS.map(step => createHash('sha256').update(step).digest('hex'));
  assert.deepEqual(hashes.slice(0, RELEASED.length), RELEASED);
});

test("a hub of 0.3 drops the sums of agents' work and keeps how they work from the upgrade on", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-schema-')), 'db.sqlite');
  const [made, upgraded] = [1_790_000_000_000, 1_800_000_000_000];
  const old = new DatabaseSync(file);
  for (const step of STEPS.slice(0, 2)) old.exec(step);
  old.exec('PRAGMA user_version = 2');
  old.prepare('INSERT INTO meta VALUES (?, ?)').run('historyStart', String(made));
  old.prepare('INSERT INTO work VALUES (?, ?, ?, ?)').run('codex:1', made, 60_000, 60_000);
  old.close();

  const store = new Store(file, upgraded);
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {name: string}[]).map(t => t.name);
  assert.ok(!tables.includes('work'));
  assert.ok(['agent_sessions', 'agent_work', 'project_names'].every(t => tables.includes(t)));
  assert.equal(store.agentWorkSince(), upgraded);
  assert.equal(store.historyStart(upgraded), made, 'history itself goes back as far as before');
  store.close();

  const fresh = new Store(':memory:', upgraded);
  assert.equal(fresh.agentWorkSince(), fresh.historyStart(upgraded));
  fresh.close();
});

test('identity migration preserves exact legacy session IDs, keys and intervals', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-identity-schema-')), 'db.sqlite');
  const old = new DatabaseSync(file);
  for (const step of STEPS.slice(0, 7)) old.exec(step);
  old.exec('PRAGMA user_version = 7');
  old.exec("INSERT INTO agent_sessions VALUES (42, 'device', 'codex:1', 'terminal', 123, 'P', 'wt', 3), (97, 'device', 'codex:2', 'app', 456, '', '', 0)");
  old.exec('INSERT INTO agent_work VALUES (42, 1000, 2000), (42, 3000, 4000), (97, 1500, 3500)');
  const sessions = old.prepare('SELECT * FROM agent_sessions ORDER BY id').all();
  const work = old.prepare('SELECT * FROM agent_work ORDER BY session_id, from_at').all();
  old.close();
  const store = new Store(file, 5000);
  assert.deepEqual(store.db.prepare('SELECT id, device_id, source_id, origin, started_at, project, folder, ordinal FROM agent_sessions ORDER BY id').all(), sessions);
  assert.deepEqual(store.db.prepare('SELECT * FROM agent_work ORDER BY session_id, from_at').all(), work);
  assert.deepEqual(store.db.prepare('SELECT producer_id FROM agent_sessions').all().map(row => row.producer_id), [null, null]);
  assert.match(String(store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM agent_sessions WHERE device_id='device' AND source_id='codex:1' AND started_at=123 AND origin='terminal' AND project='P' AND folder='wt' AND ordinal=3 AND producer_id IS NULL").get()!.detail), /agent_sessions_legacy_key/);
  assert.match(String(store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM agent_sessions WHERE device_id='device' AND producer_id='abc' AND source_id='codex:1' AND origin='terminal' AND project='P' AND folder='wt'").get()!.detail), /agent_sessions_stable_key/);
  store.close();
});

test('money storage upgrades the stable-session layout without changing its identities or work',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    for(const step of STEPS.slice(0,8))db.exec(step);
    db.exec('PRAGMA user_version = 8');
    db.exec("INSERT INTO agent_sessions VALUES (42, 'device', 'codex:1', 'terminal', 123, 'P', 'wt', 0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')");
    db.exec('INSERT INTO agent_work VALUES (42, 1000, 2000)');
    const sessions=db.prepare('SELECT * FROM agent_sessions').all(),work=db.prepare('SELECT * FROM agent_work').all();
    migrate(db,3000);
    assert.deepEqual(db.prepare('SELECT * FROM agent_sessions').all(),sessions);
    assert.deepEqual(db.prepare('SELECT * FROM agent_work').all(),work);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,SCHEMA_VERSION);
    for(const name of ['readings','meter_spans','meter_contexts'])assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }finally{db.close();}
});

test('the shared currency upgrade preserves native state and legacy history and imports only proven estimates',()=>{
  const file=path.join(mkdtempSync(path.join(tmpdir(),'quotum-currency-upgrade-')),'db.sqlite'),at=Date.UTC(2026,9,5)+1000,date=at-1000;
  const old=new DatabaseSync(file);for(const step of STEPS.slice(0,12))old.exec(step);old.exec('PRAGMA user_version = 12');
  old.prepare("INSERT INTO meta VALUES ('historyStart',?)").run(String(at));
  old.prepare("INSERT INTO sources(id,provider,account,created_at) VALUES ('s','deepseek','a',0)").run();
  const native={id:'balance:CNY',unit:'CNY',amount:'110000000',kind:'balance' as const,limit:null,resetAt:null,minutes:null,scope:'wallet',label:'Original',at,staleAfterMs:60_000,stale:false};
  const derived={...native,id:'converted:balance:USD',unit:'USD',amount:'15714286',scope:'ecb:2026-10-05',label:'≈ CNY → USD (ECB)'};
  const rate={date,at,usdPerEur:'1000000',cnyPerEur:'7000000'};
  old.prepare('INSERT INTO state VALUES (?,?)').run('s',JSON.stringify({id:'s',provider:'deepseek',plan:'',successAt:at,error:null,windows:[],resets:null,staleAfterMs:60_000,meters:[native,derived],usdRate:rate,balanceStatus:{isAvailable:true,at,staleAfterMs:60_000,partial:true,issues:['rate_unavailable']}}));
  for(const meter of [native,derived]){
    old.prepare('INSERT INTO readings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('s',meter.id,at,null,meter.kind,meter.unit,BigInt(meter.amount),null,null,null,meter.scope,meter.label,60_000);
    old.prepare('INSERT INTO meter_spans(source_id,meter_id,from_at,to_at,stale_after_ms,interrupted_at) VALUES (?,?,?,?,?,?)').run('s',meter.id,at,at,60_000,at+10_000);
  }
  old.prepare('INSERT INTO meter_contexts VALUES (?,?,?,?,?,?)').run('s','usdRate',at,at,60_000,JSON.stringify({type:'usdRate',date,usdPerEur:rate.usdPerEur,cnyPerEur:rate.cnyPerEur}));
  old.close();const store=new Store(file,at);
  try {
    assert.deepEqual(store.state('s').meters,[native]);assert.equal(store.state('s').balanceStatus?.partial,false);assert.ok(!JSON.stringify(store.state('s')).includes('usdRate'));
    const valued=store.currencies.project('s',native,'USD',at)!;assert.equal(valued.amount,'15714286');assert.equal(valued.scope,'wallet');assert.equal(valued.label,'Original');assert.equal(valued.conversion?.original.amount,'110000000');assert.equal(valued.conversion?.rate.fetchedAt,at);
    assert.equal(store.currencies.spans('s','fx:USD:balance:CNY',at+10000)[0].interruptedAt,at+10000);
    assert.equal(store.meters.readings('s','converted:balance:USD',0,at+1)[0].amount,'15714286');
    assert.equal(store.db.prepare('SELECT count(*) n FROM exchange_rates').get()?.n,1);
  }finally{store.close();}
});

test('unreleased declared-account layouts adopt canonical provenance without losing encrypted rows or history',()=>{
  for(const version of [10,11,12,13,14]) {
    const db=new DatabaseSync(':memory:');try {
      for(const step of STEPS.slice(0,9))db.exec(step);
      db.exec("ALTER TABLE credentials ADD COLUMN expiry_kind TEXT NOT NULL DEFAULT 'none' CHECK(expiry_kind IN ('at','none','unknown')); ");
      db.exec(STEPS[10]);for(const step of STEPS.slice(11,version+1))db.exec(step);
      db.exec('PRAGMA user_version='+version);
      const owner={id:'owner'};db.prepare('INSERT INTO users(id,email,name,password,created_at) VALUES (?,?,?,?,?)').run(owner.id,'migration@example.com','Owner','fixture',1);
      db.prepare("INSERT INTO sources(id,provider,account,created_at) VALUES ('s','deepseek','native',1)").run();
      db.prepare('INSERT INTO declared_accounts VALUES (?,?,?,?,?,?,?,?)').run('account',owner.id,'deepseek','s','Private','private',1,0);
      const cipher=Buffer.from('encrypted fixture'),nonce=Buffer.alloc(12,7);
      db.prepare('INSERT INTO credentials(id,user_id,provider,source_id,cipher,nonce,key_version,abilities,created_at,expires_at,expiry_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('key',owner.id,'deepseek','s',cipher,nonce,1,'["balance"]',1,100000,'at');
      db.prepare('INSERT INTO readings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('s','balance:USD',1,null,'balance','USD',11000000n,null,null,null,'account',null,60000);
      migrate(db,2);
      const saved=db.prepare('SELECT * FROM credentials WHERE id=?').get('key')!;
      assert.deepEqual(Buffer.from(saved.cipher as Uint8Array),cipher);assert.deepEqual(Buffer.from(saved.nonce as Uint8Array),nonce);assert.equal(saved.expiry_kind,'dated');
      assert.equal(db.prepare('SELECT owner_id FROM source_identity WHERE source_id=?').get('s')?.owner_id,owner.id);
      assert.equal(db.prepare('SELECT amount FROM readings').get()?.amount,11000000);
      db.prepare('DELETE FROM credentials WHERE id=?').run('key');assert.equal(db.prepare('SELECT lifecycle_revision FROM declared_accounts').get()?.lifecycle_revision,1);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,SCHEMA_VERSION);migrate(db,3);
    }finally{db.close();}
  }
});

test('board additions append to the integrated currency layout while analytics migration preserves view settings, shares and encrypted access',()=>{
  const db=new DatabaseSync(':memory:');try {
    for(const step of STEPS.slice(0,15))db.exec(step);db.exec('PRAGMA user_version = 15');
    db.exec("INSERT INTO users VALUES ('owner','upgrade@example.test','Owner','fixture',1); INSERT INTO boards VALUES ('board','Board',0,'owner',1); INSERT INTO members VALUES ('board','owner','owner',1)");
    const payload=JSON.stringify({hidden:['source:deepseek:123456789abc'],order:['legacy'],names:{legacy:'Kept'},unknown:{kept:true}});
    db.prepare('INSERT INTO views VALUES (?,?,?,?)').run('board',payload,'owner',1);
    db.exec("INSERT INTO sources(id,provider,account,created_at) VALUES ('deepseek:123456789abc','deepseek','native',1); INSERT INTO holders VALUES ('deepseek:123456789abc','owner',1); INSERT INTO shares VALUES ('board','deepseek:123456789abc','owner',1); INSERT INTO source_identity VALUES ('deepseek:123456789abc','declared','owner')");
    const cipher=Buffer.from('encrypted fixture'),nonce=Buffer.alloc(12,9);
    db.prepare("INSERT INTO credentials(id,user_id,provider,source_id,cipher,nonce,key_version,abilities,created_at,expiry_kind) VALUES ('key','owner','deepseek','deepseek:123456789abc',?,?,1,'[\"balance\"]',1,'unknown')").run(cipher,nonce);
    const before=Object.fromEntries(['sources','holders','shares','credentials'].map(table=>[table,db.prepare('SELECT * FROM '+table).all()]));
    migrate(db,2);
    for(const table of ['sources','holders','shares'])assert.deepEqual(db.prepare('SELECT * FROM '+table).all(),before[table]);
    const credential=db.prepare('SELECT * FROM credentials').get()!;assert.equal(credential.access_revision,0);delete credential.access_revision;assert.deepEqual([credential],before.credentials);
    const saved=db.prepare('SELECT payload,revision,updated_by,updated_at FROM views').get()!;
    assert.deepEqual({...saved,payload:undefined},{payload:undefined,revision:2,updated_by:'owner',updated_at:1});
    const view=decodeView(JSON.parse(String(saved.payload)))!; assert.equal(view.version,3);
    assert.deepEqual(view.names,{legacy:'Kept'});
    assert.deepEqual(view.hidden,['source:deepseek:123456789abc']);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);assert.equal(SCHEMA_VERSION,20);
  }finally{db.close();}
});

test('currency lifecycle upgrade backfills stable pair ordering without changing quotes or pins',()=>{
  const db=new DatabaseSync(':memory:');try {
    for(const step of STEPS.slice(0,16))db.exec(step);db.exec('PRAGMA user_version=16');
    db.exec("INSERT INTO users VALUES ('owner','currency-upgrade@example.com','Owner','fixture',1)");
    const id='personal:'+'a'.repeat(24);
    db.prepare('INSERT INTO currency_definitions VALUES (?,?,?,?,?,?,?)').run(id,'owner','Points','PT',2,null,'initial');
    const insert=db.prepare('INSERT INTO exchange_rates VALUES (?,?,?,?,?,?)');
    for(const [quote,date,fetched,rate] of [['initial',0,1,'2000000'],['revised',0,2,'3000000'],['dated',20,30,'4000000']] as const)insert.run(quote,'manual',date,fetched,JSON.stringify({source:'manual',base:'USD',date,fetchedAt:fetched,validUntil:null,rates:{USD:'1000000',[id]:rate}}),'owner');
    db.prepare('INSERT INTO currency_bindings VALUES (?,?,?,?,?,?,?,?)').run('owner','source','USD',id,10,15,'','[{"id":"initial","from":"1000000","to":"2000000"}]');
    const quotes=db.prepare('SELECT * FROM exchange_rates ORDER BY id').all(),pins=db.prepare('SELECT * FROM currency_bindings').all();
    migrate(db,100);migrate(db,101);
    assert.deepEqual(db.prepare('SELECT * FROM exchange_rates ORDER BY id').all(),quotes);assert.deepEqual(db.prepare('SELECT * FROM currency_bindings').all(),pins);
    assert.deepEqual(db.prepare('SELECT quote_id FROM currency_rate_changes ORDER BY sequence').all().map(row=>row.quote_id),['initial','revised','dated']);
    assert.equal(db.prepare("SELECT count(*) n FROM currency_rate_changes WHERE kind='stop'").get()?.n,0);
  }finally{db.close();}
});

test('public rate sequences migrate per owner and never reuse pruned numbers after reopening',()=>{
  const db=new DatabaseSync(':memory:');try {
    for(const step of STEPS.slice(0,17))db.exec(step);db.exec('PRAGMA user_version=17');
    for(const owner of ['a','b'])db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(owner,owner+'@example.com',owner,'fixture',1);
    for(const [index,owner] of ['a','b','b','a'].entries())db.prepare("INSERT INTO currency_rate_changes(owner_id,currency_id,base,effective_at,recorded_at,kind) VALUES (?,'old','USD',?,?,'stop')").run(owner,index,index);
    migrate(db,100);migrate(db,101);
    assert.deepEqual(db.prepare('SELECT owner_sequence FROM currency_rate_changes ORDER BY sequence').all().map(row=>row.owner_sequence),[1,1,2,2]);
    db.prepare('DELETE FROM currency_rate_changes WHERE owner_id=?').run('a');
    const c=new CurrencyStore(db),id=c.create('a',{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',110).id;
    assert.equal(c.rateHistory('a',id,undefined).changes[0].sequence,3);
    const reopened=new CurrencyStore(db);reopened.setRate('a',id,'USD','3000000',120,120);
    assert.deepEqual(reopened.rateHistory('a',id,undefined).changes.map(change=>change.sequence),[4,3]);
  }finally{db.close();}
});
