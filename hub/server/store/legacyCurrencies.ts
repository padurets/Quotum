import type {DatabaseSync} from 'node:sqlite';
import type {CurrencyStore} from './currencies.js';
import {conversionId,convertMoney} from '../domain/currency.js';

/** Import the development layout's estimates only when their saved provenance proves them. */
export function importLegacyCurrencies(db:DatabaseSync,currencies:CurrencyStore) {
  if(db.prepare("SELECT 1 FROM meta WHERE key='legacyCurrencyImport'").get())return;
  db.exec('SAVEPOINT legacy_currency_import');
  try {
    const contexts=db.prepare("SELECT source_id,from_at,payload FROM meter_contexts WHERE item='usdRate'").all() as {source_id:string;from_at:number;payload:string}[];
    const quotes=contexts.flatMap(row=>{
      try {
        const old=JSON.parse(row.payload) as {date:number;usdPerEur:string;cnyPerEur:string;at?:number};
        const quote=currencies.save({source:'ecb',base:'EUR',date:old.date,fetchedAt:old.at??row.from_at,rates:{EUR:'1000000',USD:old.usdPerEur,CNY:old.cnyPerEur}});
        return [{source:row.source_id,from:row.from_at,quote}];
      }catch{return [];}
    });
    const query=db.prepare("SELECT * FROM readings WHERE meter_id LIKE 'converted:%:USD' ORDER BY at");query.setReadBigInts(true);
    const rows=query.all() as {source_id:string;meter_id:string;at:bigint;previous_at:bigint|null;amount:bigint;scope:string|null;stale_after_ms:bigint}[];
    const groups=new Map<string,typeof rows>();
    for(const row of rows){const key=JSON.stringify([row.source_id,row.meter_id]);let group=groups.get(key);if(!group)groups.set(key,group=[]);group.push(row);}
    for(const group of groups.values()) {
      const proven=group.flatMap(row=>{
        const origin=/^converted:(balance|granted|topped_up):USD$/.exec(row.meter_id);if(!origin)return [];
        const nativeId=origin[1]+':CNY',nativeQuery=db.prepare('SELECT * FROM readings WHERE source_id=? AND meter_id=? AND at<=? ORDER BY at DESC LIMIT 1');nativeQuery.setReadBigInts(true);
        const native=nativeQuery.get(row.source_id,nativeId,row.at) as {amount:bigint;limit_amount:bigint|null;reset_at:bigint|null;minutes:bigint|null;scope:string|null;label:string|null}|undefined;
        const quote=quotes.filter(q=>q.source===row.source_id&&q.from<=Number(row.at)).sort((a,b)=>b.from-a.from)[0]?.quote;
        if(!native||!quote||row.scope!=='ecb:'+new Date(quote.date).toISOString().slice(0,10)||convertMoney({amount:native.amount.toString(),unit:'CNY'},'USD',quote)?.amount!==row.amount.toString())return [];
        return [{row,nativeId,native,quote}];
      });
      // A partial proof must not extend an earlier value over unproven later readings.
      if(proven.length!==group.length)continue;
      for(const {row,nativeId,native,quote} of proven) {
        const id=conversionId(nativeId,'USD'),semantics={limit:native.limit_amount?.toString()??null,resetAt:native.reset_at===null?null:Number(native.reset_at),minutes:native.minutes===null?null:Number(native.minutes),scope:native.scope,label:native.label};
        db.prepare('INSERT OR IGNORE INTO money_valuations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.source_id,id,Number(row.at),row.previous_at===null?null:Number(row.previous_at),nativeId,'CNY',native.amount.toString(),'USD',row.amount.toString(),quote.id,JSON.stringify(semantics),Number(row.stale_after_ms));
        db.prepare('INSERT OR IGNORE INTO meter_spans SELECT source_id,?,from_at,to_at,stale_after_ms,interrupted_at FROM meter_spans WHERE source_id=? AND meter_id=?').run(id,row.source_id,row.meter_id);
      }
    }
    db.prepare("INSERT INTO meta VALUES ('legacyCurrencyImport','1')").run();
    db.exec('RELEASE legacy_currency_import');
  }catch(error){db.exec('ROLLBACK TO legacy_currency_import');db.exec('RELEASE legacy_currency_import');throw error;}
}
