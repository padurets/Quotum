import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSessions, subscriptionKey} from '../domain/ingest.js';
import {parseSessions as initiative} from './fixtures/ingest-initiative.js';
import {parseSessions as baseline} from './fixtures/ingest-baseline.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest, type Credential} from '../ingest.js';
import {newSecret} from '../domain/auth.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Events, type Frame} from '../events.js';
import {ResetFeed} from '../resets.js';
import {HistoryTiles} from '../history.js';
import {readHistory} from './historyRead.js';
import {mergeEvidence} from '../domain/sessionEvidence.js';
import {KEEP_MS} from '../sessions.js';

const at = Date.parse('2026-09-22T12:00:00Z'), iso = (n: number) => new Date(n).toISOString();
const session = {clientId: 'opencode', sessionId: 'b'.repeat(32), source: null, origin: 'terminal', project: 'Quotum', startedAt: iso(at), working: true};
const report = {version: 1, agent: 'quotum/0.7.0', machine: {id: 'machine-0123456789', name: 'Laptop', os: 'linux', arch: 'x86_64'}, sentAt: iso(at),
  sessions: [{provider: 'codex', clientId: 'codex', sessionId: 'a'.repeat(32), account: null, origin: 'terminal', project: 'Quotum', startedAt: iso(at), working: true}], clientSessions: [session], clients: [{clientId: 'opencode', version: '1.2.3'}]};

test('new reports retain the frozen legacy subset on both old parsers; optional new fields are lenient', () => {
  for (const parse of [initiative, baseline]) assert.deepEqual(parse(report).sessions, parse({...report, clientSessions: undefined, clients: undefined}).sessions);
  const parsed = parseSessions({...report, sessions: [{...report.sessions[0], clientId: 'opencode', route: {by: 'invalid'}}], clientSessions: [null, {}, {...session, startedAt: 'bad'}, {...session, route: {by: 'machine', class: 'api', host: 'private.example'}, folder: {}, lastWorkedAt: false}, {...session, sessionId: 'a'.repeat(32)}], clients: [{clientId: 'opencode', version: {}}, {clientId: 'opencode'}, {clientId: 'bad id'}, {clientId: 'future-client', version: '0.1.0'}]});
  assert.equal(parsed.sessions[0].clientId, 'codex');
  assert.equal(parsed.clientSessions.length, 1);
  assert.deepEqual(parsed.clientSessions[0].route, {class: 'api', by: 'machine', host: null, provider: null});
  assert.equal(parsed.clientSessions[0].folder, null);
  assert.deepEqual(parsed.clients, [{clientId: 'opencode', version: null}, {clientId: 'future-client', version: '0.1.0'}]);
  assert.equal(parseSessions({...report, clientSessions: {}, clients: false}).clients, null);
  const many = Array.from({length: 200}, (_, i) => ({...report.sessions[0], sessionId: i.toString(16).padStart(32, '0')}));
  assert.equal(parseSessions({...report, sessions: many}).clientSessions.length, 0);
});

function setup() {
  const store = new Store(':memory:', at), directory = new Directory(store.db);
  const owner = directory.createUser('owner@example.com', 'Owner', 'x', at), other = directory.createUser('other@example.com', 'Other', 'x', at);
  const board = directory.boards(owner.id)[0].id, otherBoard = directory.boards(other.id)[0].id;
  const shared = directory.createBoard('Shared', owner.id, at).id;
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const token = newSecret('qt_m');
  directory.createToken(token, 'hint', owner.id, 'Machine', at);
  const credential = ingest.authenticate('Bearer '+token) as Credential;
  return {store, directory, owner, other, board, otherBoard, shared, ingest, credential};
}

test('unknown and known unheld work survives privately; ownership gates live, history and inventory', t => {
  const h = setup(); t.after(() => h.store.close());
  const foreign = h.store.source('codex', 'f'.repeat(24), at); h.store.hold(foreign, h.other.id, at);
  h.store.db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(h.shared,h.other.id,'member',at);
  h.store.share(h.shared,foreign,h.other.id,at);
  const packet = {...report, sessions: [], clientSessions: [session, {...session, clientId: 'codex', sessionId: 'c'.repeat(32), source: {provider: 'codex', account: 'f'.repeat(24)}}]};
  assert.equal(h.ingest.sessions(h.credential, packet, at).accepted, 2);
  const device = h.directory.devices(h.owner.id)[0].id;
  assert.equal(h.ingest.live.own(h.owner.id, h.board, at).length, 2);
  assert.equal(h.ingest.live.own(h.owner.id, h.shared, at).length, 0);
  assert.equal(h.ingest.live.own(h.other.id, h.board, at).length, 0);
  assert.equal(h.ingest.live.working(foreign, at), false);
  assert.deepEqual(h.ingest.live.of(foreign, [h.owner.id], at), []);
  assert.deepEqual(h.ingest.live.deviceSessions(h.other.id, device, at), []);
  assert.ok(h.ingest.live.deviceSessions(h.owner.id, device, at).every(s => s.source === null));
  assert.deepEqual(h.directory.deviceClients(device).map(({clientId, version}) => ({clientId, version})), report.clients);
  h.ingest.sessions(h.credential, {...packet, sentAt: iso(at+60_000)}, at+60_000);
  const raw = h.store.agentWork(at, at+60_000); assert.equal(raw.length, 2); assert.ok(raw.some(s => s.source === foreign));
  const history = readHistory(h.store, h.board, at, 60_000, {to: at+60_000});
  assert.equal(history.activity.agentMs, 120_000); assert.equal(history.activity.activeMs, 60_000);
  assert.deepEqual(history.activity.by.source.map(s => s.key), ['unknown']);
  for (const board of [h.shared, h.otherBoard]) assert.equal(readHistory(h.store, board, at, 60_000, {to: at+60_000}).activity.agentMs, 0);
  h.store.hold(foreign, h.owner.id, at+60_000);
  assert.equal(h.ingest.live.own(h.owner.id, h.board, at+60_000).length, 1);
  const shown = h.store.shown(h.board, [`source:${foreign}`]);
  assert.equal(readHistory(h.store, h.board, at, 60_000, {to: at+60_000, shown}).activity.agentMs, 60_000, 'held hidden cards keep their existing work filter');
  h.ingest.sessions(h.credential, {...packet, clients: undefined, clientSessions: [], sentAt: iso(at+60_000)}, at+60_000);
  assert.equal(h.directory.deviceClients(device).length, 1, 'older agents preserve inventory');
  assert.equal(h.ingest.live.own(h.owner.id, h.board, at+60_000).length, 0, 'full-list replacement clears private presence');
});

test('private events coalesce across subscribers and closed history tiles invalidate without watchers', t => {
  const h = setup(), clock = {now: () => at+60_000, after: (_ms: number, _run: () => void) => () => {}};
  const events = new Events({store: h.store, directory: h.directory, ingest: h.ingest, resets: new ResetFeed(undefined, () => {})}, undefined, clock);
  events.attach(); const tiles = new HistoryTiles(h.store); events.onClientHistory = (user, since) => tiles.touchClient(user, since);
  t.after(() => {events.close(); h.store.close();});
  const read = () => tiles.read(h.board, 60_000, at, at+60*60_000, at+3*60*60_000, h.store.shown(h.board, []));
  read(); h.ingest.sessions(h.credential, {...report, sessions: []}, at);
  h.ingest.sessions(h.credential, {...report, sessions: [], sentAt: iso(at+60_000)}, at+60_000);
  assert.equal(JSON.parse(read()[0]).activity.sessions.length, 1, 'private late credit invalidates cached closed tiles with no watchers');
  const frames: Frame[][] = [[], [], []];
  for (let i=0; i<3; i++) {const secret='reader-'+i; h.directory.createSession(secret,h.owner.id,at,1_000_000); events.open({user:h.owner.id,secret,board:i===2?h.shared:h.board,kind:'stream',send:batch=>frames[i].push(...batch),end:()=>{}});}
  events.flush(); frames.forEach(f=>f.splice(0));
  h.ingest.sessions(h.credential, {...report, sessions: [], clientSessions: [{...session, working: false}], sentAt: iso(at+120_000)}, at+120_000);
  events.flush();
  assert.deepEqual(frames[0],frames[1]); assert.equal(frames[0].filter(f=>f.type==='history').length,1);
  assert.equal(JSON.parse(frames[0].find(f=>f.type==='history')!.data).ownSince,at+60_000);
  assert.ok(frames[0].some(f=>f.type==='ownSessions'));
  assert.ok(!frames[2].some(f=>f.type==='ownSessions'||f.type==='history'));
});

test('a new private project keeps closed tiles warm and board rechecks incremental; renames refresh history', t => {
  const h = setup(), hour = 60*60_000;
  h.ingest.sessions(h.credential, {...report, sessions: [], clientSessions: []}, at);
  const device = h.directory.devices(h.owner.id)[0].id;
  const source = h.store.source('codex', 'owned-account', at);
  h.store.hold(source, h.owner.id, at);
  h.store.creditWork(device, at, at+15_000, [{source, origin: 'terminal', startedAt: at, project: 'Legacy', folder: '', identity: {kind: 'legacy', ordinal: 0}}]);
  const clock = {now: () => at+3*hour, after: (_ms: number, _run: () => void) => () => {}};
  const events = new Events({store: h.store, directory: h.directory, ingest: h.ingest, resets: new ResetFeed(undefined, () => {})}, undefined, clock);
  events.attach(); const tiles = new HistoryTiles(h.store); events.onClientHistory = (user, since) => tiles.touchClient(user, since);
  t.after(() => {events.close(); h.store.close();});
  const frames: Frame[] = [];
  h.directory.createSession('incremental-reader', h.owner.id, at, 4*hour);
  events.open({user: h.owner.id, secret: 'incremental-reader', board: h.board, kind: 'stream', send: batch => frames.push(...batch), end: () => {}});
  events.flush(); frames.splice(0);
  const shown = h.store.shown(h.board, []), before = h.store.workKey(h.board, shown);
  let reads = 0; const cells = h.store.cells.bind(h.store);
  h.store.cells = (...args) => {reads++; return cells(...args);};
  const read = () => tiles.read(h.board, 60_000, at, at+hour, clock.now(), shown);
  read(); assert.equal(reads, 1);
  const privateKey = {client: 'opencode', source: null, origin: 'terminal' as const, startedAt: at+2*hour, project: 'New private project', folder: '', identity: {kind: 'stable' as const, sessionId: 'e'.repeat(32)}};
  h.store.creditWork(device, at+2*hour, at+2*hour+15_000, [privateKey]);
  events.flush();
  assert.equal(JSON.parse(frames.find(f => f.type === 'history')!.data).ownSince, at+2*hour);
  assert.equal(h.store.workKey(h.board, shown), before, 'a new reported project is data, not a name change');
  read(); assert.equal(reads, 1, 'credit after a closed tile does not recount its quota or work');
  frames.splice(0);
  // Periodic rechecks use this same full-board refresh after the report's tail event.
  events.touchBoards([h.board]); events.flush();
  assert.ok(!frames.some(f => f.type === 'history'), 'a recheck cannot turn private credit into a full history reload');
  h.store.nameProjects(h.owner.id, ['New private project'], 'Renamed project');
  events.flush();
  assert.notEqual(h.store.workKey(h.board, shown), before);
  assert.equal(JSON.parse(frames.find(f => f.type === 'history')!.data).ownSince, 0);
  frames.splice(0);
  h.directory.renameDevice(h.owner.id, device, 'Renamed laptop'); events.flush();
  assert.equal(JSON.parse(frames.find(f => f.type === 'history')!.data).ownSince, 0);
  assert.equal(JSON.parse(read()[0]).activity.devices[device], 'Renamed laptop');
});

test('evidence strengthens without splitting work and equal-strength conflict loses unsafe details', () => {
  const first = {accountBy: 'inferred' as const, route: {class:'api' as const, by:'machine' as const, host:null,provider:null}};
  const strong = mergeEvidence(first, {accountBy:'login',route:{class:'subscription',by:'session',host:'example.com',provider:'codex'}});
  assert.equal(strong.accountBy,'login');
  const conflict = mergeEvidence(strong,{route:{class:'api',by:'session',host:'other.example',provider:'codex'}});
  assert.deepEqual(conflict.route,{class:'unknown',by:'session',host:null,provider:null});
  assert.deepEqual(mergeEvidence(conflict,first),conflict);
});

test('private known-unheld work and names leave shared history dependencies and closed tiles unchanged', t => {
  const h=setup(),hour=60*60_000;let now=at+3*hour;
  h.store.db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(h.shared,h.other.id,'member',at);
  const owned=h.store.source('claude','a'.repeat(24),at),foreign=h.store.source('codex','f'.repeat(24),at);
  h.store.hold(owned,h.owner.id,at);h.store.share(h.shared,owned,h.owner.id,at);
  h.store.hold(foreign,h.other.id,at);h.store.share(h.shared,foreign,h.other.id,at);
  const packet={...report,sessions:[],clientSessions:[]};h.ingest.sessions(h.credential,packet,at);
  const events=new Events({store:h.store,directory:h.directory,ingest:h.ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>now,after:()=>()=>{}});
  events.attach();const tiles=new HistoryTiles(h.store);events.onClientHistory=(user,since)=>tiles.touchClient(user,since);
  t.after(()=>{events.close();h.store.close();});
  const frames:Frame[]=[];h.directory.createSession('private-dependency-reader',h.other.id,at,4*hour);
  events.open({user:h.other.id,secret:'private-dependency-reader',board:h.shared,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});frames.splice(0);
  const shown=h.store.shown(h.shared,[]),key=h.store.workKey(h.shared,shown);let reads=0;const cells=h.store.cells.bind(h.store);
  h.store.cells=(...args)=>{reads++;return cells(...args);};
  const read=()=>tiles.read(h.shared,60_000,at,at+hour,now,shown),before=read();assert.equal(reads,1);
  const privateSession={...session,clientId:'codex',source:{provider:'codex',account:'f'.repeat(24)},project:'Private project',startedAt:iso(at+2*hour)};
  h.ingest.sessions(h.credential,{...packet,sentAt:iso(at+2*hour),clientSessions:[privateSession]},at+2*hour);
  h.ingest.sessions(h.credential,{...packet,sentAt:iso(at+2*hour+15_000),clientSessions:[privateSession]},at+2*hour+15_000);
  assert.equal(h.store.workKey(h.shared,shown),key,'a source held by another member does not make this device public');
  assert.deepEqual(read(),before);assert.equal(reads,1,'private credit keeps the shared closed tile warm');
  events.touchBoards([h.shared]);events.flush();assert.ok(!frames.some(frame=>frame.type==='history'));
  h.store.nameProjects(h.owner.id,['Private project'],'Private rename');events.touchBoards([h.shared]);events.flush();
  assert.equal(h.store.workKey(h.shared,shown),key);assert.deepEqual(read(),before);assert.equal(reads,1);
  assert.ok(!frames.some(frame=>frame.type==='history'));assert.equal(readHistory(h.store,h.shared,at,60_000,{to:now}).activity.agentMs,0);
  h.store.hold(foreign,h.owner.id,now);events.touchBoards([h.shared]);events.flush();
  assert.notEqual(h.store.workKey(h.shared,h.store.shown(h.shared,[])),key,'a real holding makes the names visible');
  assert.ok(frames.some(frame=>frame.type==='history'));
  assert.equal(readHistory(h.store,h.shared,at,60_000,{to:now}).activity.agentMs,15_000);
});

test('historical parsers keep their own provider authority as the current catalogue grows', () => {
  const hubSession={...report.sessions[0],provider:'openrouter'};
  assert.throws(()=>initiative({...report,sessions:[hubSession]}),/provider/);
  assert.deepEqual(baseline({...report,sessions:[{provider:'openrouter',startedAt:'invalid'}]}).sessions,[]);
});

test('explicit account names and supplemental source evidence differ from device inference and missing evidence', t => {
  const h=setup(); t.after(()=>h.store.close());
  h.ingest.sessions(h.credential,{...report,sessions:[],clientSessions:[]},at);
  const device=h.directory.devices(h.owner.id)[0].id;
  const source=h.store.source('antigravity',subscriptionKey({provider:'antigravity',account:null,accountName:'work'},h.owner.id),at);
  h.store.seenDevice(device,'antigravity',source,at);
  const common={origin:'terminal',project:'Quotum',startedAt:iso(at),working:true};
  const packet={...report,sessions:[
    {...common,provider:'antigravity',accountName:'work',sessionId:'1'.repeat(32)},
    {...common,provider:'antigravity',sessionId:'2'.repeat(32)},
    {...common,provider:'antigravity',accountName:'new',sessionId:'3'.repeat(32)},
  ],clientSessions:[
    {...common,clientId:'antigravity',source:{provider:'antigravity',accountName:'work'},sessionId:'4'.repeat(32)},
    {...common,clientId:'antigravity',source:{provider:'antigravity'},sessionId:'5'.repeat(32)},
    {...common,clientId:'antigravity',source:null,sessionId:'6'.repeat(32)},
  ]};
  h.ingest.sessions(h.credential,packet,at);
  h.ingest.sessions(h.credential,{...packet,sentAt:iso(at+60_000)},at+60_000);
  const rows=h.store.db.prepare('SELECT source_id,account_by FROM agent_sessions ORDER BY producer_id').all();
  assert.deepEqual(rows.map(row=>({...row})),[
    {source_id:source,account_by:'login'}, {source_id:source,account_by:'inferred'}, {source_id:null,account_by:'login'},
    {source_id:source,account_by:'login'}, {source_id:null,account_by:'login'}, {source_id:null,account_by:null},
  ]);
  assert.equal(h.store.agentWork(at,at+60_000).length,6,'provenance changes no session identity or credit');
});

test('unchanged inventory uses one collation, updates seenAt and sends no connections event', t => {
  const h=setup(),clock={now:()=>at,after:()=>()=>{}};
  const events=new Events({store:h.store,directory:h.directory,ingest:h.ingest,resets:new ResetFeed(undefined,()=>{})},undefined,clock);
  events.attach(); t.after(()=>{events.close();h.store.close();});
  const clients=[{clientId:'future-x',version:'1.0'},{clientId:'future_x',version:'1.0'}];
  const packet={...report,sessions:[],clientSessions:[],clients};
  h.ingest.sessions(h.credential,packet,at);
  const device=h.directory.devices(h.owner.id)[0].id,revision=h.directory.connectionsRevision(h.owner.id),frames:Frame[]=[];
  h.directory.createSession('inventory',h.owner.id,at,1_000_000);
  events.open({user:h.owner.id,secret:'inventory',board:h.board,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});
  frames.splice(0);
  for(let i=1;i<=3;i++) {
    h.ingest.sessions(h.credential,{...packet,clients:i%2?[...clients].reverse():clients,sentAt:iso(at+i*15_000)},at+i*15_000);
    events.flush();
    assert.equal(h.directory.connectionsRevision(h.owner.id),revision);
    assert.ok(h.directory.deviceClients(device).every(client=>client.seenAt===at+i*15_000));
    assert.ok(!frames.some(frame=>frame.type==='connections'));
  }
  h.ingest.sessions(h.credential,{...packet,clients:[clients[0],{...clients[1],version:'2.0'}]},at+60_000);
  events.flush();
  assert.equal(h.directory.connectionsRevision(h.owner.id),revision+1);
  assert.equal(frames.filter(frame=>frame.type==='connections').length,1);
});

test('device presence hints reach only the owner on every board and expire held-hidden sessions', t => {
  const h=setup();let now=at;
  const timers=new Set<{at:number;run:()=>void}>();
  const clock={now:()=>now,after:(ms:number,run:()=>void)=>{const timer={at:now+ms,run};timers.add(timer);return()=>{timers.delete(timer);};}};
  const events=new Events({store:h.store,directory:h.directory,ingest:h.ingest,resets:new ResetFeed(undefined,()=>{})},undefined,clock);
  events.attach();t.after(()=>{events.close();h.store.close();});
  const source=h.store.source('codex','f'.repeat(24),at);h.store.hold(source,h.owner.id,at);h.store.share(h.board,source,h.owner.id,at);
  h.directory.saveView(h.board,{...h.directory.view(h.board),hidden:[`source:${source}`]},h.owner.id,at);
  h.store.db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(h.shared,h.other.id,'member',at);
  h.ingest.sessions(h.credential,{...report,sessions:[],clientSessions:[]},at);
  const device=h.directory.devices(h.owner.id)[0].id,revision=h.directory.connectionsRevision(h.owner.id),frames:Frame[][]=[[],[],[]];
  for(const [i,user,board] of [[0,h.owner.id,h.board],[1,h.owner.id,h.shared],[2,h.other.id,h.shared]] as const) {
    h.directory.createSession('presence-'+i,user,at,1_000_000);
    events.open({user,secret:'presence-'+i,board,kind:'stream',send:batch=>frames[i].push(...batch),end:()=>{}});
  }
  frames.forEach(list=>list.splice(0));
  const packet={...report,sessions:[],clientSessions:[{...session,working:false},{...session,clientId:'codex',sessionId:'c'.repeat(32),working:false,source:{provider:'codex',account:'f'.repeat(24)}}]};
  const changed=()=>{
    events.flush();
    for(const i of [0,1]) assert.deepEqual(frames[i].filter(frame=>frame.type==='devices').map(frame=>JSON.parse(frame.data)),[{}]);
    assert.ok(!frames[2].some(frame=>frame.type==='devices'||frame.type==='ownSessions'));
    assert.ok(!frames[1].some(frame=>frame.type==='ownSessions'));
    assert.equal(h.directory.connectionsRevision(h.owner.id),revision);
    frames.forEach(list=>list.splice(0));
  };
  h.ingest.sessions(h.credential,packet,now);changed();
  assert.equal(h.ingest.live.deviceSessions(h.owner.id,device,now).length,2);
  now+=15_000;h.ingest.sessions(h.credential,{...packet,sentAt:iso(now)},now);events.flush();
  assert.ok(frames.every(list=>!list.some(frame=>frame.type==='devices')),'same idle heartbeat only extends expiry');
  frames.forEach(list=>list.splice(0));
  now+=15_000;h.ingest.sessions(h.credential,{...packet,clientSessions:[],sentAt:iso(now)},now);changed();
  assert.deepEqual(h.ingest.live.deviceSessions(h.owner.id,device,now),[]);
  now+=15_000;h.ingest.sessions(h.credential,{...packet,clientSessions:packet.clientSessions.slice(1),sentAt:iso(now)},now);changed();
  now+=KEEP_MS+1;
  for(const timer of [...timers].filter(timer=>timer.at<=now))timer.run();
  changed();assert.deepEqual(h.ingest.live.deviceSessions(h.owner.id,device,now),[]);
});

test('device presence recovers for every owner reader after projection failures', t => {
  for(const fault of ['devices','deadline','own','ownDeadline'] as const) {
    const h=setup(); let now=at;
    h.store.db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(h.shared,h.other.id,'member',at);
    const source=h.store.source('codex','f'.repeat(24),at);h.store.hold(source,h.owner.id,at);
    h.directory.saveView(h.board,{...h.directory.view(h.board),hidden:[`source:${source}`]},h.owner.id,at);
    const packet={...report,sessions:[],clientSessions:[],clients:[]};h.ingest.sessions(h.credential,packet,at);
    const device=h.directory.devices(h.owner.id)[0].id,revision=h.directory.connectionsRevision(h.owner.id);
    const clock={now:()=>now,after:()=>()=>{}},events=new Events({store:h.store,directory:h.directory,ingest:h.ingest,resets:new ResetFeed(undefined,()=>{})},undefined,clock);
    events.attach();t.after(()=>{events.close();h.store.close();});
    const frames:Frame[][]=[[],[],[],[]];
    for(const [i,user,board] of [[0,h.owner.id,h.board],[1,h.owner.id,h.board],[2,h.owner.id,h.shared],[3,h.other.id,h.shared]] as const) {
      const secret=`recovery-${fault}-${i}`;h.directory.createSession(secret,user,at,1_000_000);
      events.open({user,secret,board,kind:'stream',send:batch=>frames[i].push(...batch),end:()=>{}});
    }
    frames.forEach(list=>list.splice(0));
    const live=h.ingest.live,devices=live.devices.bind(live),deadline=live.devicesChangesAt.bind(live),own=live.own.bind(live),ownDeadline=live.ownChangesAt.bind(live);
    let fail=true;
    const once=()=>{if(fail){fail=false;throw new Error('synthetic presence read failure');}};
    if(fault==='devices')live.devices=(...args)=>{if(args[0]===h.owner.id)once();return devices(...args);};
    if(fault==='deadline')live.devicesChangesAt=(...args)=>{if(args[0]===h.owner.id)once();return deadline(...args);};
    if(fault==='own')live.own=(...args)=>{if(args[0]===h.owner.id&&args[1]===h.board)once();return own(...args);};
    if(fault==='ownDeadline')live.ownChangesAt=(...args)=>{if(args[0]===h.owner.id&&args[1]===h.board)once();return ownDeadline(...args);};
    const privateFault=fault==='own'||fault==='ownDeadline';
    const started={...session,working:false,...(privateFault?{}:{clientId:'codex',source:{provider:'codex',account:'f'.repeat(24)}})};
    now+=15_000;h.ingest.sessions(h.credential,{...packet,sentAt:iso(now),clientSessions:[started]},now);
    assert.ok(events.flush().users.has(h.owner.id),fault);
    assert.equal(live.deviceSessions(h.owner.id,device,now).length,1);
    assert.ok(!frames[3].some(frame=>frame.type==='devices'||frame.type==='ownSessions'));
    const hints=()=>frames.slice(0,3).map(list=>list.filter(frame=>frame.type==='devices').map(frame=>JSON.parse(frame.data)));
    if(privateFault)assert.deepEqual(hints(),[[{}],[{}],[{}]],'a board failure cannot suppress account presence');
    frames.forEach(list=>list.splice(0));live.devices=devices;live.devicesChangesAt=deadline;live.own=own;live.ownChangesAt=ownDeadline;
    events.touchBoards([h.board,h.shared]);events.flush();
    if(!privateFault)assert.deepEqual(hints(),[[{}],[{}],[{}]],'recovery reaches every existing owner reader');
    if(privateFault)assert.deepEqual(frames.slice(0,2).map(list=>list.filter(frame=>frame.type==='ownSessions').map(frame=>JSON.parse(frame.data).sessions.length)),[[1],[1]],'private recovery reaches both personal readers');
    assert.ok(!frames[3].some(frame=>frame.type==='devices'||frame.type==='ownSessions'));
    frames.forEach(list=>list.splice(0));now+=15_000;
    h.ingest.sessions(h.credential,{...packet,sentAt:iso(now),clientSessions:[started]},now);events.flush();
    assert.deepEqual(hints(),[[],[],[]],'successful recovery does not turn unchanged presence into repeated invalidation');
    assert.equal(h.directory.connectionsRevision(h.owner.id),revision);
  }
});

test('private presence expires without a quota card, while shared streams receive no private frame', t => {
  const h = setup(); let now = at;
  const timers = new Set<{at: number; run: () => void}>();
  const clock = {now: () => now, after: (ms: number, run: () => void) => {const timer = {at: now+ms, run}; timers.add(timer); return () => {timers.delete(timer);};}};
  const events = new Events({store: h.store, directory: h.directory, ingest: h.ingest, resets: new ResetFeed(undefined, () => {})}, undefined, clock);
  events.attach(); t.after(() => {events.close(); h.store.close();});
  h.ingest.sessions(h.credential, {...report, sessions: []}, at);
  const frames: Frame[][] = [[], []];
  for (let i=0; i<2; i++) {const secret='expiry-'+i; h.directory.createSession(secret,h.owner.id,at,1_000_000); events.open({user:h.owner.id,secret,board:i===0?h.board:h.shared,kind:'stream',send:batch=>frames[i].push(...batch),end:()=>{}});}
  frames.forEach(f=>f.splice(0));
  const expiry = [...timers].find(timer=>timer.at===at+KEEP_MS+1); assert.ok(expiry, 'private presence arms its deadline on the initial snapshot');
  now = expiry.at; expiry.run(); events.flush();
  assert.deepEqual(JSON.parse(frames[0].find(f=>f.type==='ownSessions')!.data), {sessions: []});
  assert.ok(!frames[1].some(f=>f.type==='ownSessions'||f.type==='history'));
});

test('client high water is independent and stronger metadata never creates another work context', t => {
  const h=setup(); t.after(()=>h.store.close()); h.ingest.sessions(h.credential,{...report,sessions:[]},at);
  const device=h.directory.devices(h.owner.id)[0].id;
  const key={client:'opencode',source:null,origin:'terminal' as const,startedAt:at,project:'Quotum',folder:'',identity:{kind:'stable' as const,sessionId:'d'.repeat(32)}};
  h.store.creditWork(device,at,at+60_000,[{...key,accountBy:'inferred',route:{class:'api',by:'machine',host:null,provider:null}}]);
  h.store.creditWork(device,at,at+60_000,[{...key,accountBy:'login',route:{class:'subscription',by:'session',host:'example.com',provider:'codex'}}]);
  h.store.creditWork(device,at,at+60_000,[{...key,client:'codex'}]);
  const rows=h.store.db.prepare('SELECT client,account_by AS accountBy,route_class AS route FROM agent_sessions ORDER BY client').all();
  assert.deepEqual(rows.map(r=>({...r})),[{client:'codex',accountBy:null,route:null},{client:'opencode',accountBy:'login',route:'subscription'}]);
  assert.deepEqual(h.store.worked(device,[key,{...key,client:'codex'}]),[60_000,60_000]);
  h.store.creditWork(device,at,at+90_000,[key]);
  assert.deepEqual(h.store.worked(device,[key,{...key,client:'codex'}]),[90_000,60_000]);
});
