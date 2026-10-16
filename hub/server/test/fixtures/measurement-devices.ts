import {Store} from '../../store/store.js';
import {Directory} from '../../store/directory.js';
import {Ingest, type Credential} from '../../ingest.js';
import {Duty} from '../../duty.js';
import {Cadence} from '../../cadence.js';
import {newSecret} from '../../domain/auth.js';

/** Fixed fleet; only the requested account is read during the measured contact round. */
export function deviceControl(contacts=100,withPlans=false) {
  const now = Date.UTC(2026, 9, 11), store = new Store(':memory:', now), directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const devices: {credential: Credential; sender: object; subscriptions: object[]}[] = [];
  for (let owner = 0; owner < 10; owner++) {
    const user = directory.createUser(`owner${owner}@example.com`, `Owner ${owner}`, 'fixture', now);
    const secret = newSecret('qt_m'); directory.createToken(secret, 'fixture', user.id, 'Fixture', now);
    const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
    for (let machine = 0; machine < 10; machine++) {
      const index = owner*10+machine;
      const sender = {version: 1, agent: 'quotum/0.7.0', machine: {id: `fixture-machine-${index.toString().padStart(8,'0')}`, name: `Machine ${index}`, os: 'linux', arch: 'x86_64'}};
      const subscriptions = [0,1].map(n => ({provider: 'codex', account: (index*2+n+1).toString(16).padStart(24,'0'), active: false}));
      const snapshots = subscriptions.map(s => ({...s, observedAt: new Date(now).toISOString(), via: 'fixture', client: '1.2.3', staleAfterMs: 204_000, windows: [{id:'weekly',kind:'weekly',minutes:10080,usedPercent:10,resetsAt:null}]}));
      ingest.accept(credential, {...sender,sentAt:new Date(now).toISOString(),snapshots,failures:[]}, now);
      ingest.checkin(credential,{...sender,paced:true,subscriptions},now);
      devices.push({credential,sender,subscriptions});
    }
  }
  let reads = 0, rows = 0, writes = 0, userTouches = 0, sourceTouches = 0;
  const prepare = store.db.prepare.bind(store.db);
  const plans=new Map<string,string[]>();
  store.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ['get','all','run'] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, {value: (...args: any[]) => {
        const result = (original as (...args: any[]) => any)(...args);
        if(withPlans && /^\s*SELECT\b/i.test(sql) && !plans.has(sql))plans.set(sql,prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>String(row.detail)));
        if (method === 'run') writes++; else {reads++; rows += Array.isArray(result) ? result.length : result ? 1 : 0;}
        return result;
      }});
    }
    return statement;
  }) as typeof store.db.prepare;
  directory.setObserver({touchUser(){userTouches++;}} as any);
  ingest.setObserver({touchSources(ids: string[]){sourceTouches+=ids.length;}} as any);
  for (const {credential,sender,subscriptions} of devices.slice(0,contacts)) ingest.checkin(credential,{...sender,paced:true,subscriptions},now+15_000);
  const result = {owners:10,devices:100,subscriptions:200,contacts,reads,rows,writes,userTouches,sourceTouches,...(withPlans?{plans:[...plans].map(([sql,details])=>({sql,details}))}:{})};
  store.close();
  return result;
}
