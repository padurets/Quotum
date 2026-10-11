import {createHash} from 'node:crypto';
import {amount,sumDecimals} from '../domain/amount.js';
import {utcPeriods,type Meter,type MonthlyLimitRead} from '../domain/meters.js';
import {SecretError,type SecretCode} from '../secrets/crypto.js';
import {ConnectorStatus,ConnectorTransport} from './transport.js';
import type {Connector,ConnectorIdentity} from './registry.js';

type Obj=Record<string,unknown>;
const object=(value:unknown):value is Obj=>!!value&&typeof value==='object'&&!Array.isArray(value);
type Token={numberToken:string};
const token=(value:unknown):value is Token=>object(value)&&typeof value.numberToken==='string';
/** Money tokens keep their original decimal spelling; unrelated fields are never retained. */
export function decodeOpenAI(json:string):unknown {
  return JSON.parse(json,((name:string,value:unknown,context?:{source?:string})=>{
    if(name==='value'||name==='threshold_amount')return typeof value==='number'&&context?.source?{numberToken:context.source}:undefined;
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
}
function proof(reply:unknown,secret:Buffer):{account:string;data:Obj} {
  if(!object(reply)||typeof reply.organization!=='string'||!/^[\x21-\x7e]{1,256}$/.test(reply.organization)||reply.organization.includes(secret.toString('ascii')))throw new SecretError('credential_identity_unavailable');
  if(!object(reply.data))throw new SecretError('connector_invalid_response');
  return {account:createHash('sha256').update('quotum/account/v1\nopenai_platform\n'+reply.organization).digest('hex').slice(0,24),data:reply.data};
}
function centsToken(value:string):bigint {
  if(value.length>128)throw new SecretError('connector_invalid_response');
  const m=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value);
  if(!m||Math.abs(Number(m[3]??0))>100)throw new SecretError('connector_invalid_response');
  const coefficient=BigInt(m[1]+(m[2]??'')),shift=Number(m[3]??0)-(m[2]?.length??0);
  if(shift>=0)return coefficient*10n**BigInt(shift);
  const divisor=10n**BigInt(-shift);if(coefficient%divisor)throw new SecretError('connector_invalid_response');return coefficient/divisor;
}
const statusCode=(error:unknown):SecretCode=>error instanceof ConnectorStatus&&error.status===401?'credential_access_invalid':error instanceof ConnectorStatus&&error.status===403?'credential_permission':error instanceof SecretError?error.code:'connector_failed';

export function openAIPlatform(transport=new ConnectorTransport({host:'api.openai.com',port:443,operations:{costs:{path:'/v1/organization/costs',query:['start_time','end_time','bucket_width','limit','page'],cursor:'page'},limit:{path:'/v1/organization/spend_limit'}}},{decode:decodeOpenAI,organizationProof:true}),now=Date.now):Connector<Extract<ConnectorIdentity,{account:string}>> {
  const abilities=['usage'] as const;
  const read=async(secret:Buffer,expected:string|undefined,signal?:AbortSignal):Promise<Extract<ConnectorIdentity,{account:string}>>=>{
    const started=now(),day=86_400_000,from=utcPeriods(started).month,to=utcPeriods(started).day+day;
    const date=new Date(started),resetAt=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const deadline=setTimeout(abort,60_000);deadline.unref();
    let account=expected,proved=false,count=0,complete=false;
    const days=new Map<number,string[]>(),cursors=new Set<string>();
    let sampled:string|null=null;
    const attempt:NonNullable<ConnectorIdentity['attempt']>={outcome:'ok',safeCode:null,retryNotBefore:null};
    const failure=(error:unknown,primary:boolean)=>{
      const code=statusCode(error);
      const lost=code==='credential_account_mismatch'||code==='credential_access_invalid'||primary&&['credential_permission','credential_identity_unavailable'].includes(code);
      const degraded=!primary&&(error instanceof ConnectorStatus&&[403,404].includes(error.status??0)||code==='credential_identity_unavailable');
      if(lost||attempt.outcome!=='access_lost'&&!degraded){attempt.outcome=lost?'access_lost':'transient';attempt.safeCode=code;}
      else if(attempt.outcome==='ok'){attempt.outcome='degraded';attempt.safeCode=code;}
      if(error instanceof ConnectorStatus&&error.retryNotBefore!==null)attempt.retryNotBefore=Math.max(attempt.retryNotBefore??0,error.retryNotBefore);
      return code;
    };
    const limit:MonthlyLimitRead={status:'unavailable',observedAt:started,error:null,value:null};
    try {
      try {
        let cursor:string|undefined;
        for(let page=0;page<8;page++) {
          const answer=proof(await transport.send('costs',secret,{start_time:String(from/1000),end_time:String(to/1000),bucket_width:'1d',limit:'31',...(cursor?{page:cursor}:{})},controller.signal),secret);
          if(account&&answer.account!==account)throw new SecretError('credential_account_mismatch');
          account=answer.account;
          const data=answer.data;
          if(data.object!=='page'||!Array.isArray(data.data)||data.data.length>180||typeof data.has_more!=='boolean'||!(data.next_page===null||typeof data.next_page==='string'))throw new SecretError('connector_invalid_response');
          proved=true;
          for(const bucket of data.data) {
            if(!object(bucket)||bucket.object!=='bucket'||!Number.isSafeInteger(bucket.start_time)||!Number.isSafeInteger(bucket.end_time)||!Array.isArray(bucket.results))throw new SecretError('connector_invalid_response');
            const start=(bucket.start_time as number)*1000,end=(bucket.end_time as number)*1000;
            if(start%day||end!==start+day||start<from||end>to)throw new SecretError('connector_invalid_response');
            count+=bucket.results.length;if(count>2048)throw new SecretError('connector_round_limit');
            const values:string[]=[];
            for(const result of bucket.results) {
              if(!object(result)||result.object!=='organization.costs.result'||!object(result.amount)||typeof result.amount.currency!=='string'||result.amount.currency.toUpperCase()!=='USD'||!token(result.amount.value))throw new SecretError('connector_invalid_response');
              values.push(result.amount.value.numberToken);
            }
            const previous=days.get(start);
            if(previous!==undefined&&JSON.stringify(previous)!==JSON.stringify(values))throw new SecretError('connector_invalid_response');
            days.set(start,values);
          }
          if(!data.has_more){complete=true;break;}
          if(typeof data.next_page!=='string'||!/^[\x20-\x7e]{1,1024}$/.test(data.next_page)||cursors.has(data.next_page))throw new SecretError('connector_invalid_response');
          cursors.add(data.next_page);cursor=data.next_page;
        }
        if(!complete)throw new SecretError('connector_round_limit');
        if(utcPeriods(now()).month!==from)throw new SecretError('connector_invalid_response');
        // An empty result proves neither an amount nor a confirmed zero.
        if([...days.values()].some(values=>values.length)) {
          sampled=sumDecimals([...days.values()].flat()).toString();
        } else attempt.outcome='degraded';
      }catch(error){sampled=null;failure(error,true);}
      if(account&&attempt.outcome!=='access_lost'&&!controller.signal.aborted&&(attempt.retryNotBefore===null||attempt.retryNotBefore<=now())) {
        try {
          const answer=proof(await transport.send('limit',secret,{},controller.signal),secret);limit.observedAt=now();
          if(answer.account!==account)throw new SecretError('credential_account_mismatch');
          const data=answer.data;
          if(data.object!=='organization.spend_limit'||data.currency!=='USD'||data.interval!=='month'||!token(data.threshold_amount)||!object(data.enforcement))throw new SecretError('connector_invalid_response');
          limit.value={unit:'USD',amount:amount((centsToken(data.threshold_amount.numberToken)*10000n).toString()).toString(),enforcement:data.enforcement.status==='enforcing'?'enforcing':data.enforcement.status==='inactive'?'inactive':'unknown'};limit.status='ok';
        }catch(error){limit.observedAt=now();limit.error=failure(error,false);}
      }
      if(!account||!expected&&(!proved||attempt.outcome==='access_lost'))throw new SecretError(attempt.safeCode??'credential_identity_unavailable');
      if(signal?.aborted)throw new SecretError('connector_cancelled');
      const meters:Meter[]=sampled!==null&&attempt.outcome!=='access_lost'?[{id:'usage',kind:'counter',unit:'USD',amount:sampled,at:started,staleAfterMs:204_000,stale:false,limit:null,resetAt,minutes:null,scope:'monthly',label:null}]:[];
      return {account,abilities:[...abilities],expiresAt:null,expiryKind:'unknown',attempt,measurement:{type:'meters',observedAt:started,staleAfterMs:204_000,meters,keys:[],inventoryComplete:true,inventoryError:null,monthlyLimit:limit}};
    }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
  };
  return {id:'openai_platform',secretFormat:value=>/^sk-admin-[A-Za-z0-9_-]{16,4000}$/.test(value),abilities,transport,map:()=>null,identify:(secret,signal)=>read(secret,undefined,signal),measure:(secret,expected,signal)=>read(secret,expected.account,signal)};
}
