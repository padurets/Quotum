import {randomUUID} from 'node:crypto';
import {connectors, type Connector, type ConnectorIdentity} from '../connectors/index.js';
import {CredentialStore, credentialAnswer, type Credential, type CredentialRow} from '../store/credentials.js';
import type {Store} from '../store/store.js';
import {providerOf, type Provider} from '../domain/providers.js';
import {tell, type Touches} from '../touches.js';
import {SecretError,secretCode, type SecretCode, type SecretKey} from './crypto.js';
import {checkpoint, type SecretKeyReport} from './start.js';

const DAY=86_400_000;
export const permanentAccess = (code:string) => ['credential_access_invalid','credential_identity_unavailable','credential_expired','credential_revoked','credential_wrong_type','credential_permission','credential_account_mismatch','credential_unreadable','secret_key_missing','secret_key_mismatch','credential_provider_unknown'].includes(code);
export type SourceAccess = {error:SecretCode|null;expiresAt:number|null;expiryKnown?:boolean;canRefresh:boolean;credentialIds:string[]};
type Options={allowNoExpiry?:boolean;requestId?:string};

/** Trusted keys are write-only; raw errors stop inside this service. */
export class Credentials {
  #repository: CredentialStore;
  private readonly db:Store['db'];
  private observer:Touches|null=null;
  onChange:(source:string)=>void=()=>{};
  constructor(private readonly store:Store,private readonly key:SecretKey|null,readonly report:SecretKeyReport,private readonly registry:ReadonlyMap<string,Connector>=connectors) {
    this.db=store.db;this.#repository=new CredentialStore(this.db);
  }
  setObserver(observer:Touches){this.observer=observer;}
  private boundary<T>(work:()=>T):T {
    try{return work();}catch(error){throw error instanceof SecretError?error:new SecretError('credential_failed');}
  }
  private async boundaryAsync<T>(work:()=>Promise<T>):Promise<T> {
    try{return await work();}catch(error){throw error instanceof SecretError?error:new SecretError('credential_failed');}
  }
  private mutation<T>(work:()=>T,maintenance:boolean,changed?:()=>void):T {
    return this.boundary(()=>{
      this.db.exec('BEGIN IMMEDIATE');let result:T;
      try{result=work();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      changed?.();
      if(maintenance)checkpoint(this.db,'credential_cleanup_pending');
      return result;
    });
  }
  private requireKey():SecretKey {
    if(!this.key||this.report.outcome==='missing')throw new SecretError('secret_key_missing');
    if(this.report.outcome==='mismatch')throw new SecretError('secret_key_mismatch');
    return this.key;
  }
  private connector(provider:string):Connector {
    const connector=this.registry.get(provider);if(!connector)throw new SecretError('credential_provider_unknown');return connector;
  }
  private async secret<T>(connector:Connector,value:unknown,use:(bytes:Buffer)=>Promise<T>):Promise<T> {
    if(typeof value!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(value)||!connector.secretFormat(value))throw new SecretError('credential_invalid');
    const bytes=Buffer.from(value,'ascii');try{return await use(bytes);}finally{bytes.fill(0);}
  }
  private generation():number {
    const value=Number(this.db.prepare("SELECT value FROM meta WHERE key='secretKeyVersion'").get()?.value);
    if(!Number.isSafeInteger(value)||value<1)throw new SecretError('credential_failed');return value;
  }
  private validate(connector:Connector,identity:ConnectorIdentity,allowNoExpiry?:boolean) {
    if(!/^[0-9a-f]{24}$/.test(identity.account)||identity.abilities.some(a=>!connector.abilities.includes(a))||identity.expiresAt!==null&&(!Number.isSafeInteger(identity.expiresAt)||identity.expiresAt<0))throw new SecretError('connector_invalid_response');
    if(identity.retryAfterMs!==undefined&&(!Number.isSafeInteger(identity.retryAfterMs)||identity.retryAfterMs<0||identity.retryAfterMs>3_600_000))throw new SecretError('connector_invalid_response');
    if(identity.expiresAt!==null&&identity.expiresAt<=Date.now())throw new SecretError('credential_expired');
    if(identity.expiryKnown!==undefined&&typeof identity.expiryKnown!=='boolean')throw new SecretError('connector_invalid_response');
    if(identity.attempt&&(!['ok','degraded','transient','access_lost'].includes(identity.attempt.outcome)||identity.attempt.safeCode!==null&&!secretCode(identity.attempt.safeCode)||identity.attempt.retryNotBefore!==null&&(!Number.isSafeInteger(identity.attempt.retryNotBefore)||identity.attempt.retryNotBefore<0)))throw new SecretError('connector_invalid_response');
    if(identity.expiresAt===null&&allowNoExpiry!==true)throw new SecretError(identity.expiryKnown===false?'credential_expiry_unknown_confirmation':'credential_expiry_confirmation');
  }
  private changed(source:string,owner:string) {
    tell(this.observer,o=>{o.touchSources([source]);o.touchUser(owner);});
    this.onChange(source);
  }
  private replay(owner:string,provider:string,requestId?:string):(Credential&{replayed:true})|null {
    if(!requestId)return null;
    const saved=this.db.prepare('SELECT value FROM meta WHERE key=?').get('credential-request:'+owner+':'+requestId)?.value;
    if(typeof saved!=='string')return null;
    const parsed=JSON.parse(saved) as {provider:string;id:string;at:number};
    if(Date.now()-parsed.at>=DAY)return null;
    if(parsed.provider!==provider)throw new SecretError('credential_conflict');
    const row=this.#repository.get(owner,parsed.id);if(!row)throw new SecretError('credential_not_found');
    return {...credentialAnswer(row),replayed:true};
  }
  list(owner:string):Credential[]{return this.boundary(()=>this.#repository.list(owner));}
  async create(owner:string,provider:string,secret:unknown,options:Options={}):Promise<Credential&{replayed?:true}> {
    return this.boundaryAsync(async()=>{
      const connector=this.connector(provider),key=this.requireKey();
      const replay=this.replay(owner,provider,options.requestId);if(replay)return replay;
      return this.secret(connector,secret,async bytes=>{
        const identity=await connector.identify(bytes);this.validate(connector,identity,options.allowNoExpiry);
        let source:string|null=null;
        return this.mutation(()=>{
          const replay=this.replay(owner,provider,options.requestId);if(replay)return replay;
          source=this.store.source(provider as Provider,identity.account,Date.now());
          const record={id:randomUUID(),user_id:owner,provider};
          const row:CredentialRow={...record,...key.seal(record,bytes),source_id:source,key_version:this.generation(),hint:bytes.subarray(-4).toString('ascii'),abilities:JSON.stringify(identity.abilities),created_at:Date.now(),expires_at:identity.expiresAt,expiry_known:identity.expiryKnown===false?0:1,last_used_at:null,last_error:null,unreadable:0};
          this.#repository.add(row);this.store.hold(source,owner,row.created_at);
          if(identity.measurement && (this.store.state(source).successAt??-Infinity)<identity.measurement.observedAt)this.store.record(source,identity.measurement);
          this.disposition(source,row,identity);
          if(options.requestId)this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('credential-request:'+owner+':'+options.requestId,JSON.stringify({provider,id:row.id,at:row.created_at}));
          return credentialAnswer(row);
        },false,()=>{if(source)this.changed(source,owner);});
      });
    });
  }
  async replace(owner:string,id:string,secret:unknown,options:Pick<Options,'allowNoExpiry'>={}):Promise<Credential> {
    return this.boundaryAsync(async()=>{
      const row=this.#repository.get(owner,id);if(!row)throw new SecretError('credential_not_found');
      const key=this.requireKey(),connector=this.connector(row.provider);
      return this.secret(connector,secret,async bytes=>{
        const identity=await connector.identify(bytes);this.validate(connector,identity,options.allowNoExpiry);
        if(!row.source_id||this.store.account(row.source_id)!==identity.account)throw new SecretError('credential_account_mismatch');
        return this.mutation(()=>{
          if(!this.#repository.current(row)||!this.#repository.replace(owner,id,key.seal(row,bytes),this.generation(),bytes.subarray(-4).toString('ascii'),row))throw new SecretError('credential_conflict');
          this.db.prepare('UPDATE credentials SET abilities=?,expires_at=?,expiry_known=?,last_used_at=NULL WHERE id=? AND user_id=?').run(JSON.stringify(identity.abilities),identity.expiresAt,identity.expiryKnown===false?0:1,id,owner);
          if(identity.measurement&&(this.store.state(row.source_id!).successAt??-Infinity)<identity.measurement.observedAt)this.store.record(row.source_id!,identity.measurement);
          this.disposition(row.source_id!,this.#repository.get(owner,id)!,identity);
          return credentialAnswer(this.#repository.get(owner,id)!);
        },true,()=>this.changed(row.source_id!,owner));
      });
    });
  }
  remove(owner:string,id:string):void {
    const row=this.boundary(()=>this.#repository.get(owner,id));
    this.mutation(()=>{
      this.#repository.remove(owner,id);
      if(row?.source_id&&!this.#repository.bound(row.source_id).some(r=>r.user_id===owner))this.store.release(row.source_id,owner);
    },true,()=>{if(row?.source_id)this.changed(row.source_id,owner);});
  }
  refreshable(source:string,now=Date.now()):boolean {
    return ['created','ok','rotated'].includes(this.report.outcome)&&this.#repository.bound(source).some(r=>!r.unreadable&&!permanentAccess(r.last_error??'')&&(r.expires_at===null||r.expires_at>now));
  }
  nextExpiry(source:string,now:number):number|null {
    const result=this.db.prepare('SELECT min(expires_at) AS at FROM credentials WHERE source_id=? AND expires_at>?').get(source,now) as {at:number|null};return result.at;
  }
  access(owner:string,source:string,now=Date.now()):SourceAccess|null {
    return this.boundary(()=>{
      const rows=this.list(owner).filter(r=>r.sourceId===source);if(!rows.length||!this.store.holds(owner,source))return null;
      const healthy=rows.find(r=>!r.lastError&&!r.unreadable&&(r.expiresAt===null||r.expiresAt>now));
      const expiry=rows.map(r=>r.expiresAt).filter((at):at is number=>at!==null);
      const error:SecretCode|null=this.report.outcome==='missing'?'secret_key_missing':this.report.outcome==='mismatch'?'secret_key_mismatch':healthy?null:rows.some(r=>r.expiresAt!==null&&r.expiresAt<=now)?'credential_expired':secretCode(rows[0].lastError)??'credential_unreadable';
      return {error,expiresAt:expiry.length?Math.min(...expiry):null,expiryKnown:rows.every(r=>r.expiryKnown!==false),canRefresh:this.refreshable(source,now),credentialIds:rows.map(r=>r.id)};
    });
  }
  sources():string[]{return this.boundary(()=>[...new Set((this.db.prepare('SELECT source_id FROM credentials WHERE source_id IS NOT NULL').all() as {source_id:string}[]).map(r=>r.source_id))]);}
  retryNotBefore(source:string):number {return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('connector-retry:'+source)?.value??0);}
  private disposition(source:string,row:CredentialRow,result:ConnectorIdentity) {
    const attempt=result.attempt;if(!attempt)return;
    if(attempt.retryNotBefore!==null)this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('connector-retry:'+source,String(Math.max(this.retryNotBefore(source),attempt.retryNotBefore)));
    if(attempt.outcome==='transient'||attempt.outcome==='access_lost')this.#repository.error(row.user_id,row.id,attempt.safeCode??'connector_failed',false,row);
  }
  reconcile() {
    this.mutation(()=>{
      for(const row of this.db.prepare('SELECT h.source_id,h.user_id,s.provider FROM holders h JOIN sources s ON s.id=h.source_id WHERE NOT EXISTS (SELECT 1 FROM credentials c WHERE c.source_id=h.source_id AND c.user_id=h.user_id)').all() as {source_id:string;user_id:string;provider:string}[])
        if(providerOf(row.provider)?.measuredBy==='hub')this.store.release(row.source_id,row.user_id);
      this.db.prepare("DELETE FROM meta WHERE key LIKE 'credential-request:%' AND json_valid(value) AND json_extract(value,'$.at')<?").run(Date.now()-DAY);
    },false);
  }
  async measure(source:string,signal?:AbortSignal,valid:()=>boolean=()=>true,interval:(result:ConnectorIdentity)=>number=()=>120_000):Promise<ConnectorIdentity|null> {
    return this.boundaryAsync(async()=>{
      let failure:SecretError|null=null;
      for(const row of this.#repository.bound(source)) {
        if(signal?.aborted||!valid())return null;
        let decrypted=false;
        try {
          const connector=this.connector(row.provider),key=this.requireKey();
          if(row.expires_at!==null&&row.expires_at<=Date.now())throw new SecretError('credential_expired');
          const result=await key.use(row,async bytes=>{decrypted=true;return connector.measure(bytes,{account:this.store.account(source)!,expiresAt:row.expires_at},signal);});
          this.validate(connector,result,true);
          if(result.account!==this.store.account(source))throw new SecretError('credential_account_mismatch');
          if(!result.measurement)throw new SecretError('connector_invalid_response');
          const staleAfterMs=Math.min(86_400_000,Math.round(interval(result)*1.2)+60_000);
          result.measurement={...result.measurement,staleAfterMs,meters:result.measurement.meters.map(m=>({...m,staleAfterMs})),keys:result.measurement.keys.map(k=>({...k,staleAfterMs}))};
          const accepted=this.mutation(()=>{
            if(signal?.aborted||!valid()||!this.#repository.current(row)||!this.store.holds(row.user_id,source))return false;
            this.#repository.used(row.user_id,row.id,row,result.abilities,result.expiresAt,result.expiryKnown!==false);
            if((this.store.state(source).successAt??-Infinity)<result.measurement!.observedAt)this.store.record(source,result.measurement!);
            this.disposition(source,row,result);
            return true;
          },false);
          if(accepted)tell(this.observer,o=>o.touchUser(row.user_id));
          if(accepted&&result.attempt?.outcome==='access_lost'){failure=new SecretError(result.attempt.safeCode??'credential_access_invalid');continue;}
          return accepted?result:null;
        }catch(error){
          const safe=error instanceof SecretError?error:new SecretError('credential_failed');failure=safe;
          if(signal?.aborted||!valid())return null;
          this.boundary(()=>this.#repository.error(row.user_id,row.id,safe.code,safe.code==='credential_unreadable'||!decrypted&&!!row.unreadable,row));
          tell(this.observer,o=>o.touchUser(row.user_id));
          if(!permanentAccess(safe.code))throw safe;
        }
      }
      throw failure??new SecretError('credential_not_found');
    });
  }
  /** Test probe keeps the same boundary and version check as production polling. */
  async probe(owner:string,id:string,operation:string,signal?:AbortSignal):Promise<{abilities:readonly string[];expiresAt:number|null}> {
    let record:CredentialRow|null=null,decrypted=false;
    try {
      const row=record=this.#repository.get(owner,id);if(!row)throw new SecretError('credential_not_found');
      const key=this.requireKey(),connector=this.connector(row.provider);
      const reply=await key.use(row,async secret=>{decrypted=true;return connector.transport.send(operation,secret,{},signal);});
      const answer=connector.map(reply);
      if(!answer||answer.abilities.some(a=>!connector.abilities.includes(a))||answer.expiresAt!==null&&(!Number.isSafeInteger(answer.expiresAt)||answer.expiresAt<0))throw new SecretError('connector_invalid_response');
      this.#repository.used(owner,id,row,answer.abilities,answer.expiresAt);return answer;
    }catch(error){
      const safe=error instanceof SecretError?error:new SecretError('credential_failed');
      try{if(record)this.#repository.error(owner,id,safe.code,safe.code==='credential_unreadable'||!decrypted&&!!record.unreadable,record);}catch{/* Preserve the original safe failure. */}
      throw safe;
    }
  }
}
