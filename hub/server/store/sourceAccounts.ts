import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {sha256} from '../domain/auth.js';
import {SecretError} from '../secrets/crypto.js';

export type AccountTarget = {kind:'new';name:string}|{kind:'existing';id:string};
export type DeclaredAccount = {id:string;user_id:string;provider:string;source_id:string;name:string;name_key:string;created_at:bigint;lifecycle_revision:bigint};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function accountName(value:unknown,secret:unknown):string {
  if(typeof value!=='string')throw new SecretError('credential_invalid');
  const name=value.normalize('NFKC').trim();
  if(!name||Array.from(name).length>120||/[\u0000-\u001f\u007f-\u009f]/.test(name)||/sk-[A-Za-z0-9_-]{16,}/i.test(name)||typeof secret==='string'&&secret.length>0&&name.includes(secret))throw new SecretError('credential_invalid');
  return name;
}
export const declaredPseudonym=(owner:string,provider:string,id:string)=>sha256('quotum/declared-account/v1\n'+owner+'\n'+provider+'\n'+id).slice(0,24);

/** Private identities survive withdrawal; their existence grants no holding. */
export class SourceAccounts {
  constructor(private readonly db:DatabaseSync){}
  get(owner:string,provider:string,id:string):DeclaredAccount {
    const query=this.db.prepare('SELECT * FROM declared_accounts WHERE user_id=? AND provider=? AND id=?');query.setReadBigInts(true);
    const row=query.get(owner,provider,id) as DeclaredAccount|undefined;
    if(!row)throw new SecretError('declared_account_not_found');return row;
  }
  forSource(owner:string,provider:string,source:string):DeclaredAccount {
    const id=this.db.prepare('SELECT id FROM declared_accounts WHERE user_id=? AND provider=? AND source_id=?').get(owner,provider,source)?.id;
    if(typeof id!=='string')throw new SecretError('declared_account_not_found');return this.get(owner,provider,id);
  }
  current(row:DeclaredAccount):boolean {
    return !!this.db.prepare('SELECT 1 FROM declared_accounts WHERE id=? AND user_id=? AND provider=? AND source_id=? AND lifecycle_revision=?').get(row.id,row.user_id,row.provider,row.source_id,row.lifecycle_revision);
  }
  add(owner:string,provider:string,name:string,source:(account:string)=>string):DeclaredAccount {
    if(this.db.prepare('SELECT 1 FROM declared_accounts WHERE user_id=? AND provider=? AND name_key=?').get(owner,provider,name.toLowerCase()))throw new SecretError('declared_account_name_conflict');
    const id=randomUUID(),sourceId=source(declaredPseudonym(owner,provider,id));
    this.db.prepare('INSERT INTO declared_accounts (id,user_id,provider,source_id,name,name_key,created_at) VALUES (?,?,?,?,?,?,?)').run(id,owner,provider,sourceId,name,name.toLowerCase(),Date.now());
    return this.get(owner,provider,id);
  }
  list(owner:string,provider:string,limit=50,after='') {
    if(provider!=='deepseek'||!Number.isSafeInteger(limit)||limit<1||limit>50||after&&!UUID.test(after))throw new SecretError('credential_invalid');
    if(after)this.get(owner,provider,after);
    const rows=this.db.prepare('SELECT a.id,a.provider,a.name,a.source_id AS sourceId, EXISTS(SELECT 1 FROM credentials c WHERE c.user_id=a.user_id AND c.source_id=a.source_id) AS connected FROM declared_accounts a WHERE a.user_id=? AND a.provider=? AND a.id>? ORDER BY a.id LIMIT ?').all(owner,provider,after,limit+1) as {id:string;provider:string;name:string;sourceId:string;connected:number}[];
    return {accounts:rows.slice(0,limit).map(r=>({...r,connected:!!r.connected})),next:rows.length>limit?rows[limit-1].id:null};
  }
}
