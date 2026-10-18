import {randomBytes} from 'node:crypto';
import {config} from './config.js';
import {ActivityConflict, activityScopeDigest, activityStateDigest, type ActivityRequest, type ActivityHello, type ActivityBatch, type ActivityState, type ActivityLatest, type ClockAnchor} from './domain/activity.js';
import {CLOCK_TOLERANCE_MS, Invalid, subscriptionKey, type Tracking} from './domain/ingest.js';
import type {Device} from './store/directory.js';
import type {Store, WorkKey} from './store/store.js';
import {KEEP_MS, type Sessions, type LiveSession} from './sessions.js';
import {afterCommit} from './touches.js';
import {mergeEvidence} from './domain/sessionEvidence.js';

type Cursor={device_id:string;queue_id:string;authority_epoch:string;floor_at:number;last_open_id:string;accepted_seq:number;
  checkpoint:string|null;clock_anchor:string|null;capture_epoch:string|null;last_tick:number|null;last_at:number|null;latest_at:number|null};
type Witness={witness_id:string;topology_version:number;scope_digest:string;issued_at:number};
const opaque=()=>randomBytes(16).toString('hex');

/** One transaction owns authority, history, coverage and the acknowledged FIFO prefix. */
export class ActivityIngest {
  constructor(private readonly store:Store,private readonly live:Sessions) {}
  required(device:string):boolean {return !!this.cursor(device);}
  private cursor(device:string):Cursor|null {return this.store.db.prepare('SELECT * FROM device_activity WHERE device_id=?').get(device) as Cursor|undefined??null;}
  private binding(row:Cursor,request:Exclude<ActivityRequest,ActivityHello>) {
    if(row.queue_id!==request.queueId||row.authority_epoch!==request.authorityEpoch)throw new ActivityConflict('activity_stream_replaced');
  }
  accept(device:Device,request:ActivityRequest,now:number) {
    if(request.op==='hello')return this.hello(device,request,now);
    const row=this.cursor(device.id);
    if(!row)throw new ActivityConflict('activity_binding');
    this.binding(row,request);
    if(request.op==='batch')return this.batch(device,row,request,now);
    const presenceAccepted=this.presence(device,row,request.latest,request.clockAnchor,now);
    const feedback=this.feedback(device,row,request.topologyWitnessId,request.latest.state.tracking);
    return {version:1,queueId:row.queue_id,authorityEpoch:row.authority_epoch,acknowledgedThrough:row.accepted_seq,presenceAccepted,...feedback};
  }

  private hello(device:Device,request:ActivityHello,now:number) {
    let row=this.cursor(device.id);
    const migrated=row!==null;
    const previousFloor=Math.max(row?.floor_at??0,row?.last_at??0);
    if(row&&row.queue_id!==request.queueId){
      if(request.replaceAuthorityEpoch!==row.authority_epoch)throw new ActivityConflict('activity_binding',{queueId:row.queue_id,authorityEpoch:row.authority_epoch});
      this.store.db.prepare('DELETE FROM device_activity_witnesses WHERE device_id=?').run(device.id);
      this.store.db.prepare('DELETE FROM device_activity WHERE device_id=?').run(device.id);
      row=null;
    }
    if(!row){
      if(!migrated)this.live.settleLegacy(device.id,now);
      const high=Number(this.store.db.prepare('SELECT max(w.to_at) AS at FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id WHERE s.device_id=?').get(device.id)?.at??0);
      this.store.db.prepare('INSERT INTO device_activity(device_id,queue_id,authority_epoch,floor_at,last_open_id) VALUES (?,?,?,?,?)')
        .run(device.id,request.queueId,opaque(),Math.max(now,high,previousFloor),request.openId);
      row=this.cursor(device.id)!;
      afterCommit(()=>this.live.forget([device.id]));
    }
    if(request.acknowledgedThrough>row.accepted_seq)throw new ActivityConflict('activity_sequence',{expectedSeq:row.accepted_seq+1});
    const topologyVersion=this.store.coverage.topology(device.userId),scope=activityScopeDigest(request.tracking);
    this.store.db.prepare('DELETE FROM device_activity_witnesses WHERE device_id=? AND topology_version<>?').run(device.id,topologyVersion);
    const read='SELECT * FROM device_activity_witnesses WHERE device_id=? AND queue_id=? AND authority_epoch=? AND topology_version=? AND scope_digest=? AND ';
    // A retry reuses its issued proof, but every attempt gets the current server clock.
    const prefix=[device.id,row.queue_id,row.authority_epoch,topologyVersion,scope];
    let witness:Witness|undefined;
    if(request.knownWitnessId)witness=this.store.db.prepare(read+'witness_id=?').get(...prefix,request.knownWitnessId) as Witness|undefined;
    witness??=this.store.db.prepare(read+'issued_open_id=?').get(...prefix,request.openId) as Witness|undefined;
    if(!witness&&Number(this.store.db.prepare('SELECT count(*) AS n FROM device_activity_witnesses WHERE device_id=?').get(device.id)?.n)<256){
      witness={witness_id:opaque(),topology_version:topologyVersion,scope_digest:scope,issued_at:now};
      this.store.db.prepare('INSERT INTO device_activity_witnesses VALUES (?,?,?,?,?,?,?,?)').run(device.id,row.queue_id,row.authority_epoch,witness.witness_id,topologyVersion,scope,now,request.openId);
    }
    this.store.db.prepare('UPDATE device_activity SET last_open_id=? WHERE device_id=?').run(request.openId,device.id);
    if(this.store.coverage.policy(device.id,request.tracking,now,device.userId))afterCommit(()=>this.store.links.onChange?.(device.userId));
    // Hello calibration belongs to this attempt; it never changes the prefix anchor.
    let presenceAccepted=false;
    if(request.latest&&request.latest.clockEpoch===request.clock.clockEpoch){
      const offset=Math.abs(now-request.clock.wall)>CLOCK_TOLERANCE_MS?now-request.clock.wall:0;
      presenceAccepted=this.presence(device,row,request.latest,{clockEpoch:request.clock.clockEpoch,anchorTick:request.clock.tick,anchorAt:request.clock.wall+offset},now);
    }
    return {version:1,protocol:'observed-intervals',hubId:String(this.store.db.prepare("SELECT value FROM meta WHERE key='activityHubId'").get()!.value),deviceId:device.id,
      queueId:row.queue_id,authorityEpoch:row.authority_epoch,floorAt:row.floor_at,acknowledgedThrough:row.accepted_seq,serverTime:now,topologyVersion,
      acceptedClockAnchor:row.clock_anchor?JSON.parse(row.clock_anchor) as ClockAnchor:null,
      topologyWitness:witness?{id:witness.witness_id,topologyVersion,scopeDigest:scope,issuedAt:witness.issued_at}:null,
      coverageRefreshRequired:!witness,presenceAccepted,...(!witness?{reason:'witness_capacity'}:{})};
  }

  private witness(device:Device,row:Cursor,id:string|null,tracking:Tracking):Witness|null {
    if(!id)return null;
    return this.store.db.prepare('SELECT * FROM device_activity_witnesses WHERE device_id=? AND queue_id=? AND authority_epoch=? AND witness_id=? AND topology_version=? AND scope_digest=?')
      .get(device.id,row.queue_id,row.authority_epoch,id,this.store.coverage.topology(device.userId),activityScopeDigest(tracking)) as Witness|undefined??null;
  }
  private feedback(device:Device,row:Cursor,id:string|null,tracking:Tracking|null) {
    return {topologyVersion:this.store.coverage.topology(device.userId),coverageRefreshRequired:!tracking||!this.witness(device,row,id,tracking)};
  }

  private keys(device:Device,state:ActivityState,workingOnly=true):WorkKey[] {
    return state.contexts.filter(c=>!workingOnly||c.working===true).map(c=>({client:c.clientId,
      source:c.source?this.store.findSource(c.source.provider,subscriptionKey(c.source,device.userId)):null,accountBy:c.accountBy,route:c.route,
      origin:c.origin,project:c.project??'',folder:c.folder??'',startedAt:c.startedAt,
      identity:c.sessionId?{kind:'stable' as const,sessionId:c.sessionId}:{kind:'legacy' as const,ordinal:c.ordinal!}}));
  }
  private presence(device:Device,row:Cursor,latest:ActivityLatest,anchor:ClockAnchor|null,now:number):boolean {
    if(!anchor||anchor.clockEpoch!==latest.clockEpoch)return false;
    const at=anchor.anchorAt+(latest.tick-anchor.anchorTick);
    if(!Number.isSafeInteger(at)||at<row.floor_at||at<=Math.max(row.latest_at??0,now-KEEP_MS)||at>now+CLOCK_TOLERANCE_MS)return false;
    const sessions: (LiveSession&{source:string|null})[]=latest.state.contexts.map(c=>({clientId:c.clientId,sessionId:c.sessionId,
      source:c.source?this.store.findSource(c.source.provider,subscriptionKey(c.source,device.userId)):null,accountBy:c.accountBy,route:c.route,
      origin:c.origin,project:c.project,folder:c.folder,startedAt:Math.min(at,c.startedAt),sentStartedAt:c.startedAt,
      lastWorkedAt:c.lastWorkedAt,working:c.working===true,device:{id:device.id,name:device.label??device.name}}));
    this.store.db.prepare('UPDATE device_activity SET latest_at=? WHERE device_id=?').run(at,device.id);
    this.live.observed(device.id,device.userId,sessions,at);
    return true;
  }

  private batch(device:Device,row:Cursor,request:ActivityBatch,now:number) {
    let cursor=row.accepted_seq,state=row.checkpoint?JSON.parse(row.checkpoint) as ActivityState:null;
    let prefixAnchor=row.clock_anchor?JSON.parse(row.clock_anchor) as ClockAnchor:null,capture=row.capture_epoch,lastTick=row.last_tick,lastAt=row.last_at;
    if(request.skip&&request.skip.lastSeq>cursor){
      if(request.skip.firstSeq>cursor+1)throw new ActivityConflict('activity_sequence',{expectedSeq:cursor+1});
      cursor=request.skip.lastSeq;state=null;prefixAnchor=null;capture=null;lastTick=null;
    }
    const pending=request.frames.filter(f=>f.seq>cursor);
    if(pending.length&&pending[0].seq!==cursor+1)throw new ActivityConflict('activity_sequence',{expectedSeq:cursor+1});
    let supplied=request.checkpoint;
    for(const f of request.frames){if(f.seq>cursor)break;if(f.nextState)supplied=f.nextState;}
    if(pending.length){
      const first=pending[0],epochChanged=prefixAnchor?.clockEpoch!==request.clockAnchor!.clockEpoch;
      if(prefixAnchor&&!epochChanged&&JSON.stringify(prefixAnchor)!==JSON.stringify(request.clockAnchor))throw new Invalid('immutable clockAnchor');
      if(epochChanged){if(!supplied||capture===first.captureEpoch)throw new Invalid('clock continuity');state=supplied;lastTick=null;}
      else if(!state||capture!==first.captureEpoch&&supplied)state=supplied;
      else if(supplied&&activityStateDigest(supplied)!==activityStateDigest(state))throw new Invalid('checkpoint');
      if(!state)throw new Invalid('checkpoint');
    }
    const slices:{from:number;to:number;keys:WorkKey[]}[]=[];
    const prepared=new Map<ActivityState,{all:WorkKey[];working:WorkKey[];signature:string}>();
    const keysOfState=(value:ActivityState)=>{let found=prepared.get(value);if(!found){const all=this.keys(device,value,false),working=all.filter((_,i)=>value.contexts[i].working===true);found={all,working,signature:JSON.stringify(working)};prepared.set(value,found);}return found;};
    let previousSignature:string|null=null;
    const observations=new Map<string,WorkKey>();
    const observe=(value:ActivityState)=>{for(const key of keysOfState(value).all){
      const identity=JSON.stringify([key.client,key.source,key.origin,key.project,key.folder,key.startedAt,key.identity]);
      const before=observations.get(identity);observations.set(identity,before?{...key,...mergeEvidence(before,key)}:key);
    }};
    let coverage=false;
    const retainedFrom=now-config.retention.sampleDays*86_400_000;
    for(const f of pending){
      if(f.seq!==cursor+1)throw new ActivityConflict('activity_sequence',{expectedSeq:cursor+1});
      if(f.toAt>now+CLOCK_TOLERANCE_MS)throw new Invalid('future interval');
      if(activityStateDigest(state!)!==f.baseStateDigest)throw new Invalid('baseStateDigest');
      if(f===pending[0])observe(state!);
      if(capture===f.captureEpoch&&lastTick!==null&&f.fromTick!==lastTick)throw new Invalid('capture continuity');
      if(capture!==f.captureEpoch&&!supplied&&!f.nextState)throw new Invalid('capture checkpoint');
      const from=Math.max(f.fromAt,row.floor_at,retainedFrom,lastAt??0),to=f.toAt,preparedState=keysOfState(state!),keys=preparedState.working;
      if(to>from&&keys.length){
        const previous=slices.at(-1);
        if(previous?.to===from&&previousSignature===preparedState.signature)previous.to=to;
        else slices.push({from,to,keys});
        previousSignature=preparedState.signature;
      }
      const witness=this.witness(device,row,request.topologyWitnessId,state!.tracking);
      if(witness&&f.complete&&state!.tracking.complete&&state!.tracking.clients.length&&state!.contexts.every(c=>c.working!==null))
        coverage=this.store.coverage.recordCaptured(device.id,Math.max(from,witness.issued_at),to,witness.scope_digest,f.captureEpoch,witness.topology_version)||coverage;
      if(f.nextState)observe(f.nextState);
      state=f.nextState??state;cursor=f.seq;prefixAnchor=request.clockAnchor;capture=f.captureEpoch;lastTick=f.toTick;lastAt=Math.max(lastAt??0,f.toAt);
    }
    // Every call includes all concurrent keys; mixed stable/legacy floors cannot clip a parallel producer.
    this.store.creditWorkIntervals(device.id,slices,[...observations.values()]);
    if(pending.length||cursor!==row.accepted_seq)this.store.db.prepare('UPDATE device_activity SET accepted_seq=?,checkpoint=?,clock_anchor=?,capture_epoch=?,last_tick=?,last_at=? WHERE device_id=?')
      .run(cursor,state?JSON.stringify(state):null,prefixAnchor?JSON.stringify(prefixAnchor):null,capture,lastTick,lastAt,device.id);
    const releasedWitnesses=[...new Set(request.releaseWitnesses)];
    for(const id of releasedWitnesses)this.store.db.prepare('DELETE FROM device_activity_witnesses WHERE device_id=? AND queue_id=? AND authority_epoch=? AND witness_id=?').run(device.id,row.queue_id,row.authority_epoch,id);
    const presenceAccepted=request.latest?this.presence(device,row,request.latest,request.clockAnchor,now):false;
    const feedback=this.feedback(device,row,request.topologyWitnessId,request.latest?.state.tracking??state?.tracking??request.checkpoint?.tracking??null);
    return {version:1,queueId:row.queue_id,authorityEpoch:row.authority_epoch,acknowledgedThrough:cursor,acceptedFrames:pending.length,presenceAccepted,...feedback,releasedWitnesses,coverage};
  }
}
