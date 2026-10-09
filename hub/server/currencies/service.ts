import type {Store} from '../store/store.js';
import {balanceDescriptor,monetaryOf} from '../domain/providers.js';
import {DEFAULT_CURRENCY,isCurrency,isConvertible,ratesCover,type RateSnapshot} from '../domain/currency.js';
import type {Meter} from '../domain/meters.js';
import {DEFAULT_RATE_SOURCE,rateSources,type RatesReader} from './sources.js';

/** One hub-owned integration. Provider capture never waits for public reference data. */
export class Currencies {
  private running=false;
  private unsubscribe:(()=>void)|null=null;
  private stopCurrencyChanges:(()=>void)|null=null;
  private queued=new Map<string,ReturnType<typeof setImmediate>>();
  private controller:AbortController|null=null;
  private request:Promise<RateSnapshot|null>|null=null;
  private failedAt=-Infinity;
  constructor(private readonly store:Store,private readonly read:RatesReader=rateSources.get(DEFAULT_RATE_SOURCE)!,private readonly now=Date.now){}
  start() {
    if(this.running)return;this.running=true;
    this.unsubscribe=this.store.onMonetaryRecord((source,state)=>{
      // Capture every accepted anchor before deferred reference fetching can coalesce reports.
      const points=(state.meters??[]).map(m=>({unit:m.unit,at:m.at}));
      for(const owner of this.store.currencyReaders(source))this.store.currencies.context(owner,{[source]:points});
      this.schedule(source);
    });
    this.stopCurrencyChanges=this.store.onCurrencyChange(owner=>{
      for(const row of this.store.db.prepare('SELECT source_id FROM holders WHERE user_id=? UNION SELECT s.source_id FROM shares s JOIN members m ON m.board_id=s.board_id WHERE m.user_id=?').all(owner,owner) as {source_id:string}[])this.schedule(row.source_id);
    });
    for(const row of this.store.db.prepare('SELECT id FROM sources').all() as {id:string}[])this.schedule(row.id);
  }
  async stop() {
    this.running=false;this.unsubscribe?.();this.unsubscribe=null;this.stopCurrencyChanges?.();this.stopCurrencyChanges=null;
    for(const task of this.queued.values())clearImmediate(task);this.queued.clear();
    this.controller?.abort();await this.request;
  }
  private schedule(source:string) {
    if(!this.running||this.queued.has(source))return;
    this.queued.set(source,setImmediate(()=>{this.queued.delete(source);void this.update(source);}));
  }
  private family(source:string) {
    if(!this.store.db.prepare('SELECT 1 FROM sources WHERE id=?').get(source))return null;
    const state=this.store.state(source),descriptors=monetaryOf(state.provider)?.balances??[];
    const totals=(state.meters??[]).filter(m=>m.kind==='balance'&&balanceDescriptor(state.provider,m.id)?.role==='total'&&balanceDescriptor(state.provider,m.id)?.unit===m.unit);
    if(totals.some(m=>m.unit===DEFAULT_CURRENCY))return {state,meters:[] as Meter[]};
    const fresh=totals.filter(m=>!m.stale&&isCurrency(m.unit));
    if(fresh.length!==1)return {state,meters:[] as Meter[]};
    const total=fresh[0],ids=new Set<string>(descriptors.filter(d=>d.unit===total.unit).map(d=>d.meterId));
    return {state,meters:(state.meters??[]).filter(m=>ids.has(m.id)&&m.kind==='balance'&&!m.stale)};
  }
  private async rates():Promise<RateSnapshot|null> {
    const at=this.now(),cached=this.store.currencies.latest(at);
    if(cached&&at-this.store.currencies.checked()<12*3_600_000)return cached;
    if(at-this.failedAt<300_000)return cached;
    if(this.request)return this.request;
    const controller=this.controller=new AbortController();
    this.request=(async()=>{
      try {
        const reply=await this.read(controller.signal);if(!this.running)return null;
        if(!ratesCover(reply,this.now()))throw new Error('invalid_exchange_rates');
        const saved=this.store.currencies.save(reply);this.store.currencies.markChecked(this.now());return saved;
      }catch{this.failedAt=this.now();return this.running?this.store.currencies.latest(this.now()):null;}
      finally{this.request=null;if(this.controller===controller)this.controller=null;}
    })();
    return this.request;
  }
  /** Explicit entry also lets deterministic ingestion fixtures await normalization. */
  async update(source:string) {
    if(!this.running)return;
    const initial=this.family(source);if(!initial)return;
    const readers=this.store.currencyReaders(source),points=initial.state.meters??[];
    const needsRates=readers.some(owner=>points.some(m=>isConvertible(m.unit)&&!this.store.currencies.binding(owner,m.unit,this.store.currencies.preference(owner).id,m.at,null,source)));
    if(needsRates)await this.rates();
    let quote=initial.meters.length?this.store.currencies.latest(initial.meters[0].at):null;
    if(initial.meters.length&&(!quote||this.now()-this.store.currencies.checked()>=12*3_600_000))await this.rates();
    if(!this.running)return;
    const current=this.family(source);if(!current)return;
    quote=current.meters.length?this.store.currencies.latest(current.meters[0].at):null;
    const at=Math.max(current.state.successAt??0,current.state.balanceStatus?.at??0);
    const selected=new Set(current.meters.map(m=>m.id));let since=Infinity,changed=false;
    this.store.db.exec('SAVEPOINT currency_values');
    try {
      for(const native of current.state.meters??[])if(balanceDescriptor(current.state.provider,native.id)) {
        if(selected.has(native.id)&&quote) {
          const point=this.store.currencies.record(source,native,DEFAULT_CURRENCY,quote);
          if(point!==null){since=Math.min(since,point);changed=true;}
          else if(this.store.currencies.interrupt(source,native.id,DEFAULT_CURRENCY,at)){since=Math.min(since,at);changed=true;}
        }else if(this.store.currencies.interrupt(source,native.id,DEFAULT_CURRENCY,at)){since=Math.min(since,at);changed=true;}
      }
      this.store.db.exec('RELEASE currency_values');
    }catch {
      this.store.db.exec('ROLLBACK TO currency_values');this.store.db.exec('RELEASE currency_values');
      // A failed valuation never changes the accepted provider data or key health.
      return;
    }
    if(changed)this.store.currencyChanged(source,since);
    for(const owner of this.store.currencyReaders(source)) {
      const points=(current.state.meters??[]).map(m=>({unit:m.unit,at:m.at,anchor:null as string|null}));
      for(const native of current.state.meters??[]){const value=this.store.currencies.project(source,native,DEFAULT_CURRENCY,this.now());if(value?.conversion)points.push({unit:value.conversion.original.unit,at:value.conversion.original.at,anchor:value.conversion.rate.id});}
      this.store.currencies.context(owner,{[source]:points});this.store.currencyReaderChanged(owner);
    }
  }
}
