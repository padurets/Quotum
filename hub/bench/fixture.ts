import {DAY, type DemoSet} from '../demo/model.js';

/** Twelve real sources continue beyond the 30d strip's rebuild and read-ahead edges. */
export function panningSet(set: DemoSet): DemoSet {
  let count = 0;
  return {...set, workHistoryMs: 75 * DAY, entries: set.entries.map(entry => entry.kind === 'card' && count++ < 12 ? {...entry, history: Math.max(entry.history, 75 * DAY), agents: entry.agents?.map(agent => ({...agent, since: Math.min(agent.since, -75 * DAY)}))} : entry)};
}

import {Store} from '../server/store/store.js';
import {Directory} from '../server/store/directory.js';
import type {Stand} from '../demo/setup.js';
import type {Meter} from '../server/domain/meters.js';

/** Independently measured balances keep the monetary plot real at every pan edge. */
export function seedPanningBudgets(file:string,stand:Stand) {
  const store=new Store(file),directory=new Directory(store.db),owner=[...stand.people.values()][0],now=stand.start;
  try {
    store.db.exec('BEGIN');
    for(let index=0;index<12;index++) {
      const source=store.source('openrouter',`benchmark-wallet-${index}`,now-75*DAY);
      store.hold(source,owner.id,now-75*DAY);
      for(let at=now-75*DAY;at<=now;at+=3*3_600_000) {
        const elapsed=Math.floor((at-(now-75*DAY))/(3*3_600_000));
        const base={at,staleAfterMs:6*3_600_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null};
        const meters:Meter[]=[{...base,id:'credits',kind:'counter',unit:'USD',amount:String((2000+index*10)*1_000_000)},
          {...base,id:'usage',kind:'counter',unit:'USD',amount:String((elapsed+index)*100_000)}];
        store.record(source,{type:'meters',observedAt:at,staleAfterMs:6*3_600_000,meters,keys:[],inventoryComplete:true,inventoryError:null});
      }
      const view=directory.view(owner.personalBoard);view.names[source]=`Budget ${index+1}`;directory.saveView(owner.personalBoard,view,owner.id,now);
    }
    store.db.exec('COMMIT');
  }catch(error){store.db.exec('ROLLBACK');throw error;}finally{store.close();}
}
