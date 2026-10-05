import {randomUUID} from 'node:crypto';
import {connectors, type Connector, type ConnectorIdentity, type ConnectorAnswer} from '../connectors/index.js';
import {CredentialStore, type Credential, type CredentialRow} from '../store/credentials.js';
import type {Store} from '../store/store.js';
import {SourceAccounts,accountName,UUID,type AccountTarget,type DeclaredAccount} from '../store/sourceAccounts.js';
import {providerOf, type Provider} from '../domain/providers.js';
import {tell, type Touches} from '../touches.js';
import {SecretError,secretCode, type SecretCode, type SecretKey} from './crypto.js';
import {checkpoint, type SecretKeyReport} from './start.js';

const DAY=86_400_000;
export const permanentAccess = (code:string) => ['credential_rejected','credential_expired','credential_revoked','credential_wrong_type','credential_permission','credential_account_mismatch','credential_unreadable','secret_key_missing','secret_key_mismatch','secret_key_metadata_invalid','credential_provider_unknown'].includes(code);
export type SourceAccess = {error:SecretCode|null;expiresAt:number|null;expiryKind?:'at'|'none'|'unknown';canRefresh:boolean;credentialIds:string[]};
export type CredentialOptions={allowNoExpiry?:boolean;allowUnknownExpiry?:boolean;confirmSameAccount?:boolean;requestId?:string;account?:AccountTarget};
type Options=CredentialOptions;

/** Trusted keys are write-only; raw errors stop inside this service. */
export class Credentials {
  #repository: CredentialStore;
  private readonly accounts:SourceAccounts;
  private readonly db:Store['db'];
  private observer:Touches|null=null;
  onChange:(source:string)=>void=()=>{};
  constructor(private readonly store:Store,private readonly key:SecretKey|null,readonly report:SecretKeyReport,private readonly registry:ReadonlyMap<string,Connector>=connectors) {
    this.db=store.db;this.accounts=new SourceAccounts(this.db);this.#repository=new CredentialStore(this.db);
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
    const kcv=this.db.prepare("SELECT value FROM meta WHERE key='secretKeyKcv'").get()?.value;
    if(typeof kcv!=='string'||!this.key.matches(kcv))throw new SecretError('secret_key_mismatch');
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
    const raw=this.db.prepare("SELECT value FROM meta WHERE key='secretKeyVersion'").get()?.value;
    if(typeof raw!=='string'||!(/^[1-9][0-9]*$/).test(raw)||!Number.isSafeInteger(Number(raw)))throw new SecretError('secret_key_metadata_invalid');return Number(raw);
  }
  private authority() {const key=this.requireKey();return {key,kcv:key.checkValue,epoch:this.generation()};}
  private currentAuthority(captured:ReturnType<Credentials['authority']>) {
    try {
      if(this.generation()!==captured.epoch||this.db.prepare("SELECT value FROM meta WHERE key='secretKeyKcv'").get()?.value!==captured.kcv)throw new SecretError('credential_conflict');
      this.requireKey();
    }catch{throw new SecretError('credential_conflict');}
  }
  private validate(connector:Connector,answer:ConnectorAnswer,options:Options):ConnectorAnswer {
    const declared=connector.identityKind==='declared';
    if(declared ? answer.identityKind!=='declared'||answer.account!==null||answer.expiresAt!==null : answer.identityKind==='declared'||typeof answer.account!=='string'||!/^[0-9a-f]{24}$/.test(answer.account))throw new SecretError('connector_invalid_response');
    if(answer.abilities.some(a=>!connector.abilities.includes(a))||answer.expiresAt!==null&&(!Number.isSafeInteger(answer.expiresAt)||answer.expiresAt<0))throw new SecretError('connector_invalid_response');
    if(answer.retryAfterMs!==undefined&&(!Number.isSafeInteger(answer.retryAfterMs)||answer.retryAfterMs<0||answer.retryAfterMs>3_600_000))throw new SecretError('connector_invalid_response');
    if(answer.expiresAt!==null&&answer.expiresAt<=Date.now())throw new SecretError('credential_expired');
    if(answer.expiresAt===null&&(declared?options.allowUnknownExpiry:options.allowNoExpiry)!==true)throw new SecretError('credential_expiry_confirmation',declared?'unknown':'none');
    return answer;
  }
  private resolve(answer:ConnectorAnswer,account:string|null):ConnectorIdentity {
    if(answer.identityKind!=='declared')return answer;
    if(typeof account!=='string'||!/^[0-9a-f]{24}$/.test(account))throw new SecretError('credential_account_mismatch');
    return {...answer,account};
  }
  private accountTarget(secret:unknown,target:unknown):AccountTarget {
    if(!target||typeof target!=='object'||Array.isArray(target))throw new SecretError('credential_invalid');
    const input=target as Record<string,unknown>;
    if(input.kind==='new'&&Object.keys(input).every(k=>['kind','name'].includes(k)))return {kind:'new',name:accountName(input.name,secret)};
    if(input.kind!=='existing'||!Object.keys(input).every(k=>['kind','id'].includes(k))||typeof input.id!=='string'||!UUID.test(input.id))throw new SecretError('credential_invalid');
    return {kind:'existing',id:input.id};
  }
  private target(owner:string,provider:string,selected:AccountTarget|null,options:Options):{name:string;row:null}|{name:null;row:DeclaredAccount}|null {
    if(this.connector(provider).identityKind!=='declared') {
      if(options.account!==undefined||options.confirmSameAccount!==undefined||options.allowUnknownExpiry!==undefined)throw new SecretError('credential_invalid');return null;
    }
    if(options.allowNoExpiry!==undefined)throw new SecretError('credential_invalid');
    if(!selected)throw new SecretError('credential_invalid');
    if(selected.kind==='new')return {name:selected.name,row:null};
    if(options.confirmSameAccount!==true)throw new SecretError('credential_account_confirmation');
    return {name:null,row:this.accounts.get(owner,provider,selected.id)};
  }
  private answer(row:CredentialRow):Credential {return this.#repository.answer(row.user_id,row.id)!;}
  listAccounts(owner:string,provider:string,limit?:number,after?:string){return this.boundary(()=>this.accounts.list(owner,provider,limit,after));}
  private changed(source:string,owner:string) {
    tell(this.observer,o=>{o.touchSources([source]);o.touchUser(owner);});
    this.onChange(source);
  }
  private replay(owner:string,provider:string,requestId?:string,target?:string):(Credential&{replayed:true})|null {
    if(!requestId)return null;
    const saved=this.db.prepare('SELECT value FROM meta WHERE key=?').get('credential-request:'+owner+':'+requestId)?.value;
    if(typeof saved!=='string')return null;
    const parsed=JSON.parse(saved) as {provider:string;id:string;at:number;target?:string};
    if(Date.now()-parsed.at>=DAY)return null;
    if(parsed.provider!==provider||parsed.target!==target)throw new SecretError('credential_conflict');
    const row=this.#repository.get(owner,parsed.id);if(!row)throw new SecretError('credential_not_found');
    return {...this.answer(row),replayed:true};
  }
  list(owner:string):Credential[]{return this.boundary(()=>this.#repository.list(owner));}
  async create(owner:string,provider:string,secret:unknown,options:Options={}):Promise<Credential&{replayed?:true}> {
    return this.boundaryAsync(async()=>{
      const connector=this.connector(provider);
      // Replay is checked before a dormant account's lifecycle permission.
      const selected=connector.identityKind==='declared'?this.accountTarget(secret,options.account):null;
      const selector=selected?JSON.stringify(selected):undefined;
      const replay=this.replay(owner,provider,options.requestId,selector);if(replay)return replay;
      const target=this.target(owner,provider,selected,options),authority=this.authority();
      return this.secret(connector,secret,async bytes=>{
        const identity=this.validate(connector,await connector.identify(bytes),options);
        let source:string|null=null;
        return this.mutation(()=>{
          const replay=this.replay(owner,provider,options.requestId,selector);if(replay)return replay;
          this.currentAuthority(authority);
          if(target?.row&&!this.accounts.current(target.row))throw new SecretError('credential_conflict');
          const account=target?(target.row??this.accounts.add(owner,provider,target.name!,account=>this.store.source(provider as Provider,account,Date.now()))):null;
          source=account?.source_id??this.store.source(provider as Provider,identity.account!,Date.now());
          const record={id:randomUUID(),user_id:owner,provider};
          const row:CredentialRow={...record,...authority.key.seal(record,bytes),source_id:source,key_version:authority.epoch,hint:bytes.subarray(-4).toString('ascii'),abilities:JSON.stringify(identity.abilities),created_at:Date.now(),expires_at:identity.expiresAt,expiry_kind:account?'unknown':identity.expiresAt===null?'none':'at',last_used_at:null,last_error:null,unreadable:0};
          this.#repository.add(row);this.store.hold(source,owner,row.created_at);
          const resolved=this.resolve(identity,this.store.account(source));
          if(resolved.measurement)this.store.record(source,resolved.measurement);
          if(options.requestId)this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('credential-request:'+owner+':'+options.requestId,JSON.stringify({provider,id:row.id,at:row.created_at,...(selector===undefined?{}:{target:selector})}));
          return this.answer(row);
        },false,()=>{if(source)this.changed(source,owner);});
      });
    });
  }
  async replace(owner:string,id:string,secret:unknown,options:Omit<Options,'account'|'requestId'>={}):Promise<Credential> {
    return this.boundaryAsync(async()=>{
      const row=this.#repository.get(owner,id);if(!row)throw new SecretError('credential_not_found');
      const connector=this.connector(row.provider),declared=connector.identityKind==='declared';
      if(declared) {
        if(options.allowNoExpiry!==undefined)throw new SecretError('credential_invalid');
        if(options.confirmSameAccount!==true)throw new SecretError('credential_account_confirmation');
      }else if(options.confirmSameAccount!==undefined||options.allowUnknownExpiry!==undefined)throw new SecretError('credential_invalid');
      const authority=this.authority();
      const binding=declared?this.accounts.forSource(owner,row.provider,row.source_id??''):null;
      if(declared&&!binding)throw new SecretError('declared_account_not_found');
      return this.secret(connector,secret,async bytes=>{
        const identity=this.resolve(this.validate(connector,await connector.identify(bytes),options),this.store.account(row.source_id!));
        if(!row.source_id||this.store.account(row.source_id)!==identity.account)throw new SecretError('credential_account_mismatch');
        return this.mutation(()=>{
          this.currentAuthority(authority);
          if(binding&&!this.accounts.current(binding)||!this.#repository.current(row)||!this.#repository.replace(owner,id,authority.key.seal(row,bytes),authority.epoch,bytes.subarray(-4).toString('ascii'),row))throw new SecretError('credential_conflict');
          this.db.prepare('UPDATE credentials SET abilities=?,expires_at=?,expiry_kind=?,last_used_at=NULL WHERE id=? AND user_id=?').run(JSON.stringify(identity.abilities),identity.expiresAt,declared?'unknown':identity.expiresAt===null?'none':'at',id,owner);
          if(identity.measurement)this.store.record(row.source_id!,identity.measurement);
          return this.answer(this.#repository.get(owner,id)!);
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
    try{this.authority();}catch{return false;}
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
      return {error,expiresAt:expiry.length?Math.min(...expiry):null,expiryKind:expiry.length?'at':rows.some(r=>r.expiryKind==='unknown')?'unknown':'none',canRefresh:this.refreshable(source,now),credentialIds:rows.map(r=>r.id)};
    });
  }
  sources():string[]{return this.boundary(()=>[...new Set((this.db.prepare('SELECT source_id FROM credentials WHERE source_id IS NOT NULL').all() as {source_id:string}[]).map(r=>r.source_id))]);}
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
          const connector=this.connector(row.provider),authority=this.authority(),key=authority.key;
          if(row.expires_at!==null&&row.expires_at<=Date.now())throw new SecretError('credential_expired');
          const result=this.resolve(this.validate(connector,await key.use(row,async bytes=>{decrypted=true;return connector.measure(bytes,{account:this.store.account(source)!,expiresAt:row.expires_at},signal);}),{allowNoExpiry:true,allowUnknownExpiry:true}),this.store.account(source));
          if(result.account!==this.store.account(source))throw new SecretError('credential_account_mismatch');
          if(!result.measurement)throw new SecretError('connector_invalid_response');
          const staleAfterMs=Math.min(86_400_000,Math.round(interval(result)*1.2)+60_000);
          result.measurement={...result.measurement,staleAfterMs,meters:result.measurement.meters.map(m=>({...m,staleAfterMs})),keys:result.measurement.keys.map(k=>({...k,staleAfterMs})),...(result.measurement.balanceStatus?{balanceStatus:{...result.measurement.balanceStatus,staleAfterMs}}:{})};
          const accepted=this.mutation(()=>{
            if(signal?.aborted||!valid()||!this.#repository.current(row)||!this.store.holds(row.user_id,source))return false;
            this.currentAuthority(authority);
            this.#repository.used(row.user_id,row.id,row,result.abilities,result.expiresAt,connector.identityKind==='declared'?'unknown':result.expiresAt===null?'none':'at');
            this.store.record(source,result.measurement!);
            return true;
          },false);
          if(accepted)tell(this.observer,o=>o.touchUser(row.user_id));
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
