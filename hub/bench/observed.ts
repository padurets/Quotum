import {randomUUID} from 'node:crypto';
import {Agent,type Person} from '../demo/client.js';
import {accountOf,type Card} from '../demo/model.js';
import {activityStateDigest,type ActivityState} from '../server/domain/activity.js';
import type {ClientProvider} from '../server/domain/providers.js';

const opaque=()=>randomUUID().replaceAll('-','');

/** A separate device keeps the released benchmark writer and its history independent. */
export class ObservedWork {
  private sequence=1;
  private tick=0;
  private constructor(private readonly owner:Person,private readonly credential:{id:string;secret:string},
    private readonly sender:object,private readonly queueId:string,private readonly authorityEpoch:string,
    private readonly clockEpoch:string,private readonly captureEpoch:string,private readonly witness:string,
    readonly floorAt:number,private state:ActivityState) {}

  private async post(body:object) {
    const response=await fetch(this.owner.base+'/v1/activity',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+this.credential.secret},
      body:JSON.stringify({...this.sender,version:1,sentAt:Date.now(),queueId:this.queueId,...body})});
    if(!response.ok)throw new Error(`Observed work fixture: HTTP ${response.status}`);
    return await response.json() as {acknowledgedThrough:number};
  }

  static async open(owner:Person,card:Card) {
    const credential=await owner.post<{id:string;secret:string}>('/api/tokens',{name:'Observed work benchmark'});
    const sender={agent:Agent.VERSION,machine:{id:opaque(),name:'Interval benchmark',os:'linux',arch:'x86_64'}};
    const queueId=opaque(),clockEpoch=opaque(),captureEpoch=opaque(),tracking={version:1 as const,clients:[card.provider],routeDisabled:[],complete:true};
    const response=await fetch(owner.base+'/v1/activity',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential.secret},
      body:JSON.stringify({...sender,version:1,op:'hello',sentAt:Date.now(),queueId,openId:opaque(),acknowledgedThrough:0,clock:{clockEpoch,tick:0,wall:Date.now()},tracking})});
    if(!response.ok)throw new Error(`Observed work hello: HTTP ${response.status}`);
    const opened=await response.json() as {authorityEpoch:string;floorAt:number;topologyWitness:{id:string}};
    const account=accountOf(card);
    const state:ActivityState={tracking,contexts:[{contextId:opaque(),clientId:card.provider,sessionId:opaque(),ordinal:null,
      source:{provider:card.provider as ClientProvider,account:account.account??null,accountName:account.accountName??null},accountBy:'legacy',
      origin:'terminal',project:'Observed benchmark',folder:null,startedAt:opened.floorAt,route:null,working:true,lastWorkedAt:null}]};
    const actor=new ObservedWork(owner,credential,sender,queueId,opened.authorityEpoch,clockEpoch,captureEpoch,opened.topologyWitness.id,opened.floorAt,state);
    // A state-only checkpoint creates neither work nor current working presence.
    await actor.send(0,null,false);
    return actor;
  }

  private async send(to:number,next:ActivityState|null,complete:boolean) {
    const reply=await this.post({op:'batch',authorityEpoch:this.authorityEpoch,clockAnchor:{clockEpoch:this.clockEpoch,anchorTick:0,anchorAt:this.floorAt},
      topologyWitnessId:this.witness,checkpoint:this.state,frames:[{seq:this.sequence,captureEpoch:this.captureEpoch,clockEpoch:this.clockEpoch,
        fromTick:this.tick,toTick:to,fromAt:this.floorAt+this.tick,toAt:this.floorAt+to,baseStateDigest:activityStateDigest(this.state),nextState:next,complete}],
      ...(complete?{latest:{clockEpoch:this.clockEpoch,tick:to,state:next??this.state}}:{})});
    if(reply.acknowledgedThrough!==this.sequence)throw new Error('Observed work acknowledgement did not advance');
    this.sequence++;this.tick=to;this.state=next??this.state;
    return this.floorAt+to;
  }

  async report(working=true) {
    return this.through(Date.now(),working);
  }

  /** Deliver a captured interval later, without moving its observed endpoints. */
  async through(at:number,working=true) {
    const to=at-this.floorAt;
    const next=working?null:{...this.state,contexts:this.state.contexts.map(c=>({...c,working:false}))};
    return this.send(to,next,true);
  }

  async close() {
    const response=await fetch(this.owner.base+'/api/tokens/'+this.credential.id,{method:'DELETE',headers:{cookie:this.owner.cookie,origin:new URL(process.env.QUOTUM_PUBLIC_URL??this.owner.base).origin}});
    if(!response.ok)throw new Error(`Observed work cleanup: HTTP ${response.status}`);
  }
}
