import {createHash} from 'node:crypto';
import {validClientId} from './clients.js';
import {Invalid, ORIGINS, longerThan, parseSender, sessionRoute, trackingOf, type AgentSender, type Origin, type SessionRoute, type Tracking} from './ingest.js';
import {providerOf, type ClientProvider} from './providers.js';
import type {AccountBy} from './sessionEvidence.js';

export const ACTIVITY_BODY_BYTES=512*1024;
export const ACTIVITY_FRAME_MS=200_000;
export type ActivityContext={contextId:string;clientId:string;sessionId:string|null;ordinal:number|null;
  source:{provider:ClientProvider;account:string|null;accountName:string|null}|null;accountBy:AccountBy|null;
  origin:Origin;project:string|null;folder:string|null;startedAt:number;route:SessionRoute|null;working:boolean|null;lastWorkedAt:number|null};
export type ActivityState={tracking:Tracking;contexts:ActivityContext[]};
export type ClockAnchor={clockEpoch:string;anchorTick:number;anchorAt:number};
export type ActivityFrame={seq:number;captureEpoch:string;clockEpoch:string;fromAt:number;toAt:number;fromTick:number;toTick:number;baseStateDigest:string;nextState:ActivityState|null;complete:boolean};
export type ActivityLatest={clockEpoch:string;tick:number;state:ActivityState};
type Envelope=AgentSender&{version:1;sentAt:number;queueId:string};
export type ActivityHello=Envelope&{op:'hello';openId:string;replaceAuthorityEpoch:string|null;clock:{clockEpoch:string;tick:number;wall:number};tracking:Tracking;knownWitnessId:string|null;latest:ActivityLatest|null;acknowledgedThrough:number};
export type ActivityBatch=Envelope&{op:'batch';authorityEpoch:string;clockAnchor:ClockAnchor|null;topologyWitnessId:string|null;checkpoint:ActivityState|null;frames:ActivityFrame[];
  skip:{firstSeq:number;lastSeq:number;fromAt:number|null;toAt:number|null;reason:string}|null;latest:ActivityLatest|null;releaseWitnesses:string[]};
export type ActivityPresence=Envelope&{op:'presence';authorityEpoch:string;clockAnchor:ClockAnchor;topologyWitnessId:string|null;latest:ActivityLatest};
export type ActivityRequest=ActivityHello|ActivityBatch|ActivityPresence;

export class ActivityConflict extends Error {
  constructor(readonly code:'activity_sequence'|'activity_stream_replaced'|'activity_binding',readonly extra:Record<string,string|number>={}) {super(code);}
}

type Obj=Record<string,unknown>;
export function activityObject(value:unknown,field:string):Obj {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Invalid(field);
  return value as Obj;
}
export function activityInteger(value:unknown,field:string,min=0):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)throw new Invalid(field);
  return value;
}
function id(value:unknown,field:string):string {
  if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw new Invalid(field);
  return value;
}
function nullableId(value:unknown,field:string):string|null {return value==null?null:id(value,field);}
function name(value:unknown,field:string):string|null {
  if(value==null)return null;
  if(typeof value!=='string'||!value.length||longerThan(value,120))throw new Invalid(field);
  return value;
}
function tracking(value:unknown):Tracking {
  const parsed=trackingOf(value);if(!parsed)throw new Invalid('tracking');return parsed;
}
function context(value:unknown):ActivityContext {
  const v=activityObject(value,'context');
  if(!validClientId(v.clientId)||!ORIGINS.includes(v.origin as Origin))throw new Invalid('context');
  if(v.working!==true&&v.working!==false&&v.working!==null)throw new Invalid('working');
  const sessionId=nullableId(v.sessionId,'sessionId');
  const ordinal=sessionId===null?activityInteger(v.ordinal,'ordinal'):null;
  const accountBy=v.accountBy??null;
  if(accountBy!==null&&accountBy!=='login'&&accountBy!=='inferred'&&accountBy!=='legacy')throw new Invalid('accountBy');
  let source:ActivityContext['source']=null;
  if(v.source!=null){
    const s=activityObject(v.source,'source');
    if(!providerOf(String(s.provider)))throw new Invalid('source provider');
    // Hub-measured accounts cannot supply agent activity, even with malformed metadata.
    if(providerOf(String(s.provider))!.measuredBy==='client'){
      const account=name(s.account,'account'),accountName=name(s.accountName,'accountName');
      if(account!==null&&!/^[a-f0-9]{24}$/.test(account))throw new Invalid('account');
      source={provider:s.provider as ClientProvider,account,accountName};
    }
  }
  const route=sessionRoute(v.route);
  if(v.route!=null&&route===null)throw new Invalid('route');
  const startedAt=activityInteger(v.startedAt,'startedAt');
  const lastWorkedAt=v.lastWorkedAt==null?null:activityInteger(v.lastWorkedAt,'lastWorkedAt');
  if(lastWorkedAt!==null&&lastWorkedAt<startedAt)throw new Invalid('lastWorkedAt');
  return {contextId:id(v.contextId,'contextId'),clientId:v.clientId,sessionId,ordinal,source,accountBy,origin:v.origin as Origin,
    project:name(v.project,'project'),folder:name(v.folder,'folder'),startedAt,route,working:v.working,lastWorkedAt};
}
export function parseActivityState(value:unknown):ActivityState {
  const v=activityObject(value,'state'),scope=tracking(v.tracking);
  if(!Array.isArray(v.contexts)||v.contexts.length>200)throw new Invalid('contexts');
  const contexts=v.contexts.map(context),ids=new Set<string>(),producers=new Set<string>();
  for(const c of contexts){
    if(ids.has(c.contextId)||c.sessionId!==null&&producers.has(c.sessionId))throw new Invalid('context identity');
    ids.add(c.contextId);if(c.sessionId!==null)producers.add(c.sessionId);
    if(!scope.clients.includes(c.clientId))throw new Invalid('context scope');
    if(scope.routeDisabled.includes(c.clientId)&&c.route!==null)throw new Invalid('route scope');
  }
  contexts.sort((a,b)=>a.contextId<b.contextId?-1:a.contextId>b.contextId?1:0);
  return {tracking:scope,contexts};
}
export const activityScopeDigest=(scope:Tracking)=>createHash('sha256').update(JSON.stringify([scope.clients,scope.routeDisabled])).digest('hex');
/** Tuple order and explicit nulls are shared with the agent; object key order is irrelevant. */
export function activityStateDigest(state:ActivityState):string {
  return createHash('sha256').update(JSON.stringify([state.tracking.clients,state.tracking.routeDisabled,state.tracking.complete,
    state.contexts.map(c=>[c.contextId,c.clientId,c.sessionId,c.ordinal,c.source?[c.source.provider,c.source.account,c.source.accountName]:null,c.accountBy,
      c.origin,c.project,c.folder,c.startedAt,c.route?[c.route.class,c.route.by,c.route.host,c.route.provider]:null,c.working,c.lastWorkedAt])])).digest('hex');
}
function anchor(value:unknown):ClockAnchor {
  const v=activityObject(value,'clockAnchor');return {clockEpoch:id(v.clockEpoch,'clockEpoch'),anchorTick:activityInteger(v.anchorTick,'anchorTick'),anchorAt:activityInteger(v.anchorAt,'anchorAt')};
}
function latest(value:unknown):ActivityLatest {
  const v=activityObject(value,'latest');return {clockEpoch:id(v.clockEpoch,'clockEpoch'),tick:activityInteger(v.tick,'tick'),state:parseActivityState(v.state)};
}
function frame(value:unknown):ActivityFrame {
  const v=activityObject(value,'frame');
  if(typeof v.baseStateDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.baseStateDigest)||typeof v.complete!=='boolean')throw new Invalid('frame');
  const result:ActivityFrame={seq:activityInteger(v.seq,'seq',1),captureEpoch:id(v.captureEpoch,'captureEpoch'),clockEpoch:id(v.clockEpoch,'clockEpoch'),
    fromAt:activityInteger(v.fromAt,'fromAt'),toAt:activityInteger(v.toAt,'toAt'),fromTick:activityInteger(v.fromTick,'fromTick'),toTick:activityInteger(v.toTick,'toTick'),
    baseStateDigest:v.baseStateDigest,nextState:v.nextState==null?null:parseActivityState(v.nextState),complete:v.complete};
  const duration=result.toTick-result.fromTick;
  if(duration<0||duration>ACTIVITY_FRAME_MS||result.toAt-result.fromAt!==duration)throw new Invalid('frame duration');
  return result;
}
export function parseActivity(body:unknown):ActivityRequest {
  const sender=parseSender(body),v=activityObject(body,'body');
  if(Buffer.byteLength(JSON.stringify(body))>ACTIVITY_BODY_BYTES)throw new Invalid('activity size');
  const envelope={...sender,version:1 as const,sentAt:activityInteger(v.sentAt,'sentAt'),queueId:id(v.queueId,'queueId')};
  if(v.op==='hello'){
    const clock=activityObject(v.clock,'clock');
    return {...envelope,op:'hello',openId:id(v.openId,'openId'),replaceAuthorityEpoch:nullableId(v.replaceAuthorityEpoch,'replaceAuthorityEpoch'),
      clock:{clockEpoch:id(clock.clockEpoch,'clockEpoch'),tick:activityInteger(clock.tick,'tick'),wall:activityInteger(clock.wall,'wall')},tracking:tracking(v.tracking),
      knownWitnessId:nullableId(v.knownWitnessId,'knownWitnessId'),latest:v.latest==null?null:latest(v.latest),acknowledgedThrough:activityInteger(v.acknowledgedThrough,'acknowledgedThrough')};
  }
  const authorityEpoch=id(v.authorityEpoch,'authorityEpoch'),topologyWitnessId=nullableId(v.topologyWitnessId,'topologyWitnessId');
  if(v.op==='presence')return {...envelope,op:'presence',authorityEpoch,topologyWitnessId,clockAnchor:anchor(v.clockAnchor),latest:latest(v.latest)};
  if(v.op!=='batch'||!Array.isArray(v.frames)||v.frames.length>64)throw new Invalid('activity operation');
  const release=v.releaseWitnesses??[];
  if(!Array.isArray(release)||release.length>64)throw new Invalid('releaseWitnesses');
  let skip:ActivityBatch['skip']=null;
  if(v.skip!=null){
    const s=activityObject(v.skip,'skip');
    if(!['overflow','age','corruption','clock','privacy','recovery'].includes(String(s.reason)))throw new Invalid('skip reason');
    skip={firstSeq:activityInteger(s.firstSeq,'firstSeq',1),lastSeq:activityInteger(s.lastSeq,'lastSeq',1),fromAt:s.fromAt==null?null:activityInteger(s.fromAt,'skip fromAt'),toAt:s.toAt==null?null:activityInteger(s.toAt,'skip toAt'),reason:String(s.reason)};
    if(skip.lastSeq<skip.firstSeq||skip.fromAt!==null&&skip.toAt!==null&&skip.toAt<skip.fromAt)throw new Invalid('skip');
  }
  const frames=v.frames.map(frame),clockAnchor=v.clockAnchor==null?null:anchor(v.clockAnchor);
  if(frames.length&&!clockAnchor)throw new Invalid('clockAnchor');
  for(let i=0;i<frames.length;i++){
    const f=frames[i],a=clockAnchor!;
    if(f.clockEpoch!==a.clockEpoch||f.fromAt!==a.anchorAt+(f.fromTick-a.anchorTick)||f.toAt!==a.anchorAt+(f.toTick-a.anchorTick))throw new Invalid('clock projection');
    if(i&&f.seq!==frames[i-1].seq+1)throw new Invalid('frame sequence');
  }
  return {...envelope,op:'batch',authorityEpoch,topologyWitnessId,clockAnchor,frames,skip,checkpoint:v.checkpoint==null?null:parseActivityState(v.checkpoint),
    latest:v.latest==null?null:latest(v.latest),releaseWitnesses:release.map(value=>id(value,'releaseWitnesses'))};
}
