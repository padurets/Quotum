import {createHash,randomBytes} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {DEFAULT_CURRENCY,defaultCurrency,currencyDefinitionOf,type CurrencyDefinition,type CurrencyManagement,type CurrencyMutation,type CurrencyRateChange,type CurrencyRateHistory,type ExchangeRates,type RateSnapshot} from '../domain/currency.js';

type DefinitionRow={id:string;name:string;symbol:string;fraction_digits:number;archived_at:number|null;initial_quote_id:string|null};
export type RateChangeRow={sequence:number;owner_sequence:number;owner_id:string;currency_id:string;base:string;effective_at:number;recorded_at:number;kind:'rate'|'stop';quote_id:string|null};
const standards=Intl.supportedValuesOf('currency').map(id=>({id,name:id,symbol:id,fractionDigits:new Intl.NumberFormat('en',{style:'currency',currency:id}).resolvedOptions().maximumFractionDigits!}));
const definition=(row:DefinitionRow):CurrencyDefinition=>({id:row.id,name:row.name,symbol:row.symbol,fractionDigits:row.fraction_digits});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** Owner authority and settings transactions are shared by legacy and management callers. */
export abstract class CurrencyRegistry {
  onChange:((owner:string|null)=>void)|null=null;
  private writing=false;
  private pathsChanged=false;
  private changed=false;
  constructor(protected readonly db:DatabaseSync){}
  abstract save(input:ExchangeRates,owner?:string):RateSnapshot;
  abstract get(id:string,owner?:string):RateSnapshot|null;
  protected abstract invalidate(owner:string):void;
  private row(owner:string,id:string):DefinitionRow {
    const row=this.db.prepare('SELECT * FROM currency_definitions WHERE owner_id=? AND id=?').get(owner,id) as DefinitionRow|undefined;
    if(!row)throw new Error('currency_not_found');return row;
  }
  definition(owner:string,id:string,retained=false):CurrencyDefinition {
    const standard=standards.find(item=>item.id===id);if(standard)return standard;
    const row=this.row(owner,id);if(row.archived_at!==null&&!retained)throw new Error('currency_archived');return definition(row);
  }
  definitions(owner:string):CurrencyDefinition[] {
    return [defaultCurrency,...(this.db.prepare('SELECT * FROM currency_definitions WHERE owner_id=? AND archived_at IS NULL ORDER BY id').all(owner) as DefinitionRow[]).map(definition)];
  }
  preference(owner:string):CurrencyDefinition {return this.definition(owner,String(this.db.prepare('SELECT currency_id FROM currency_preferences WHERE user_id=?').get(owner)?.currency_id??DEFAULT_CURRENCY));}
  registryRevision(owner:string):string {return String(this.db.prepare('SELECT value FROM meta WHERE key=?').get('currencyRegistryRevision:'+owner)?.value??0);}
  pathRevision(owner:string):string {return String(this.db.prepare('SELECT value FROM meta WHERE key=?').get('currencyPathRevision:'+owner)?.value??0);}
  private increment(key:string){this.db.prepare("INSERT INTO meta(key,value) VALUES (?,'1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run(key);}
  private nextRateSequence(owner:string):number {
    const key='currencyRateSequence:'+owner;this.increment(key);
    return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)!.value);
  }
  private write<T>(owner:string,paths:boolean,work:()=>T,mutates=true):T {
    if(this.writing){this.pathsChanged ||= paths;this.changed ||= mutates;return work();}
    const own=!this.db.isTransaction;if(own)this.db.exec('BEGIN IMMEDIATE');
    this.db.exec('SAVEPOINT currency_registry');this.writing=true;this.pathsChanged=paths;this.changed=mutates;
    let result:T,publish=false;
    try {
      result=work();publish=this.changed;if(publish)this.increment('currencyRegistryRevision:'+owner);
      if(this.pathsChanged)this.increment('currencyPathRevision:'+owner);
      this.db.exec('RELEASE currency_registry');if(own)this.db.exec('COMMIT');
    }catch(error){if(own){if(this.db.isTransaction)this.db.exec('ROLLBACK');}else{this.db.exec('ROLLBACK TO currency_registry');this.db.exec('RELEASE currency_registry');}this.invalidate(owner);throw error;}
    finally{this.writing=false;this.pathsChanged=false;this.changed=false;}
    if(publish){this.invalidate(owner);this.onChange?.(owner);}return result;
  }
  mutation<T>(owner:string,route:string,input:unknown,mutation:CurrencyMutation|undefined,required:boolean,status:number,work:()=>T,now=Date.now()):{status:number;body:T} {
    if(!mutation){if(required)throw new Error('invalid_currency');return {status,body:work()};}
    if(typeof mutation.expectedRevision!=='string'||!/^\d{1,20}$/.test(mutation.expectedRevision)||typeof mutation.requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mutation.requestId))throw new Error('invalid_currency');
    const hash=createHash('sha256').update(canonical({route,input})).digest('hex');
    return this.write(owner,false,()=>{
      const receipt=this.db.prepare('SELECT request_hash,response,status FROM currency_mutations WHERE owner_id=? AND request_id=? AND created_at>=?').get(owner,mutation.requestId,now-7*86_400_000) as {request_hash:string;response:string;status:number}|undefined;
      if(receipt){if(receipt.request_hash!==hash)throw new Error('mutation_conflict');return {status:receipt.status,body:JSON.parse(receipt.response) as T};}
      if(this.registryRevision(owner)!==mutation.expectedRevision)throw new Error('currency_conflict');
      const body=work();this.db.prepare('INSERT OR REPLACE INTO currency_mutations VALUES (?,?,?,?,?,?)').run(owner,mutation.requestId,hash,JSON.stringify(body),status,now);return {status,body};
    },false);
  }
  manage(owner:string):CurrencyManagement {
    const rows=this.db.prepare('SELECT * FROM currency_definitions WHERE owner_id=? ORDER BY name,id').all(owner) as DefinitionRow[];
    // The overview reads current pairs together, without fetching each currency's history.
    const pairs=this.db.prepare(`SELECT c.currency_id,c.base,json_extract(q.payload,'$.rates."'||c.currency_id||'"') rate
      FROM (SELECT *,row_number() OVER (PARTITION BY currency_id,base ORDER BY effective_at DESC,sequence DESC) position
        FROM currency_rate_changes WHERE owner_id=? AND effective_at<=?) c
      LEFT JOIN exchange_rates q ON q.id=c.quote_id AND q.owner_id=c.owner_id
      WHERE c.position=1 ORDER BY c.base`).all(owner,Date.now()) as {currency_id:string;base:string;rate:string|null}[];
    return {registryRevision:this.registryRevision(owner),selected:this.preference(owner).id,standards,personal:rows.map(row=>({definition:definition(row),archivedAt:row.archived_at,pairs:pairs.filter(pair=>pair.currency_id===row.id).map(({base,rate})=>({base,rate}))})),maxActive:64};
  }
  private capacity(owner:string){if(this.definitions(owner).length>64)throw new Error('currency_limit');}
  select(owner:string,id:string){return this.write(owner,false,()=>{this.definition(owner,id);this.db.prepare('INSERT OR REPLACE INTO currency_preferences VALUES (?,?)').run(owner,id);});}
  create(owner:string,input:Omit<CurrencyDefinition,'id'>,base:string,rate:string,at:number):CurrencyDefinition {
    return this.write(owner,true,()=>{
      if(!owner||!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(owner))throw new Error('invalid_currency');
      this.capacity(owner);const result=currencyDefinitionOf({...input,id:'personal:'+randomBytes(12).toString('hex')});
      this.db.prepare('INSERT INTO currency_definitions(id,owner_id,name,symbol,fraction_digits) VALUES (?,?,?,?,?)').run(result.id,owner,result.name,result.symbol,result.fractionDigits);
      const quote=this.setRate(owner,result.id,base,rate,0,at);
      this.db.prepare('UPDATE currency_definitions SET initial_quote_id=? WHERE id=?').run(quote.id,result.id);return result;
    });
  }
  update(owner:string,id:string,input:Omit<CurrencyDefinition,'id'>):CurrencyDefinition {
    return this.write(owner,false,()=>{this.row(owner,id);this.definition(owner,id);const result=currencyDefinitionOf({...input,id});
      this.db.prepare('UPDATE currency_definitions SET name=?,symbol=?,fraction_digits=? WHERE owner_id=? AND id=?').run(result.name,result.symbol,result.fractionDigits,owner,id);return result;});
  }
  archive(owner:string,id:string,replacement:string|undefined,now:number) {
    return this.write(owner,true,()=>{
      this.row(owner,id);this.definition(owner,id);
      if(this.preference(owner).id===id){if(!replacement)throw new Error('currency_selected');if(replacement===id)throw new Error('invalid_currency');this.select(owner,replacement);}
      this.db.prepare('UPDATE currency_definitions SET archived_at=? WHERE owner_id=? AND id=?').run(now,owner,id);return {definition:this.definition(owner,id,true),archivedAt:now};
    });
  }
  restore(owner:string,id:string) {
    return this.write(owner,true,()=>{const row=this.row(owner,id);if(row.archived_at===null)throw new Error('currency_conflict');this.capacity(owner);
      this.db.prepare('UPDATE currency_definitions SET archived_at=NULL WHERE owner_id=? AND id=?').run(owner,id);return {definition:definition(row),archivedAt:null};});
  }
  rates(owner:string,id:string):RateSnapshot[] {
    this.definition(owner,id,true);const scope=id.startsWith('personal:')?owner:'';
    return (this.db.prepare('SELECT id FROM exchange_rates WHERE owner_id=? AND json_type(payload,?) IS NOT NULL ORDER BY reference_date DESC,fetched_at DESC LIMIT 128').all(scope,'$.rates."'+id+'"') as {id:string}[]).flatMap(row=>this.get(row.id,owner)??[]);
  }
  setRate(owner:string,id:string,base:string,rate:string,date:number,now:number):RateSnapshot {
    return this.write(owner,true,()=>{
      this.row(owner,id);this.definition(owner,id);this.definition(owner,base);
      if(!/^[A-Z]{3}$/.test(base)||!Number.isSafeInteger(date)||date<0||date>now||typeof rate!=='string')throw new Error('invalid_currency');
      const quote=this.save({source:'manual',base,date,fetchedAt:now,validUntil:null,rates:{[base]:'1000000',[id]:rate}},owner);
      this.db.prepare("INSERT INTO currency_rate_changes(owner_id,currency_id,base,effective_at,recorded_at,kind,quote_id,owner_sequence) VALUES (?,?,?,?,?,'rate',?,?)").run(owner,id,base,date,now,quote.id,this.nextRateSequence(owner));return quote;
    });
  }
  stopRate(owner:string,id:string,base:string,quoteId:string,now:number) {
    return this.write(owner,true,()=>{
      this.row(owner,id);this.definition(owner,id);
      const current=this.db.prepare('SELECT * FROM currency_rate_changes WHERE owner_id=? AND currency_id=? AND base=? AND effective_at<=? ORDER BY effective_at DESC,sequence DESC LIMIT 1').get(owner,id,base,now) as RateChangeRow|undefined;
      if(!current||current.kind!=='rate'||current.quote_id!==quoteId)throw new Error('currency_conflict');
      this.db.prepare("INSERT INTO currency_rate_changes(owner_id,currency_id,base,effective_at,recorded_at,kind,owner_sequence) VALUES (?,?,?,?,?,'stop',?)").run(owner,id,base,now,now,this.nextRateSequence(owner));return {base,stoppedAt:now};
    });
  }
  rateHistory(owner:string,id:string,before:string|undefined,limit=32,now=Date.now()):CurrencyRateHistory {
    const row=this.row(owner,id);let sequence=Number.MAX_SAFE_INTEGER;
    if(!Number.isInteger(limit)||limit<1||limit>64)throw new Error('invalid_currency');
    if(before){try{const value=JSON.parse(Buffer.from(before,'base64url').toString()) as unknown[];
      if(value.length!==3||value[0]!==owner||value[1]!==id||!Number.isSafeInteger(value[2])||Number(value[2])<1)throw new Error();sequence=Number(value[2]);
    }catch{throw new Error('invalid_currency');}}
    const convert=(change:RateChangeRow):CurrencyRateChange=>({sequence:change.owner_sequence,base:change.base,effectiveAt:change.effective_at,recordedAt:change.recorded_at,kind:change.kind,quote:change.quote_id?this.get(change.quote_id,owner):null,nominal:change.quote_id===row.initial_quote_id});
    const rows=this.db.prepare('SELECT * FROM currency_rate_changes WHERE owner_id=? AND currency_id=? AND owner_sequence<? ORDER BY owner_sequence DESC LIMIT ?').all(owner,id,sequence,limit+1) as RateChangeRow[];
    const pairs=this.db.prepare('SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY base ORDER BY effective_at DESC,sequence DESC) position FROM currency_rate_changes WHERE owner_id=? AND currency_id=? AND effective_at<=?) WHERE position=1 ORDER BY base').all(owner,id,now) as RateChangeRow[];
    return {definition:definition(row),archivedAt:row.archived_at,pairs:pairs.map(convert),changes:rows.slice(0,limit).map(convert),nextCursor:rows.length>limit?Buffer.from(JSON.stringify([owner,id,rows[limit-1].owner_sequence])).toString('base64url'):null};
  }
}
