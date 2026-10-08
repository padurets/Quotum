import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';
import type {WindowMeasurement} from '../server/domain/quota.js';

/** Command races and rate-save conflicts are held by the credit API and cadence tests. */
export const CODEX_CREDIT_SCENES = [
  {id:'finite',expect:['mixed','finite','2500','default-USD','changing-balance','dedicated-funds-chart']},
  {id:'precise',expect:['mixed','finite','1234.5678912','default-USD']},
  {id:'zero',expect:['mixed','finite','0','default-USD']},
  {id:'unlimited',expect:['mixed','unlimited','last-known']},
  {id:'missing',expect:['mixed','missing','last-known']},
  {id:'invalid',expect:['mixed','invalid','last-known']},
  {id:'stale',expect:['mixed','stale','last-known']},
  {id:'funds-only',expect:['quota-missing','finite','2500','default-USD']},
  {id:'quota-only-share',expect:['mixed','finite','2500','shared-funds-off']},
] as const;

export function creditMeasurement(scene:string,at:number,initial=false):WindowMeasurement {
  const status=initial?'finite':scene==='unlimited'||scene==='missing'||scene==='invalid'?scene:'finite';
  const amount=scene==='precise'?'1234.5678912':scene==='zero'?'0':'2500';
  const windows=scene==='funds-only'?[]:[{id:'weekly',kind:'weekly' as const,used:40,remaining:60,resetAt:at+7*86_400_000,minutes:10080,label:null}];
  return {observedAt:at,staleAfterMs:scene==='stale'?1000:24*3_600_000,plan:'pro',windows,resets:{available:2,expiring:[]},
    resourceStatus:{windows:windows.length?'observed':'missing',resets:'observed'},
    balances:[{id:'balance:credits',unit:'credits:codex',status,hasCredits:true,...(status==='finite'?{amount}:{})}]};
}

/** A visible balance history, without inferring spending from its changes. */
export function creditHistory(scene:string,now:number):WindowMeasurement[] {
  if(scene!=='finite')return [creditMeasurement(scene,now-2*3_600_000,true),creditMeasurement(scene,now-60_000)];
  return ['3000','2850','3100','2750','2600','2500'].map((amount,index)=>({
    ...creditMeasurement(scene,now-(10-index*2)*3_600_000-60_000),
    balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',hasCredits:true,amount}],
  }));
}

export function seedCodexCredits(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0];if(!owner)return;
  const now=Date.now(),team=stand.boards.get('team');
  for(const [index,scene] of CODEX_CREDIT_SCENES.entries()) {
    const history=creditHistory(scene.id,now),first=history[0].observedAt;
    const source=store.source('codex',(11500+index).toString(16).padStart(24,'0'),first);
    store.hold(source,owner.id,first);
    if(team)store.share(team,source,owner.id,first,scene.id!=='quota-only-share');
    for(const sample of history)store.record(source,sample);
    for(const board of [owner.personalBoard,...team?[team]:[]]) {
      const view=directory.view(board);view.names[source]='Codex '+scene.id;
      directory.saveView(board,view,owner.id,now);
    }
  }
}
