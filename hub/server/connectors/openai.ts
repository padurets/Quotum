import {createHash} from 'node:crypto';
import {amount,sumDecimals} from '../domain/amount.js';
import {REPORT_DAY,type ReportInput,type ReportRead,type MonthlyLimitRead} from '../domain/reports.js';
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

export function openAIPlatform(transport=new ConnectorTransport({host:'api.openai.com',port:443,operations:{costs:{path:'/v1/organization/costs',query:['start_time','end_time','bucket_width','limit','page'],cursor:'page'},limit:{path:'/v1/organization/spend_limit'}}},{decode:decodeOpenAI,organizationProof:true}),now=Date.now):Connector {
  const abilities=['usage'] as const;
  const read=async(secret:Buffer,expected:string|undefined,signal?:AbortSignal):Promise<ConnectorIdentity>=>{
    const started=now(),from=Math.floor((started-90*REPORT_DAY)/REPORT_DAY)*REPORT_DAY,to=Math.floor(started/REPORT_DAY)*REPORT_DAY+REPORT_DAY;
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const deadline=setTimeout(abort,60_000);deadline.unref();
    let account=expected,proved=false,count=0,complete=false,bad=false,damaged=false;
    const intervals=new Map<string,ReportInput>(),conflicts=new Set<string>(),invalidDays=new Set<number>(),cursors=new Set<string>();
    const rejectDay=(start:number)=>{invalidDays.add(start);for(const [key,row] of intervals)if(row.from===start){intervals.delete(key);conflicts.add(key);}};
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
    const reports:ReportRead={status:'unavailable',observedAt:started,error:null,requestFrom:from,requestTo:to,traversalComplete:false,intervals:[]};
    const limit:MonthlyLimitRead={status:'unavailable',observedAt:started,error:null,value:null};
    try {
      try {
        let cursor:string|undefined;
        for(let page=0;page<8;page++) {
          const answer=proof(await transport.send('costs',secret,{start_time:String(from/1000),end_time:String(to/1000),bucket_width:'1d',limit:'180',...(cursor?{page:cursor}:{})},controller.signal),secret),at=now();
          if(account&&answer.account!==account)throw new SecretError('credential_account_mismatch');
          account=answer.account;
          const data=answer.data;
          if(data.object!=='page'||!Array.isArray(data.data)||data.data.length>180||typeof data.has_more!=='boolean'||!(data.next_page===null||typeof data.next_page==='string'))throw new SecretError('connector_invalid_response');
          proved=true;reports.observedAt=at;
          for(const bucket of data.data) {
            if(object(bucket)&&Array.isArray(bucket.results)){count+=bucket.results.length;if(count>2048)throw new SecretError('connector_round_limit');}
            if(!object(bucket)||bucket.object!=='bucket'||!Number.isSafeInteger(bucket.start_time)||!Number.isSafeInteger(bucket.end_time)||!Array.isArray(bucket.results)) {bad=true;damaged=true;if(object(bucket)&&Number.isSafeInteger(bucket.start_time)){const start=(bucket.start_time as number)*1000;if(Number.isSafeInteger(start)&&start%REPORT_DAY===0)rejectDay(start);}continue;}
            const start=(bucket.start_time as number)*1000,end=(bucket.end_time as number)*1000;
            if(start%REPORT_DAY||end!==start+REPORT_DAY||start<from||end>to){bad=true;damaged=true;if(Number.isSafeInteger(start)&&start%REPORT_DAY===0)rejectDay(start);continue;}
            if(invalidDays.has(start))continue;
            const totals=new Map<string,string[]>();let invalid=false;
            for(const result of bucket.results) {
              if(!object(result)||result.object!=='organization.costs.result'||!object(result.amount)||typeof result.amount.currency!=='string'||!/^[a-zA-Z]{3}$/.test(result.amount.currency)||!token(result.amount.value)){invalid=true;break;}
              const unit=result.amount.currency.toUpperCase(),values=totals.get(unit)??[];values.push(result.amount.value.numberToken);totals.set(unit,values);
            }
            if(invalid||totals.size>128||!totals.size){bad=true;damaged ||= invalid||totals.size>128;rejectDay(start);continue;}
            const rows:ReportInput[]=[];
            try{for(const [unit,values] of totals)rows.push({meterId:'costs',unit,from:start,to:end,amount:sumDecimals(values).toString(),observedAt:at});}catch{bad=true;damaged=true;rejectDay(start);continue;}
            for(const row of rows) {
              const key=row.unit+':'+start;
              if(conflicts.has(key))continue;
              const previous=intervals.get(key);
              if(previous&&previous.amount!==row.amount){intervals.delete(key);conflicts.add(key);bad=true;damaged=true;continue;}
              intervals.set(key,row);
            }
          }
          if(!data.has_more){complete=true;break;}
          if(typeof data.next_page!=='string'||!/^[\x20-\x7e]{1,1024}$/.test(data.next_page)||cursors.has(data.next_page))throw new SecretError('connector_invalid_response');
          cursors.add(data.next_page);cursor=data.next_page;
        }
        if(!complete)throw new SecretError('connector_round_limit');
      }catch(error){reports.error=failure(error,true);}
      reports.intervals=[...intervals.values()];reports.traversalComplete=complete;
      reports.status=proved?complete&&!bad&&intervals.size>0?'ok':'partial':'unavailable';
      if(damaged){reports.error??='connector_invalid_response';if(attempt.outcome==='ok'||attempt.outcome==='degraded'){attempt.outcome='transient';attempt.safeCode='connector_invalid_response';}}
      if((bad||!reports.intervals.length)&&attempt.outcome==='ok')attempt.outcome='degraded';
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
      return {account,abilities:[...abilities],expiresAt:null,expiryKnown:false,attempt,measurement:{type:'meters',reportDigest:createHash('sha256').update(JSON.stringify([reports.intervals.map(r=>[r.meterId,r.unit,r.from,r.to,r.amount]).sort(),limit.value])).digest('hex'),observedAt:started,staleAfterMs:204_000,meters:[],keys:[],inventoryComplete:true,inventoryError:null,reports,monthlyLimit:limit}};
    }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
  };
  return {id:'openai_platform',secretFormat:value=>/^sk-admin-[A-Za-z0-9_-]{16,4000}$/.test(value),abilities,transport,map:()=>null,identify:(secret,signal)=>read(secret,undefined,signal),measure:(secret,expected,signal)=>read(secret,expected.account,signal)};
}
