import type {PeriodReader} from '../server/periodRead.js';
import type {ReadError} from '../server/historyRead.js';
import type {HistoryLimit} from '../server/history.js';

const stages=new Set(['input','preparation','work-access']);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
type Selection={mode:'live';periodMs:number}|{mode:'range';from:number;to:number}|null;
export type HistoryLimitReport={event:'history_limit';physicalAttemptBound:false;stage:NonNullable<ReadError['limitStage']>|null;limit:{requested:number;reserved:number;budget:number}|null;evaluatedAt:number|null;selection:Selection;quota:boolean;wallet:boolean;funds:boolean;sessions:boolean;sourceWork:boolean;calendar:boolean};
const fields=['event','physicalAttemptBound','stage','limit','evaluatedAt','selection','quota','wallet','funds','sessions','sourceWork','calendar'];
function selection(value:unknown):Selection {
  if(!object(value))return null;
  if(value.mode==='live'&&integer(value.periodMs)&&value.periodMs>0)return {mode:'live',periodMs:value.periodMs};
  if(value.mode==='range'&&integer(value.from)&&integer(value.to)&&value.from<value.to)return {mode:'range',from:value.from,to:value.to};
  return null;
}
function snapshot(value:unknown):HistoryLimitReport['limit'] {
  if(!object(value)||!integer(value.requested)||!integer(value.reserved)||!integer(value.budget)||value.requested<=0||value.budget<=0||value.requested+value.reserved<=value.budget)return null;
  return {requested:value.requested,reserved:value.reserved,budget:value.budget};
}

/** The proxy strips attempt headers. Numeric request matches remain inferred attribution. */
export function observeHistoryLimits(Reader:{prototype:Pick<PeriodReader,'readAsync'>},Errors:{ReadError:typeof ReadError;HistoryLimit:typeof HistoryLimit},emit:(report:HistoryLimitReport)=>void) {
  const original=Reader.prototype.readAsync;let count=0;
  Reader.prototype.readAsync=function(...args){
    const pending=original.apply(this,args);
    void pending.catch(error=>{
      try{
      if(count<4&&error instanceof Errors.ReadError&&error.statusCode===413&&error.code==='history_limit'){
        count++;
        const raw=object(args[2])?args[2]:{};
        emit({event:'history_limit',physicalAttemptBound:false,stage:stages.has(error.limitStage??'')?error.limitStage!:null,limit:snapshot(error.cause instanceof Errors.HistoryLimit?error.cause.snapshot:undefined),evaluatedAt:integer(raw.evaluatedAt)?raw.evaluatedAt:null,selection:selection(raw.selection),quota:!!raw.quota,wallet:!!raw.budget,funds:!!raw.funds,sessions:!!raw.sessions,sourceWork:!!raw.sourceWork,calendar:!!raw.calendar});
      }
      }catch{/* Diagnostics cannot replace the original refusal. */}
    });
    return pending;
  };
  return ()=>{Reader.prototype.readAsync=original;};
}

function report(value:unknown):value is HistoryLimitReport {
  if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||value.event!=='history_limit'||value.physicalAttemptBound!==false)return false;
  if(value.stage!==null&&!stages.has(value.stage as string)||value.evaluatedAt!==null&&!integer(value.evaluatedAt))return false;
  if(['quota','wallet','funds','sessions','sourceWork','calendar'].some(key=>typeof value[key]!=='boolean'))return false;
  if(value.limit!==null){
    const limit=value.limit;
    if(!object(limit)||Object.keys(limit).length!==3||Object.keys(limit).some(key=>!['requested','reserved','budget'].includes(key))||!integer(limit.requested)||!integer(limit.reserved)||!integer(limit.budget)||limit.requested<=0||limit.budget<=0||limit.requested+limit.reserved<=limit.budget)return false;
  }
  return value.selection===null||JSON.stringify(value.selection)===JSON.stringify(selection(value.selection));
}

/** Forward only complete, bounded reports from the owned synthetic backend. */
export class HistoryLimitOutput {
  private pending='';private skipping=false;private count=0;
  constructor(private readonly emit:(report:HistoryLimitReport)=>void){}
  add(chunk:Buffer){
    if(this.count>=4)return;
    const lines=chunk.toString().split('\n');
    for(let i=0;i<lines.length;i++){
      if(!this.skipping){this.pending+=lines[i];if(Buffer.byteLength(this.pending)>2048){this.pending='';this.skipping=true;}}
      if(i===lines.length-1)continue;
      if(!this.skipping){
        try{const value:unknown=JSON.parse(this.pending);if(report(value)){this.count++;try{this.emit(value);}catch{/* Keep the backend's failure authoritative. */}}}catch{/* Other backend output stays in its ordinary private ring. */}
      }
      this.pending='';this.skipping=false;if(this.count>=4)return;
    }
  }
}
