import {randomUUID} from 'node:crypto';
import type {Store} from './store/store.js';
import type {Board, Directory} from './store/directory.js';
import {SecretError, secretCode, permanentAccess, type Credentials, type VerifiedAccess} from './secrets/index.js';
import {checkpoint} from './secrets/start.js';
import {cardId, providerNames} from './domain/presentation.js';
import type {View} from './domain/view.js';

const DAY = 86_400_000, LEASE = 30_000;
export const WIDGETS = ['agents', 'activity', 'history', 'forecast'] as const;
export type WidgetId = typeof WIDGETS[number];
export type AdditionItem = {kind: 'sources'; sourceIds: string[]} | {kind: 'widget'; widgetId: WidgetId} |
  {kind: 'connection'; provider: string} | {kind: 'replace'; credentialId: string; provider?: string; sourceId?: string; expectedRevision?: number};
type Result = {sourceIds: string[]; credentialId?: string; connection?: 'created' | 'reused'; expiresAt?: number | null;
  placement?: 'added' | 'already_visible' | 'personal'; viewRevision?: number; credentialRevision?: number; appliedAt: number; maintenance?: 'pending' | 'ok'; replacementRequired?: boolean};
type State = 'ready' | 'verifying' | 'needs_input' | 'complete' | 'failed' | 'expired';
type Row = {id: string; owner_id: string; request_id: string; board_id: string | null; item: string; state: State;
  result: string | null; error: string | null; created_at: number; updated_at: number; expires_at: number;
  attempt_generation: number; run_id: string | null; verify_until: number | null; onboarding_id: string | null};
export class AdditionError extends Error {
  constructor(readonly code: 'addition_invalid' | 'addition_conflict' | 'addition_not_found' | 'addition_limit' | 'addition_expired' | 'addition_permission' | 'addition_unavailable' | 'addition_interrupted') {super(code);}
}
const hidden = (view: View, id: string) => id === 'agents' ? !view.shown.includes(id) : view.hidden.includes(id);
export const widgetVisible = (view: View, id: string, sources: number) => !hidden(view, id) && (sources > 0 || (view.enabledWhenEmpty ?? []).includes(id));

/** Publication changes only the requested visibility, preserving layout and display options. */
function shown(view: View, ids: string[]): View {
  return {...view, hidden: view.hidden.filter(id => !ids.includes(id)),
    shown: ids.includes('agents') ? [...new Set([...view.shown, 'agents'])] : view.shown,
    enabledWhenEmpty: [...new Set([...(view.enabledWhenEmpty ?? []), ...ids.filter(id => WIDGETS.includes(id as WidgetId))])]};
}

/** A bounded, owner-private ledger for the board's four addition actions. It never stores secrets. */
export class BoardAdditions {
  private readonly running = new Map<string, Promise<ReturnType<BoardAdditions['answer']>>>();
  private readonly runId = randomUUID();
  constructor(private readonly store: Store, private readonly directory: Directory, private readonly credentials: Credentials, private readonly now = Date.now) {}

  private board(owner: string, id: string): Board {
    const board = this.directory.boards(owner).find(board => board.id === id);
    if (!board) throw new AdditionError('addition_permission');
    return board;
  }
  private eligible(owner: string, board: Board, ids: string[]) {
    const provided = new Set(this.store.sources(board.id).map(source => source.id));
    if (ids.some(id => !this.store.holds(owner, id) && !(board.role === 'owner' && provided.has(id)))) throw new AdditionError('addition_permission');
  }
  catalogue(owner: string, boardId: string) {
    const board = this.board(owner, boardId), own = this.store.held(owner), sources = this.store.sources(boardId), view = this.directory.view(boardId);
    const personal = this.directory.boards(owner).find(board => board.personal)!;
    const ownNames = this.directory.view(personal.id).names;
    const candidates = [...own, ...sources.filter(source => !own.some(item => item.id === source.id))];
    const totals=new Map<string,number>(),counts=new Map<string,number>();
    for(const source of candidates)totals.set(source.provider,(totals.get(source.provider)??0)+1);
    const labels=new Map(candidates.map(source=>{
      const count=(counts.get(source.provider)??0)+1;counts.set(source.provider,count);
      return [source.id,(providerNames[source.provider]??source.provider)+(totals.get(source.provider)!>1?' '+count:'')];
    }));
    return {board, viewRevision: this.directory.viewRevision(boardId), connectionsRevision: this.directory.connectionsRevision(owner),
      sources: candidates.flatMap(source => {
        const mine = this.store.holds(owner, source.id), onBoard = sources.some(item => item.id === source.id), visible = onBoard && !hidden(view, cardId(source.id));
        if (visible || !mine && board.role !== 'owner') return [];
        const label = (mine ? ownNames[source.id] : view.names[source.id]) ?? labels.get(source.id)!;
        return [{id: source.id, provider: source.provider, label, origin: mine ? 'own' : 'shared', onBoard, visible, action: onBoard ? 'show' : 'add'}];
      }),
      widgets: board.role === 'owner' ? WIDGETS.filter(id => !widgetVisible(view, id, sources.length)).map(id => ({id, action: 'add'})) : [],
      connectors: this.credentials.providers()};
  }

  placements(owner: string, credentialId: string) {
    const record=this.credentials.list(owner).find(record=>record.id===credentialId);
    if(!record)throw new AdditionError('addition_not_found');
    return this.directory.boards(owner).filter(board=>record.sourceId&&this.store.sources(board.id).some(source=>source.id===record.sourceId)).map(board=>({...board,
      visible:!hidden(this.directory.view(board.id),cardId(record.sourceId!)),canUnshare:!board.personal&&(board.role==='owner'||this.store.holds(owner,record.sourceId!))}));
  }

  private normalize(owner: string, boardId: string | null, item: AdditionItem): AdditionItem {
    const board = boardId === null ? null : this.board(owner, boardId);
    if (item.kind === 'sources') {
      if (!board) throw new AdditionError('addition_invalid');
      const sourceIds = [...new Set(item.sourceIds)].sort(); this.eligible(owner, board, sourceIds);
      return {kind: 'sources', sourceIds};
    }
    if (item.kind === 'widget') {
      if (!board || board.role !== 'owner') throw new AdditionError('addition_permission');
      return {kind: 'widget', widgetId: item.widgetId};
    }
    if (item.kind === 'connection') {
      if (!this.credentials.providers().some(provider => provider.id === item.provider)) throw new AdditionError('addition_invalid');
      return {kind: 'connection', provider: item.provider};
    }
    if (board) throw new AdditionError('addition_invalid');
    const record = this.credentials.list(owner).find(record => record.id === item.credentialId);
    if (!record?.sourceId) throw new AdditionError('addition_not_found');
    return {kind: 'replace', credentialId: record.id, provider: record.provider, sourceId: record.sourceId, expectedRevision: record.revision};
  }

  reserve(owner: string, requestId: string, boardId: string | null, item: AdditionItem) {
    return this.directory.transaction(() => {
      this.prune();
      const previous = this.store.db.prepare('SELECT * FROM board_additions WHERE owner_id=? AND request_id=?').get(owner, requestId) as Row | undefined;
      if (previous) {
        const saved = JSON.parse(previous.item) as AdditionItem;
        const normalized = item.kind === 'sources' ? {...item, sourceIds: [...new Set(item.sourceIds)].sort()} : item;
        const binding = saved.kind === 'replace' ? {kind: saved.kind, credentialId: saved.credentialId} : saved;
        if (previous.board_id !== boardId || JSON.stringify(binding) !== JSON.stringify(normalized)) throw new AdditionError('addition_conflict');
        return this.answer(previous);
      }
      const normalized = this.normalize(owner, boardId, item);
      const count = (this.store.db.prepare("SELECT count(*) AS n FROM board_additions WHERE owner_id=? AND state IN ('ready','verifying','needs_input')").get(owner) as {n: number}).n;
      if (count >= 20) throw new AdditionError('addition_limit');
      const id = randomUUID(), now = this.now();
      this.store.db.prepare('INSERT INTO board_additions (id,owner_id,request_id,board_id,item,state,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,owner,requestId,boardId,JSON.stringify(normalized),'ready',now,now,now+DAY);
      return this.get(owner, id);
    });
  }

  private row(owner: string, id: string): Row {
    const row = this.store.db.prepare('SELECT * FROM board_additions WHERE owner_id=? AND id=?').get(owner,id) as Row | undefined;
    if (!row || row.updated_at < this.now()-30*DAY) throw new AdditionError('addition_not_found');
    return row;
  }
  get(owner: string, id: string) {this.recover(); return this.answer(this.row(owner,id));}
  list(owner: string, limit = 20, before?: string, requestId?: string) {
    this.prune();
    if (requestId) {
      const row = this.store.db.prepare('SELECT id FROM board_additions WHERE owner_id=? AND request_id=?').get(owner,requestId) as {id:string}|undefined;
      if (!row) throw new AdditionError('addition_not_found');
      return {operations:[this.get(owner,row.id)], next:null};
    }
    let cursor: [string, number, string] | undefined;
    if (before) {
      try {cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));} catch {throw new AdditionError('addition_invalid');}
      if (!Array.isArray(cursor)||cursor.length!==3||cursor[0]!==owner||!Number.isSafeInteger(cursor[1])||typeof cursor[2]!=='string') throw new AdditionError('addition_invalid');
    }
    const rows = this.store.db.prepare('SELECT * FROM board_additions WHERE owner_id=? AND updated_at>=?'+(cursor?' AND (created_at<? OR (created_at=? AND id<?))':'')+' ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(owner,this.now()-30*DAY,...(cursor?[cursor[1],cursor[1],cursor[2]]:[]),limit+1) as Row[];
    const page=rows.slice(0,limit),last=page.at(-1);
    return {operations:page.map(row=>this.answer(row)),next:rows.length>limit&&last?Buffer.from(JSON.stringify([owner,last.created_at,last.id])).toString('base64url'):null};
  }
  private recover() {
    const now=this.now();
    this.store.db.prepare("UPDATE board_additions SET state='expired',error='addition_expired',updated_at=?,attempt_generation=attempt_generation+1,run_id=NULL,verify_until=NULL WHERE state IN ('ready','verifying','needs_input') AND expires_at<=?").run(now,now);
    this.store.db.prepare("UPDATE board_additions SET state='needs_input',error='addition_interrupted',updated_at=?,attempt_generation=attempt_generation+1,run_id=NULL,verify_until=NULL WHERE state='verifying' AND verify_until<=?").run(now,now);
  }
  prune() {this.recover();this.store.db.prepare('DELETE FROM board_additions WHERE updated_at<?').run(this.now()-30*DAY);}

  private answer(row: Row) {
    const item=JSON.parse(row.item) as AdditionItem,result=row.result?JSON.parse(row.result) as Result:undefined;
    const personal=this.directory.boards(row.owner_id).find(board=>board.personal);
    const destination=row.board_id??personal?.id, accessible=destination?this.directory.membership(destination,row.owner_id)!==null:false;
    const view=accessible?this.directory.view(destination!):null, sources=accessible?this.store.sources(destination!):[];
    const credential=result?.credentialId?this.credentials.list(row.owner_id).find(record=>record.id===result.credentialId):undefined;
    return {id:row.id,boardId:row.board_id,item,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,retainedUntil:row.updated_at+30*DAY,
      ...(result?{result}:{}),...(row.error?{error:row.error}:{}),
      ...(result?.maintenance==='pending'?{warning:'credential_cleanup_pending'}:{}),
      current:{boardAccessible:row.board_id===null?null:accessible,
        ...(result?{sources:result.sourceIds.map(id=>({id,placement:!accessible?'unavailable':!sources.some(source=>source.id===id)?'removed':hidden(view!,cardId(id))?'hidden':'visible'}))}:{}),
        ...(item.kind==='widget'?{widget:{id:item.widgetId,placement:!accessible?'unavailable':widgetVisible(view!,item.widgetId,sources.length)?'visible':'hidden'}}:{}),
        ...(result?.credentialId?{credential:{exists:!!credential,revisionMatches:credential?.revision===result.credentialRevision}}:{})}};
  }

  run(owner: string, id: string, secret: unknown, validSession: () => boolean) {
    const row=this.row(owner,id);
    if (row.state==='complete') {if(row.result&&JSON.parse(row.result).maintenance==='pending')this.maintenance(owner,id);return Promise.resolve(this.get(owner,id));}
    const pending=this.running.get(id);if(pending)return pending;
    const work=this.perform(owner,id,secret,validSession).finally(()=>this.running.delete(id));
    this.running.set(id,work);return work;
  }

  private async perform(owner: string, id: string, secret: unknown, validSession: () => boolean) {
    const attempt=this.directory.transaction(()=>{
      this.recover();const row=this.row(owner,id);
      if(['complete','failed','expired','verifying'].includes(row.state))return null;
      if(!validSession())throw new AdditionError('addition_permission');
      if(row.board_id!==null)this.board(owner,row.board_id);
      const now=this.now();
      this.store.db.prepare("UPDATE board_additions SET state='verifying',error=NULL,updated_at=?,attempt_generation=attempt_generation+1,run_id=?,verify_until=? WHERE id=?").run(now,this.runId,now+LEASE,id);
      return this.row(owner,id);
    });
    if(!attempt)return this.get(owner,id);
    const item=JSON.parse(attempt.item) as AdditionItem;
    let verified:VerifiedAccess|undefined;
    try {
      if(item.kind==='connection'||item.kind==='replace') {
        const signal=AbortSignal.timeout(25_000);
        // A nonconforming adapter cannot extend a verification lease or keep bytes after timeout.
        const verification=this.credentials.verify(item.provider!,secret,signal);
        verified=await new Promise<VerifiedAccess>((resolve,reject)=>{
          signal.addEventListener('abort',()=>reject(new SecretError('connector_timeout')),{once:true});
          void verification.then(value=>{if(signal.aborted)value.dispose();else resolve(value);},reject);
        });
      }
      this.directory.transaction(()=>{
        const row=this.row(owner,id),now=this.now();
        if(row.state!=='verifying'||row.attempt_generation!==attempt.attempt_generation||row.run_id!==this.runId||row.verify_until!<=now||row.expires_at<=now)throw new AdditionError('addition_interrupted');
        if(!validSession()||!this.directory.user(owner))throw new AdditionError('addition_permission');
        const board=row.board_id===null?null:this.board(owner,row.board_id);
        let result:Result={sourceIds:[],appliedAt:now};
        if(item.kind==='connection'||item.kind==='replace') {
          const saved=this.credentials.commitVerified(owner,verified!,item.kind==='replace'?{id:item.credentialId,revision:item.expectedRevision!}:undefined);
          result={...result,sourceIds:[saved.credential.sourceId!],credentialId:saved.credential.id,credentialRevision:saved.credential.revision,
            connection:saved.connection,expiresAt:saved.credential.expiresAt,...(item.kind==='replace'?{maintenance:'pending' as const}:{})};
          if(saved.connection==='reused'&&(saved.credential.unreadable||permanentAccess(saved.credential.lastError??'')||saved.credential.expiresAt!==null&&saved.credential.expiresAt<=now))result.replacementRequired=true;
        } else if(item.kind==='sources') result.sourceIds=item.sourceIds;
        if(board) {
          if(item.kind==='widget'&&board.role!=='owner')throw new AdditionError('addition_permission');
          this.eligible(owner,board,result.sourceIds);
          const view=this.directory.view(board.id),existing=this.store.sources(board.id);
          const ids=item.kind==='widget'?[item.widgetId]:result.sourceIds.map(cardId);
          const already=item.kind==='widget'?widgetVisible(view,item.widgetId,existing.length):result.sourceIds.every(id=>existing.some(source=>source.id===id)&&!hidden(view,cardId(id)));
          if(!board.personal)for(const source of result.sourceIds)if(this.store.holds(owner,source))this.store.share(board.id,source,owner,now);
          result.viewRevision=this.directory.saveView(board.id,shown(view,ids),owner,now);
          result.placement=already?'already_visible':'added';
        } else result.placement='personal';
        if(row.onboarding_id)this.completeOnboarding(row.onboarding_id,owner,id,result.sourceIds);
        this.store.db.prepare("UPDATE board_additions SET state='complete',result=?,error=NULL,updated_at=?,run_id=NULL,verify_until=NULL WHERE id=?").run(JSON.stringify(result),now,id);
      });
      if(item.kind==='replace')this.maintenance(owner,id);
    } catch(error) {
      const code=error instanceof AdditionError?error.code:secretCode(error instanceof SecretError?error.code:null)??'credential_failed';
      this.directory.transaction(()=>{
        this.store.db.prepare("UPDATE board_additions SET state=?,error=?,updated_at=?,run_id=NULL,verify_until=NULL WHERE id=? AND owner_id=? AND state='verifying' AND attempt_generation=? AND run_id=?")
          .run(code==='addition_permission'?'failed':'needs_input',code,this.now(),id,owner,attempt.attempt_generation,this.runId);
      });
    } finally {verified?.dispose();}
    return this.get(owner,id);
  }

  private completeOnboarding(intent: string, owner: string, addition: string, sources: string[]) {
    const row=this.store.db.prepare('SELECT * FROM device_onboarding WHERE id=? AND user_id=? AND addition_id=?').get(intent,owner,addition) as {device_id:string;source_ids:string;status:string;expires_at:number}|undefined;
    if(!row||row.status==='expired'||row.expires_at<=this.now()||!this.directory.deviceLive(row.device_id)||JSON.stringify(sources)!==row.source_ids)throw new AdditionError('addition_permission');
    const device=this.directory.deviceById(row.device_id);
    const delivered=this.store.deviceSources(owner).filter(source=>source.device===row.device_id).map(source=>source.source);
    if(device?.userId!==owner||sources.some(id=>!delivered.includes(id)))throw new AdditionError('addition_permission');
    this.store.db.prepare("UPDATE device_onboarding SET status='complete' WHERE id=?").run(intent);
  }
  private maintenance(owner: string, id: string) {
    try {
      checkpoint(this.store.db,'credential_cleanup_pending');
      const row=this.row(owner,id),result=JSON.parse(row.result!) as Result;
      this.store.db.prepare('UPDATE board_additions SET result=? WHERE owner_id=? AND id=?').run(JSON.stringify({...result,maintenance:'ok'}),owner,id);
      checkpoint(this.store.db,'credential_cleanup_pending');
    } catch { /* The committed receipt remains complete and truthfully reports pending cleanup. */ }
  }
}
