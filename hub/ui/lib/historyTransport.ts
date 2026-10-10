import {MAX_READ_TILES, tileOf, type HistoryBasis, type HistoryReply, type HistoryScope} from '../../server/domain/history';
import type {MeterSelection} from '../../server/domain/meterHistory';
import {call} from './http';

export type HistoryRead = {board:string;scope:HistoryScope;cell:number;from:number;to:number;meters?:MeterSelection;meta?:HistoryBasis};
type Pending = {read:HistoryRead;signal?:AbortSignal;resolve:(reply:HistoryReply)=>void;reject:(error:unknown)=>void;cancelled:boolean};
type Transport = {single(read:HistoryRead,signal?:AbortSignal):Promise<HistoryReply>;pair(board:string,reads:HistoryRead[],signal:AbortSignal):Promise<{parts:{scope:HistoryScope;reply:HistoryReply}[]}>};
const bodyOf=(read:HistoryRead)=>({scope:read.scope,cell:read.cell,from:read.from,to:read.to,meta:read.meta?.meta??'',...(read.meters?{unit:read.meters.unit,meters:read.meters.ids,...(read.meters.displayCurrency?{currency:read.meters.displayCurrency}:{}),...(read.meters.work?{work:1}:{})}:{})});
const httpTransport:Transport={
  single:(read,signal)=>{
    const query=new URLSearchParams({board:read.board});for(const [key,value] of Object.entries(bodyOf(read)))query.set(key,typeof value==='string'?value:JSON.stringify(value));
    return call('GET','/api/history?'+query,undefined,12_000,signal);
  },
  pair:(board,reads,signal)=>call('POST','/api/history',{board,reads:reads.map(bodyOf)},12_000,signal),
};

/** Only tails caused by the same work event can share the two-part transport. */
export class WorkHistoryTransport {
  private readonly pending=new Map<string,Pending[]>();
  constructor(private readonly transport:Transport=httpTransport) {}
  read(read:HistoryRead,signal?:AbortSignal,burst?:number):Promise<HistoryReply> {
    if(!burst||read.scope==='budget'&&!read.meters?.work)return this.transport.single(read,signal);
    return new Promise((resolve,reject)=>{
      const key=JSON.stringify([read.board,burst]),value:Pending={read,signal,resolve,reject,cancelled:signal?.aborted??false};
      signal?.addEventListener('abort',()=>{value.cancelled=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
      let pending=this.pending.get(key);if(!pending){pending=[];this.pending.set(key,pending);queueMicrotask(()=>this.flush(key));}pending.push(value);
    });
  }
  private flush(key:string) {
    const pending=this.pending.get(key)!.filter(value=>!value.cancelled);this.pending.delete(key);
    const tiles=pending.reduce((sum,{read})=>sum+tileOf(read.to-1,read.cell)-tileOf(read.from,read.cell)+1,0);
    if(pending.length!==2||new Set(pending.map(value=>value.read.scope)).size!==2||tiles>MAX_READ_TILES){
      for(const value of pending)this.transport.single(value.read,value.signal).then(value.resolve,value.reject);return;
    }
    const abort=new AbortController(),cancel=()=>{if(pending.every(value=>value.cancelled))abort.abort();};
    for(const value of pending)value.signal?.addEventListener('abort',cancel,{once:true});
    this.transport.pair(pending[0].read.board,pending.map(value=>value.read),abort.signal).then(reply=>{
      for(const value of pending)if(!value.cancelled){const part=reply.parts.find(part=>part.scope===value.read.scope);if(part)value.resolve(part.reply);else value.reject(new Error('history part missing'));}
    },error=>{for(const value of pending)if(!value.cancelled)value.reject(error);}).finally(()=>{for(const value of pending)value.signal?.removeEventListener('abort',cancel);});
  }
}
export const workHistoryTransport=new WorkHistoryTransport();
