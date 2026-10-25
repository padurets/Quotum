import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ALWAYS, MIN, lastOn, machineInfo, sessionsAt, type Agent, type DemoSet, type Machine, type Wave} from '../model.js';
import {Person} from '../client.js';
import {Live, seedWork, type Stand} from '../setup.js';
import {parseSessions} from '../../server/domain/ingest.js';
import {Sessions} from '../../server/sessions.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';

test('the last work of a wave stays fixed throughout its idle part, including before the demo starts', () => {
  const wave: Wave = {period: 1000, on: 200, phase: 100};
  assert.equal(lastOn(wave, 100), 100);
  assert.equal(lastOn(wave, 299), 299);
  assert.equal(lastOn(wave, 300), 299);
  assert.equal(lastOn(wave, 1000), 299);
  assert.equal(lastOn(wave, -1), -701);
  assert.equal(lastOn({...wave, on: 0}, 100), null);
  assert.equal(lastOn(ALWAYS, -1000), -1000);
});

test('demo sessions omit last work while working and when no work was seen after their start', () => {
  const set: DemoSet = {id: 'test', about: '', scene: '', entries: [{
    kind: 'card', id: 'test', provider: 'codex', plan: '', machines: ['machine'], history: 0, windows: [], expect: [],
    agents: [
      {machine: 'machine', origin: 'terminal', project: 'idle', since: 0, works: {period: 1000, on: 200, phase: 0}},
      {machine: 'machine', origin: 'editor', project: 'working', since: 0, works: ALWAYS},
      {machine: 'machine', origin: 'app', project: 'unseen', since: 300, works: {period: 1000, on: 200, phase: 0}},
      {machine: 'machine', origin: 'terminal', project: 'never', since: 0},
    ],
  }]};
  const read = (t: number) => sessionsAt(set, {kind: 'machine', id: 'machine', expect: []}, 10_000, t);
  assert.deepEqual(read(400).map(s => s.lastWorkedAt), [new Date(10_199).toISOString(), undefined, undefined, undefined]);
  assert.deepEqual(read(800), read(400));
});

test('synthetic IDs are assigned before presence and work filters, even for identical twins', () => {
  const set: DemoSet = {id: 'identity', about: '', scene: '', entries: [{
    kind: 'card', id: 'twins', provider: 'codex', plan: '', machines: ['machine'], history: 0, windows: [], expect: [],
    agents: [
      {machine: 'machine', origin: 'terminal', project: 'same', since: 0, until: 200, works: ALWAYS},
      {machine: 'machine', origin: 'terminal', project: 'same', since: 0, works: {period: 1000, on: 100, phase: 0}},
      {machine: 'machine', origin: 'terminal', project: 'old', since: 0, legacy: true},
    ],
  }]};
  const read = (t: number) => sessionsAt(set, {kind: 'machine', id: 'machine', expect: []}, 10_000, t);
  const [a, b, old] = read(0);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.match(b.sessionId!, /^[0-9a-f]{32}$/);
  assert.equal(read(400)[0].sessionId, b.sessionId, 'the survivor keeps its ID while idle and after a twin exits');
  assert.equal(read(1000)[0].sessionId, b.sessionId, 'working again keeps its ID');
  assert.equal(old.sessionId, null);
});


test('seeded parallel stable and legacy work equals chronological reports in either order', () => {
  const start = 1_800_000_000_000;
  const machine: Machine = {kind: 'machine', id: 'machine', expect: []};
  for (const staggered of [false, true]) {
    for (const reversed of [false, true]) {
      const agents: Agent[] = [
        {machine: machine.id, origin: 'terminal', project: 'same', since: staggered ? -6 * MIN : -3 * MIN, until: staggered ? -MIN : undefined, works: ALWAYS},
        {machine: machine.id, origin: 'terminal', project: 'same', since: staggered ? -4 * MIN : -3 * MIN, works: ALWAYS, legacy: true},
      ];
      if (reversed) agents.reverse();
      const span = staggered ? 6 * MIN : 3 * MIN;
      const set: DemoSet = {id: 'mixed', about: '', scene: '', workHistoryMs: span, entries: [
        {kind: 'person', id: 'person', name: 'Person', expect: []},
        {kind: 'card', id: 'card', provider: 'codex', plan: '', machines: [machine.id], history: span, windows: [], expect: [], agents},
      ]};
      const fixtures = [false, true].map(() => {
        const store = new Store(':memory:', start - span);
        const directory = new Directory(store.db);
        const user = directory.createUser('person@example.com', 'Person', 'fixture', start - span);
        const device = directory.saveDevice({userId: user.id, machine: machineInfo(machine), agent: 'quotum-demo/1', tokenId: null}, start - span).id;
        const stand: Stand = {set, start, people: new Map([['person', new Person('', user.id, '', '')]]), boards: new Map(), agents: new Map(), sources: new Map([['card', 'codex:fixture']])};
        return {store, user, device, stand, live: new Sessions(store)};
      });
      const [seeded, reported] = fixtures;
      const report = (fixture: typeof seeded, t: number) => {
        const parsed = parseSessions({version: 1, agent: 'quotum-demo/1', machine: machineInfo(machine), sentAt: new Date(start + t).toISOString(), sessions: sessionsAt(set, machine, start, t)});
        fixture.live.report(fixture.device, fixture.user.id, parsed.sessions.map(({provider: _provider, account: _account, accountName: _accountName, ...session}) => ({
          ...session, sentStartedAt: session.startedAt, source: 'codex:fixture', device: {id: fixture.device, name: machine.id},
        })), start + t);
      };
      try {
        seedWork(seeded.store, seeded.stand);
        for (let t = -span; t <= 0; t += MIN) report(reported, t);
        const rows = (store: Store) => store.db.prepare(
          'SELECT producer_id, ordinal, started_at, project, folder, from_at, to_at FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id ORDER BY producer_id, ordinal, from_at',
        ).all();
        assert.deepEqual(rows(seeded.store), rows(reported.store), `staggered=${staggered}, reversed=${reversed}`);
        const totals = seeded.store.db.prepare('SELECT producer_id IS NULL AS legacy, sum(to_at-from_at) AS ms FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id GROUP BY producer_id IS NULL ORDER BY legacy').all();
        assert.deepEqual(totals.map(row => [row.legacy, row.ms]), [[0, (staggered ? 5 : 3) * MIN], [1, (staggered ? 4 : 3) * MIN]]);
        report(seeded, 0);
        assert.deepEqual(seeded.live.of('codex:fixture', [seeded.user.id], start).map(session => session.workedMs), reported.live.of('codex:fixture', [reported.user.id], start).map(session => session.workedMs), 'seed and live counters agree');
      } finally {
        for (const fixture of fixtures) fixture.store.close();
      }
    }
  }
});


test('demo heartbeats count the supplemental clients alongside the legacy list', async () => {
  const machine: Machine = {kind: 'machine', id: 'machine', expect: []};
  const set: DemoSet = {id:'clients',about:'',scene:'',entries:[machine]};
  let reports = 0;
  const agent = {clientSessionCount:1,sessions:async (sessions: object[]) => {reports++; return {accepted:sessions.length+1};}};
  const stand = {set,start:10_000,agents:new Map([['machine',agent]])} as unknown as Stand;
  const live = new Live(stand,()=>60_000);
  await live.reportOne(machine,0,10_000);
  await live.reportOne(machine,15_000,25_000);
  assert.equal(reports,2);
});

test('unchanged seeded work keeps the minute report ledger with one continuous credit', () => {
  const start = 1_800_000_000_000, span = 24 * 60 * MIN;
  const machine: Machine = {kind: 'machine', id: 'machine', expect: []};
  const set: DemoSet = {id: 'continuous', about: '', scene: '', workHistoryMs: span, entries: [
    {kind: 'person', id: 'person', name: 'Person', expect: []},
    {kind: 'card', id: 'card', provider: 'codex', plan: '', machines: [machine.id], history: span, windows: [], expect: [], agents: [
      {machine: machine.id, origin: 'terminal', project: 'same', since: -span, works: ALWAYS},
      {machine: machine.id, origin: 'terminal', project: 'same', since: -span, works: ALWAYS, legacy: true},
    ]},
  ]};
  const fixtures = [false, true].map(() => {
    const store = new Store(':memory:', start - span), directory = new Directory(store.db);
    const user = directory.createUser('person@example.com', 'Person', 'fixture', start - span);
    const device = directory.saveDevice({userId: user.id, machine: machineInfo(machine), agent: 'quotum-demo/1', tokenId: null}, start - span).id;
    const stand: Stand = {set, start, people: new Map([['person', new Person('', user.id, '', '')]]), boards: new Map(), agents: new Map(), sources: new Map([['card', 'codex:fixture']])};
    return {store, user, device, stand, live: new Sessions(store)};
  });
  const [seeded, reported] = fixtures;
  let credits = 0;
  const credit = seeded.store.creditWork.bind(seeded.store);
  seeded.store.creditWork = (...args) => {if (args[3].length) credits++; return credit(...args);};
  try {
    seedWork(seeded.store, seeded.stand);
    for (let at = -span; at <= 0; at += MIN) {
      const parsed = parseSessions({version: 1, agent: 'quotum-demo/1', machine: machineInfo(machine), sentAt: new Date(start + at).toISOString(), sessions: sessionsAt(set, machine, start, at)});
      reported.live.report(reported.device, reported.user.id, parsed.sessions.map(({provider: _provider, account: _account, accountName: _accountName, ...session}) => ({
        ...session, sentStartedAt: session.startedAt, source: 'codex:fixture', device: {id: reported.device, name: machine.id},
      })), start + at);
    }
    const rows = (store: Store) => store.db.prepare(
      'SELECT producer_id, ordinal, started_at, project, folder, from_at, to_at FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id ORDER BY producer_id, ordinal, from_at',
    ).all();
    assert.deepEqual(rows(seeded.store), rows(reported.store));
    assert.deepEqual(rows(seeded.store).map(row => [row.from_at, row.to_at]), [[start - span, start], [start - span, start]]);
    assert.equal(credits, 1, 'an unchanged parallel packet needs one database credit for the whole interval');
  } finally {
    for (const fixture of fixtures) fixture.store.close();
  }
});

test('work seeding captures fixed owner rules once while preserving every credit and notification',()=>{
  const start=1_800_000_000_000,span=8*MIN;
  const machines:Machine[]=['ann','bob'].map(person=>({kind:'machine',id:person+'-device',person,expect:[]}));
  const set:DemoSet={id:'captured-rules',about:'',scene:'',workHistoryMs:span,entries:[
    ...['ann','bob'].map(id=>({kind:'person' as const,id,name:id,expect:[]})),...machines,
    ...machines.map(machine=>({kind:'card' as const,id:machine.id,provider:'codex' as const,plan:'',machines:[machine.id],history:span,windows:[],expect:[],agents:[
      {machine:machine.id,origin:'terminal' as const,project:'same',since:-span,works:{period:2*MIN,on:MIN,phase:0}},
      {machine:machine.id,origin:'terminal' as const,project:'same',since:-span,works:ALWAYS,legacy:true},
    ]})),
  ]};
  function run(mode:'captured'|'ordinary'|'empty'){
    const store=new Store(':memory:',start-span),directory=new Directory(store.db);
    const people=new Map<string,Person>(),sources=new Map<string,string>(),devices=new Map<string,string>();
    try{
      for(const machine of machines){
        const owner=directory.createUser(machine.person+'@example.com',machine.person!,'fixture',start-span);
        people.set(machine.person!,new Person('',owner.id,'',''));
        devices.set(machine.person!,directory.saveDevice({userId:owner.id,machine:machineInfo(machine),agent:'quotum-demo/1',tokenId:null},start-span).id);
        const source=store.source('codex',machine.id,start-span);sources.set(machine.id,source);store.hold(source,owner.id,start-span);
      }
      const fixture=mode==='empty'?{...set,entries:set.entries.map(entry=>entry.kind==='card'?{...entry,agents:entry.agents?.map(agent=>({...agent,works:undefined}))}:entry)}:set;
      const stand:Stand={set:fixture,start,people,boards:new Map(),agents:new Map(),sources};
      const notifications:unknown[]=[],ownerName=(id:string)=>[...people].find(([,person])=>person.id===id)?.[0],deviceName=(id?:string)=>[...devices].find(([,device])=>device===id)?.[0];
      store.setObserver({touchSources:ids=>notifications.push({type:'sources',ids}),touchBoards:()=>{},touchUser:()=>{},touchHub:()=>{},history:()=>{},dropSessions:()=>{},dropMember:()=>{},dropBoard:()=>{},
        touchClientSessions:(owner,device)=>notifications.push({type:'sessions',owner:ownerName(owner),device:deviceName(device)}),
        clientHistory:(owner,since,device,ids)=>notifications.push({type:'history',owner:ownerName(owner),device:deviceName(device),since,ids:ids?[...ids]:undefined})});
      const captures:{owners:readonly string[];bobHeld:boolean}[]=[];
      const batch=store.links.batch.bind(store.links);
      store.links.batch=(...args)=>{
        const context=batch(...args);captures.push({owners:[...args[0]],bobHeld:context(people.get('bob')!.id,devices.get('bob')!,'codex').held.has(sources.get('bob-device')!)});return context;
      };
      let credits=0;const credit=store.creditWork.bind(store);
      store.creditWork=(...args)=>{
        if(args[3].length)credits++;
        // The control keeps the ordinary per-credit SQL path, including its rules capture.
        if(mode==='ordinary')args[5]=undefined;
        return credit(...args);
      };
      seedWork(store,stand);
      const result={rows:store.db.prepare('SELECT d.machine_id,s.client,s.source_id,s.origin,s.started_at,s.project,s.folder,s.ordinal,s.producer_id,s.account_by,s.route_class,s.route_by,s.route_host,s.route_provider,w.from_at,w.to_at FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id JOIN devices d ON d.id=s.device_id ORDER BY d.machine_id,s.producer_id,s.ordinal,w.from_at').all(),
        revision:store.workRevision(),credits,notifications:[...notifications],since:Number(store.db.prepare("SELECT value FROM meta WHERE key='agentWorkSince'").get()!.value)};
      if(mode==='captured'){
        assert.equal(captures.length,1);assert.deepEqual([...captures[0].owners].sort(),[...people.values()].map(person=>person.id).sort());assert.equal(captures[0].bobHeld,true);
        store.db.prepare('DELETE FROM holders WHERE user_id=? AND source_id=?').run(people.get('bob')!.id,sources.get('bob-device')!);
        seedWork(store,stand);
        assert.equal(captures.length,2,'another invocation captures current authority again');assert.equal(captures[1].bobHeld,false);
      }else if(mode==='ordinary')assert.equal(captures.length,credits+1,'the control includes the unused fixture capture and each ordinary credit');
      else{assert.equal(captures.length,0);assert.equal(credits,0);assert.equal(result.rows.length,0);}
      return result;
    }finally{store.close();}
  }
  const captured=run('captured'),ordinary=run('ordinary');
  assert.ok(captured.credits>2);assert.ok(captured.notifications.length>0);assert.deepEqual(captured,ordinary);
  run('empty');
});
