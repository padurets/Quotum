import {createHash} from 'node:crypto';
import {decimal} from '../domain/amount.js';
import {utcPeriods, validateMeter, type KeyPart, type Meter, type MeterMeasurement} from '../domain/meters.js';
import {SecretError} from '../secrets/crypto.js';
import {ConnectorStatus, ConnectorTransport} from './transport.js';
import type {Connector, ConnectorIdentity} from './registry.js';

const MONEY=new Set(['total_credits','total_usage','limit','limit_remaining','usage','usage_daily','usage_weekly','usage_monthly','byok_usage','byok_usage_daily','byok_usage_weekly','byok_usage_monthly']);
/** Only allowlisted money leaves JSON decoding as an exact quantized integer string. */
export function decodeOpenRouter(json:string):unknown {
  return JSON.parse(json, ((name:string,value:unknown,context?:{source?:string})=>{
    if(MONEY.has(name) && value!==null) {
      if(typeof value!=='number'||!context?.source)return undefined;
      try{return decimal(context.source).toString();}catch{return undefined;}
    }
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
}
type Obj=Record<string,unknown>;
const object=(value:unknown):value is Obj=>!!value&&typeof value==='object'&&!Array.isArray(value);
const data=(value:unknown):Obj=>{if(!object(value)||!object(value.data))throw new SecretError('connector_invalid_response');return value.data;};
const money=(value:unknown):string=>{if(typeof value!=='string'||!/^\d{1,19}$/.test(value))throw new SecretError('connector_invalid_response');return value;};
const expiry=(value:unknown):number|null=>{
  if(value===null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new SecretError('connector_invalid_response');
  return Date.parse(value);
};
const safeName=(value:unknown,secret:Buffer):string|null=>{
  if(typeof value!=='string')return null;
  const normalized=value.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').trim();
  if(normalized.includes(secret.toString('ascii'))||/sk-or-v1-[a-zA-Z0-9_-]+/i.test(normalized))return null;
  return Array.from(normalized).slice(0,120).join('')||null;
};
const base=(id:string,amount:string,at:number):Meter=>({id,kind:'counter',unit:'USD',amount,at,staleAfterMs:204_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function openRouter(transport=new ConnectorTransport({host:'openrouter.ai',port:443,operations:{key:{path:'/api/v1/key'},credits:{path:'/api/v1/credits'},workspaces:{path:'/api/v1/workspaces',query:['offset','limit']},keys:{path:'/api/v1/keys',query:['offset','workspace_id','include_disabled']}}},{decode:decodeOpenRouter}),now=Date.now):Connector {
  const abilities=['balance','usage','manage_keys'] as const;
  const identity=async(secret:Buffer,signal?:AbortSignal):Promise<ConnectorIdentity>=>{
    const key=data(await transport.send('key',secret,{},signal));
    if(key.is_management_key!==true)throw new SecretError('credential_wrong_type');
    const expiresAt=expiry(key.expires_at);
    if(expiresAt!==null&&expiresAt<=now())throw new SecretError('credential_expired');
    const id=key.organization_id===null ? key.creator_user_id : key.organization_id;
    if(typeof id!=='string'||!id.trim()||id.length>256)throw new SecretError('connector_invalid_response');
    const account=createHash('sha256').update('quotum/account/v1\nopenrouter\n'+id.trim().toLowerCase()).digest('hex').slice(0,24);
    const credits=data(await transport.send('credits',secret,{},signal)),at=now();
    const measurement:MeterMeasurement={type:'meters',observedAt:at,staleAfterMs:204_000,meters:[base('credits',money(credits.total_credits),at),base('usage',money(credits.total_usage),at)],keys:[],inventoryComplete:false,inventoryError:'connector_inventory_partial'};
    return {account,abilities:[...abilities],expiresAt,measurement};
  };
  return {id:'openrouter',secretFormat:value=>/^sk-or-v1-[0-9a-f]{64}$/.test(value),abilities,transport,map:()=>null,
    async identify(secret,signal){
      try{return await identity(secret,signal);}catch(error){
        if(error instanceof ConnectorStatus&&error.status===401)throw new SecretError('credential_revoked');
        if(error instanceof ConnectorStatus&&error.status===403)throw new SecretError('credential_permission');
        throw error;
      }
    },
    async measure(secret,expected,signal){
      const controller=new AbortController();
      const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      const timer=setTimeout(abort,60_000);timer.unref();
      try {
        const found=await identity(secret,controller.signal);
        if(found.account!==expected.account)throw new SecretError('credential_account_mismatch');
        const measurement=found.measurement!;
        const workspaces:string[]=[],seenWorkspace=new Set<string>(),hashes=new Map<string,string>(),seenKeys=new Set<string>();
        let complete=true,error:string|null=null,calls=2,keysCount=0,retryAfterMs:number|undefined,halted=false;
        const failed=(failure:unknown)=>{
          complete=false;error=failure instanceof SecretError?failure.code:'connector_failed';
          if(failure instanceof ConnectorStatus&&failure.status===429){halted=true;retryAfterMs=failure.retryAfterMs??120_000;}
          if(controller.signal.aborted)halted=true;
        };
        const request=async(op:string,query:Record<string,string>)=>{
          if(++calls>200||controller.signal.aborted)throw new SecretError('connector_round_limit');
          return transport.send(op,secret,query,controller.signal);
        };
        try {
          let offset=0,total:number|undefined;
          do {
            const page=await request('workspaces',{offset:String(offset),limit:'100'});
            if(!object(page)||!Array.isArray(page.data)||page.data.length>100||!Number.isSafeInteger(page.total_count)||(page.total_count as number)<0)throw new SecretError('connector_invalid_response');
            if(total!==undefined&&total!==page.total_count)throw new SecretError('connector_inventory_partial');
            total=page.total_count as number;
            if(total>100||!page.data.length&&offset<total)throw new SecretError('connector_round_limit');
            for(const row of page.data) {
              if(!object(row)||typeof row.id!=='string'||!UUID.test(row.id)||seenWorkspace.has(row.id))throw new SecretError('connector_inventory_partial');
              seenWorkspace.add(row.id);workspaces.push(row.id);
            }
            offset+=page.data.length;
            if(offset>total)throw new SecretError('connector_inventory_partial');
          }while(offset<total!);
        }catch(failure){failed(failure);}
        const traversals:(string|undefined)[]=workspaces.length?workspaces:[undefined];
        if(!workspaces.length)complete=false;
        for(const workspace of traversals) {
          if(halted)break;
          try {
            let offset=0;
            while(true) {
              const page=await request('keys',{offset:String(offset),include_disabled:'true',...(workspace?{workspace_id:workspace}:{})});
              const keyAt=now();
              if(!object(page)||!Array.isArray(page.data)||page.data.length>100)throw new SecretError('connector_invalid_response');
              let progress=0;
              for(const raw of page.data) {
                if(++keysCount>10_000)throw new SecretError('connector_round_limit');
                try {
                  if(!object(raw)||typeof raw.hash!=='string'||!/^[0-9a-f]{64}$/.test(raw.hash)||typeof raw.disabled!=='boolean'||typeof raw.include_byok_in_limit!=='boolean'||workspace&&raw.workspace_id!==workspace)throw new SecretError('connector_invalid_response');
                  if(seenKeys.has(raw.hash))continue;
                  seenKeys.add(raw.hash);progress++;
                  const id=createHash('sha256').update(raw.hash).digest('hex').slice(0,12);
                  if(hashes.has(id)&&hashes.get(id)!==raw.hash) {
                    measurement.keys=measurement.keys.filter(k=>k.id!==id);measurement.meters=measurement.meters.filter(m=>!m.id.startsWith('key:'+id+':'));measurement.uncapped=measurement.uncapped?.filter(k=>k!==id);throw new SecretError('connector_inventory_partial');
                  }
                  hashes.set(id,raw.hash);
                  const name=safeName(raw.name,secret),expiresAt=expiry(raw.expires_at);
                  const key:KeyPart={id,name,disabled:raw.disabled,expiresAt,includeByok:raw.include_byok_in_limit,at:keyAt,staleAfterMs:204_000,presence:'observed',missCount:0,periods:{day:null,week:null,month:null}};
                  for(const [period,field] of [['day','usage_daily'],['week','usage_weekly'],['month','usage_monthly']] as const) {
                    try{key.periods[period]=money(raw[field]);}catch{complete=false;error='connector_inventory_partial';}
                  }
                  const usage={...base('key:'+id+':usage',money(raw.usage),keyAt),label:name};
                  measurement.keys.push(key);measurement.meters.push(usage);
                  if(raw.limit===null)(measurement.uncapped??=[]).push(id);
                  if(raw.limit!==null) {
                    try {
                      const limit=money(raw.limit);
                      if(typeof raw.limit_remaining!=='string'||!/^-(?:[1-9][0-9]*)$|^(?:0|[1-9][0-9]*)$/.test(raw.limit_remaining)||BigInt(raw.limit_remaining)>BigInt(limit))throw new SecretError('connector_invalid_response');
                      const reset=raw.limit_reset;
                      if(reset!==null&&!['daily','weekly','monthly'].includes(reset as string))throw new SecretError('connector_invalid_response');
                      const p=utcPeriods(keyAt),date=new Date(keyAt);
                      const resetAt=reset==='daily'?p.day+86_400_000:reset==='weekly'?p.week+7*86_400_000:reset==='monthly'?Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1):null;
                      const beginning=reset==='daily'?p.day:reset==='weekly'?p.week:p.month;
                      const cap:Meter={...base('key:'+id+':cap',(BigInt(limit)-BigInt(raw.limit_remaining)).toString(),keyAt),kind:'cap',limit,resetAt,minutes:resetAt===null?null:(resetAt-beginning)/60_000,scope:reset===null?'lifetime':String(reset),label:name};
                      validateMeter(cap);measurement.meters.push(cap);
                    }catch{complete=false;error='connector_inventory_partial';}
                  }
                }catch{complete=false;error='connector_inventory_partial';}
              }
              if(page.data.length===100&&!progress)throw new SecretError('connector_inventory_partial');
              offset+=page.data.length;
              if(page.data.length<100)break;
            }
          }catch(failure){failed(failure);}
        }
        return {...found,...(retryAfterMs===undefined?{}:{retryAfterMs}),measurement:{...measurement,inventoryComplete:complete,inventoryError:complete?null:error??'connector_inventory_partial'}};
      }catch(error){
        if(error instanceof ConnectorStatus&&error.status===401)throw new SecretError(expected.expiresAt!==null&&expected.expiresAt<=now()?'credential_expired':'credential_revoked');
        if(error instanceof ConnectorStatus&&error.status===403)throw new SecretError('credential_permission');
        throw error;
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    },
  };
}
