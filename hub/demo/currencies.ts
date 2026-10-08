import type {Store} from '../server/store/store.js';
import type {Stand} from './setup.js';

/** Save conflicts, loading and lost responses are transient: currency settings browser/API tests hold them. */
export const CURRENCY_SCENES=[
  {id:'points',expect:['personal-active','versioned-rate','explicit-replacement'],about:'Points with a nominal USD pair and a retained correction'},
  {id:'stopped',expect:['rate-stopped','missing-not-zero'],about:'Stopped pair with its historical rates retained'},
  {id:'archived',expect:['currency-archived','restorable'],about:'Reversible currency archive'},
  {id:'precision',expect:['six-decimals','overflow-distinct'],about:'Exact large ratio and six-digit formatting'},
  {id:'readers',expect:['default-USD','private-selected'],about:'Separate preferences for two readers of the same board'},
] as const;
export function seedCurrencyOwner(store:Store,owner:string,now:number) {
  const c=store.currencies,points=c.create(owner,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now);
  c.setRate(owner,points.id,'USD','3000000',now-30_000,now);
  const stopped=c.create(owner,{name:'Stopped points',symbol:'SP',fractionDigits:2},'USD','2000000',now);
  c.stopRate(owner,stopped.id,'USD',c.rates(owner,stopped.id)[0].id,now-120_000);
  const archived=c.create(owner,{name:'Archived points',symbol:'AP',fractionDigits:2},'USD','1000000',now);c.archive(owner,archived.id,undefined,now);
  const precision=c.create(owner,{name:'Large precise units',symbol:'LPU',fractionDigits:6},'USD','9223372036854775807',now);
  return {points,stopped,archived,precision};
}
export function seedCurrencies(store:Store,stand:Stand) {
  const people=[...stand.people.values()];if(!people.length)return;const now=Date.now();seedCurrencyOwner(store,people[0].id,now);
  if(people[1]){const privateUnit=store.currencies.create(people[1].id,{name:'Private points',symbol:'BP',fractionDigits:2},'USD','4000000',now);store.currencies.select(people[1].id,privateUnit.id);}
}
