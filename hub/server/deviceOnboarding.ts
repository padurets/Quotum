import {randomUUID} from 'node:crypto';
import {AdditionError, BoardAdditions} from './additions.js';
import type {Store} from './store/store.js';
import type {Directory} from './store/directory.js';

const DAY=86_400_000;
type Intent = {id:string;request_id:string;user_id:string;board_id:string;code_id:string|null;token_id:string|null;device_id:string|null;source_ids:string|null;addition_id:string|null;created_at:number;expires_at:number;status:string};

/** Connecting a device never grants its present or future accounts blanket access to a board. */
export class DeviceOnboarding {
  constructor(private readonly store:Store,private readonly directory:Directory,private readonly additions:BoardAdditions) {}
  private row(owner:string,id:string):Intent {
    const row=this.store.db.prepare('SELECT * FROM device_onboarding WHERE id=? AND user_id=?').get(id,owner) as Intent|undefined;
    if(!row||row.created_at<Date.now()-30*DAY)throw new AdditionError('addition_not_found');
    return row;
  }
  private allowed(row:Intent) {
    if(row.expires_at<=Date.now()||row.status==='expired')throw new AdditionError('addition_expired');
    if(!this.directory.membership(row.board_id,row.user_id))throw new AdditionError('addition_permission');
  }
  reserve(owner:string,requestId:string,board:string) {
    return this.directory.transaction(()=>{
      this.prune();
      const previous=this.store.db.prepare('SELECT id,board_id FROM device_onboarding WHERE user_id=? AND request_id=?').get(owner,requestId) as {id:string;board_id:string}|undefined;
      if(previous) {if(previous.board_id!==board)throw new AdditionError('addition_conflict');return this.get(owner,previous.id);}
      if(!this.directory.membership(board,owner))throw new AdditionError('addition_permission');
      const count=(this.store.db.prepare("SELECT count(*) AS n FROM device_onboarding WHERE user_id=? AND status NOT IN ('complete','expired')").get(owner) as {n:number}).n;
      if(count>=20)throw new AdditionError('addition_limit');
      const id=randomUUID(),now=Date.now();
      this.store.db.prepare('INSERT INTO device_onboarding (id,request_id,user_id,board_id,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?)').run(id,requestId,owner,board,now,now+DAY,'ready');
      return this.get(owner,id);
    });
  }
  get(owner:string,id:string) {
    const row=this.row(owner,id),accessible=!!this.directory.membership(row.board_id,owner);
    return {id:row.id,boardId:row.board_id,createdAt:row.created_at,expiresAt:row.expires_at,status:row.status!=='complete'&&row.expires_at<=Date.now()?'expired':row.status,
      boardAccessible:accessible,deviceId:row.device_id,sourceIds:row.source_ids?JSON.parse(row.source_ids) as string[]:[],additionId:row.addition_id};
  }
  list(owner:string,limit=20,before?:string) {
    this.prune();
    const cursor=before?this.row(owner,before):undefined;
    const rows=this.store.db.prepare('SELECT id FROM device_onboarding WHERE user_id=?'+(cursor?' AND (created_at<? OR (created_at=? AND id<?))':'')+' ORDER BY created_at DESC,id DESC LIMIT ?').all(owner,...(cursor?[cursor.created_at,cursor.created_at,cursor.id]:[]),limit+1) as {id:string}[];
    const page=rows.slice(0,limit);
    return {intents:page.map(row=>this.get(owner,row.id)),next:rows.length>limit?page.at(-1)!.id:null};
  }
  bindCode(owner:string,id:string,code:string) {
    const row=this.row(owner,id);this.allowed(row);
    if(row.status!=='ready'||row.code_id&&row.code_id!==code)throw new AdditionError('addition_conflict');
    this.store.db.prepare('UPDATE device_onboarding SET code_id=? WHERE id=?').run(code,id);
  }
  bindToken(owner:string,id:string,token:string) {
    const row=this.row(owner,id);this.allowed(row);
    if(row.status!=='ready'||row.token_id&&row.token_id!==token)throw new AdditionError('addition_conflict');
    this.store.db.prepare('UPDATE device_onboarding SET token_id=? WHERE id=?').run(token,id);
  }
  select(owner:string,id:string,deviceId:string,sourceIds:string[],requestId:string) {
    return this.directory.transaction(()=>{
      const row=this.row(owner,id),ids=[...new Set(sourceIds)].sort();
      if(row.addition_id) {
        if(row.device_id!==deviceId||row.source_ids!==JSON.stringify(ids))throw new AdditionError('addition_conflict');
        // The same selection keeps the same receipt after close, expiry or later device revocation.
        const operation=this.additions.reserve(owner,requestId,row.board_id,{kind:'sources',sourceIds:ids});
        if(operation.id!==row.addition_id)throw new AdditionError('addition_conflict');
        return operation;
      }
      this.allowed(row);
      const device=this.directory.deviceById(deviceId),delivered=this.store.deviceSources(owner).filter(source=>source.device===deviceId).map(source=>source.source);
      if(device?.userId!==owner||!this.directory.deviceLive(deviceId)||row.code_id&&row.device_id!==deviceId||ids.some(source=>!delivered.includes(source)))throw new AdditionError('addition_permission');
      const operation=this.additions.reserve(owner,requestId,row.board_id,{kind:'sources',sourceIds:ids});
      const binding=this.store.db.prepare('SELECT onboarding_id,state FROM board_additions WHERE id=?').get(operation.id) as {onboarding_id:string|null;state:string};
      if(binding.onboarding_id&&binding.onboarding_id!==id||binding.state==='complete')throw new AdditionError('addition_conflict');
      this.store.db.prepare("UPDATE device_onboarding SET device_id=?,source_ids=?,addition_id=?,status='selected' WHERE id=?").run(deviceId,JSON.stringify(ids),operation.id,id);
      this.store.db.prepare('UPDATE board_additions SET onboarding_id=? WHERE id=? AND onboarding_id IS NULL').run(id,operation.id);
      return operation;
    });
  }
  prune() {
    this.store.db.prepare("UPDATE device_onboarding SET status='expired' WHERE status NOT IN ('complete','expired') AND expires_at<=?").run(Date.now());
    this.store.db.prepare('DELETE FROM device_onboarding WHERE created_at<?').run(Date.now()-30*DAY);
  }
}
