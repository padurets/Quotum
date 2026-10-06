import {decimal} from '../domain/amount.js';
import type {BalanceIssue, Meter, MeterMeasurement} from '../domain/meters.js';
import {SecretError} from '../secrets/crypto.js';
import {ConnectorStatus, ConnectorTransport} from './transport.js';
import type {Connector, ConnectorAnswer} from './registry.js';
import {deepSeekUsd,deepSeekRateReader} from './deepseekUsd.js';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** A currency tuple is atomic; extra supplier fields never cross this boundary. */
export function deepSeekMeasurement(answer:unknown,at:number):MeterMeasurement {
  if(!object(answer)||typeof answer.is_available!=='boolean'||!Array.isArray(answer.balance_infos)||answer.balance_infos.length>128)throw new SecretError('connector_invalid_response');
  const groups=new Map<string,Meter[]>(),seen=new Set<string>(),issues=new Set<BalanceIssue>();
  for(const row of answer.balance_infos) {
    if(!object(row)){issues.add('currency_invalid');continue;}
    const currency=row.currency;
    if(currency!=='CNY'&&currency!=='USD'){issues.add('currency_unknown');continue;}
    if(seen.has(currency)){groups.delete(currency);issues.add('currency_duplicate');continue;}
    seen.add(currency);
    try {
      const meters=[['balance','total_balance'],['granted','granted_balance'],['topped_up','topped_up_balance']].map(([id,field]):Meter=>{
        if(typeof row[field]!=='string')throw new SecretError('connector_invalid_response');
        return {id:id+':'+currency,kind:'balance',unit:currency,amount:decimal(row[field]).toString(),at,staleAfterMs:204_000,stale:false,limit:null,resetAt:null,minutes:null,scope:'account',label:null};
      });
      groups.set(currency,meters);
    }catch{issues.add('currency_invalid');}
  }
  if(!groups.size&&answer.balance_infos.length)throw new SecretError('connector_invalid_response');
  if(!answer.balance_infos.length)issues.add('empty_balances');
  return {type:'meters',observedAt:at,staleAfterMs:204_000,meters:[...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([,meters])=>meters),keys:[],inventoryComplete:true,inventoryError:null,
    balanceStatus:{isAvailable:answer.is_available,at,staleAfterMs:204_000,partial:issues.size>0,issues:[...issues].sort()}};
}

export function deepSeek(transport=new ConnectorTransport({host:'api.deepseek.com',port:443,operations:{balance:{path:'/user/balance'}}}),now=Date.now,readRate=deepSeekRateReader(fetch,now)):Connector {
  const read=async(secret:Buffer,signal?:AbortSignal):Promise<ConnectorAnswer>=>{
    try {
      const answer=await transport.send('balance',secret,{},signal);
      const measurement=deepSeekMeasurement(answer,now());
      const needsRate=measurement.meters.some(m=>m.unit==='CNY')&&!measurement.meters.some(m=>m.id==='balance:USD');
      return {identityKind:'declared',account:null,abilities:['balance'],expiresAt:null,measurement:deepSeekUsd(measurement,needsRate?await readRate(signal):undefined)};
    }catch(error) {
      if(error instanceof ConnectorStatus) {
        if(error.status===401)throw new SecretError('credential_rejected');
        if(error.status===403)throw new SecretError('credential_permission');
        if(error.status===402)throw new SecretError('connector_balance_unavailable');
      }
      throw error;
    }
  };
  return {id:'deepseek',identityKind:'declared',secretFormat:value=>/^sk-[A-Za-z0-9_-]{16,256}$/.test(value),abilities:['balance'],transport,map:()=>null,identify:read,measure:(secret,_expected,signal)=>read(secret,signal)};
}
