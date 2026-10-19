import {defaultFilters,encodeDataFilters,executableWorkFilters,workFilterBytes,FILTER_BODY_LIMIT,FILTER_FAMILIES,filterRefKey,fundsRule,jsonBytes,parseDataFilters,parseFilterUpdate,sameFilters,walletRule,
  type DataFilters,type FamilyRef,type FilterDecision,type FilterEnvelope,type FilterFamily,type FilterUpdate} from '../../server/domain/dataFilters';
import {rebaseFilterProjection,resetFilter,setSelection,setWallet} from '../../server/domain/dataFilterMerge';
import {ApiError} from './http';

type Intent<T>={value:T;seq:number};
type Entry={current:DataFilters|null;saved:FilterEnvelope|null;savedOnly:boolean;conflicts:number;revisionFloor:number;originRevision:number;originProjection:DataFilters|null;originSequence:number;seq:number;resets:Partial<Record<FilterFamily,Intent<'all'|'none'>>>;
  decisions:Map<string,Intent<FilterDecision>>;materialize:Partial<Record<'wallet'|'funds',Intent<string>>>;saving:boolean;error:unknown;generation:number};
export type FilterState={current:DataFilters|null;saved:FilterEnvelope|null;dirty:boolean;saving:boolean;error:unknown;generation:number;conflicts:number};
type Env={save(board:string,revision:number,update:FilterUpdate):Promise<FilterEnvelope>;refresh?(board:string):Promise<FilterEnvelope>;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;conflicts?:(filters:DataFilters)=>number;seed?:(filters:DataFilters)=>DataFilters};
const fresh=(savedOnly:boolean):Entry=>({current:null,saved:null,savedOnly,conflicts:0,revisionFloor:0,originRevision:0,originProjection:null,originSequence:0,seq:0,resets:{},decisions:new Map(),materialize:{},saving:false,error:null,generation:0});
const pendingIntents=(e:Entry)=>Object.keys(e.resets).length>0||e.decisions.size>0||Object.keys(e.materialize).length>0;
const dirty=(e:Entry)=>!!e.current&&!!e.saved&&(!sameFilters(e.current,e.saved.filters)||pendingIntents(e));

/** One tab's view; persisted opening defaults never autosave its draft. */
export class DataFilterState {
  private readonly entries=new Map<string,Entry>();
  private readonly listeners=new Set<()=>void>();
  private key='';private board='';private savedOnly=false;
  private state:FilterState={current:null,saved:null,dirty:false,saving:false,error:null,generation:0,conflicts:0};
  constructor(private readonly env:Env){}
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private entry(){return this.entries.get(this.key);}
  private publish(){const e=this.entry();this.state=e?{current:e.current,saved:e.saved,dirty:dirty(e),saving:e.saving,error:e.error,generation:e.generation,conflicts:e.conflicts}:{current:null,saved:null,dirty:false,saving:false,error:null,generation:0,conflicts:0};for(const listener of this.listeners)listener();}
  open(user:string,board:string,savedOnly=false){
    const key=JSON.stringify([user,board,...(savedOnly?['saved']:[])]);if(this.key===key&&this.savedOnly===savedOnly)return;
    this.key=key;this.board=board;this.savedOnly=savedOnly;
    if(!this.entries.has(key))this.entries.set(key,fresh(savedOnly));this.publish();
  }
  close(){this.key='';this.board='';this.publish();}
  private persist(entry:Entry,key=this.key){
    if(entry.savedOnly)return;
    try{if(!dirty(entry))this.env.storage?.removeItem('quotum.filters.'+key);
      else this.env.storage?.setItem('quotum.filters.'+key,JSON.stringify({current:entry.current,originRevision:entry.originRevision,originProjection:entry.originProjection,originSequence:entry.originSequence,resets:entry.resets,decisions:[...entry.decisions],materialize:entry.materialize,seq:entry.seq,conflicts:entry.conflicts}));}catch{/* Storage is optional; current intent remains in this tab. */}
  }
  accept(envelope:FilterEnvelope){
    const e=this.entry(),parsed=parseDataFilters(envelope.filters);if(!e||!parsed||!Number.isSafeInteger(envelope.revision)||envelope.revision<0||typeof envelope.authority!=='string')return;
    if(envelope.revision<e.revisionFloor)return;
    e.revisionFloor=envelope.revision;
    if(e.saved?.revision===envelope.revision&&e.saved.authority===envelope.authority&&sameFilters(e.saved.filters,parsed))return;
    const before=e.saved;e.saved={...envelope,filters:parsed};
    if(!e.current){
      e.current=!this.savedOnly&&envelope.revision===0?this.env.seed?.(parsed)??parsed:parsed;e.originRevision=envelope.revision;e.originProjection=parsed;e.conflicts=!this.savedOnly&&envelope.revision===0?this.env.conflicts?.(parsed)??0:0;
      if(!executableWorkFilters(e.current)||!parseDataFilters(e.current))e.error=new ApiError(413,'filters_limit');
      try{const raw=!this.savedOnly&&this.env.storage?.getItem('quotum.filters.'+this.key),draft=raw?JSON.parse(raw):null,filters=draft&&parseDataFilters(draft.current);
        if(filters&&Number.isSafeInteger(draft.originRevision)&&draft.originRevision>=0&&Number.isSafeInteger(draft.seq)&&draft.seq>=0){
          const originProjection=draft.originProjection===undefined?parsed:parseDataFilters(draft.originProjection);
          const candidate={...e,current:filters,originRevision:draft.originRevision,originProjection,originSequence:Number.isSafeInteger(draft.originSequence)&&draft.originSequence>=0&&draft.originSequence<=draft.seq?draft.originSequence:0,resets:draft.resets??{},decisions:new Map(draft.decisions??[]),materialize:draft.materialize??{},seq:draft.seq,conflicts:Number.isSafeInteger(draft.conflicts)?draft.conflicts:0} as Entry;
          const intents=this.intents(candidate);
          if(originProjection&&parseFilterUpdate({filters,authority:envelope.authority,replace:[...FILTER_FAMILIES],...intents})&&[...Object.values(candidate.resets),...candidate.decisions.values(),...Object.values(candidate.materialize)].every(intent=>intent&&Number.isSafeInteger(intent.seq)&&intent.seq>=0&&intent.seq<=candidate.seq)){
            Object.assign(e,candidate);
            if(e.originRevision===envelope.revision){e.current=rebaseFilterProjection(e.current!,e.originProjection!,parsed,intents);e.originProjection=parsed;}
          }
        }}catch{/* A malformed tab draft cannot replace a saved selection. */}
    }else if(this.savedOnly){e.current=parsed;e.originRevision=envelope.revision;e.originProjection=parsed;}
    else if(before&&before.revision===envelope.revision&&e.originRevision===envelope.revision){e.current=rebaseFilterProjection(e.current,e.originProjection??before.filters,parsed,this.intents(e));e.originProjection=parsed;}
    if(e.current&&!executableWorkFilters(e.current))e.error=new ApiError(413,'filters_limit');
    else if(e.error instanceof ApiError&&e.error.code==='filters_limit')e.error=null;
    e.generation++;this.persist(e);this.publish();
  }
  private intents(e:Entry){return {resets:Object.fromEntries(Object.entries(e.resets).map(([key,intent])=>[key,intent!.value])),decisions:[...e.decisions.values()].map(intent=>intent.value),materialize:Object.fromEntries(Object.entries(e.materialize).map(([key,intent])=>[key,intent!.value]))};}
  private update(e:Entry,current:DataFilters){
    const parsed=parseDataFilters(current),fits=parsed&&executableWorkFilters(parsed);
    const before=e.current&&workFilterBytes(e.current),after=parsed&&workFilterBytes(parsed);
    const recovering=before&&after&&!executableWorkFilters(e.current!)&&after.every((bytes,i)=>bytes<=before[i])&&after.some((bytes,i)=>bytes<before[i]);
    if(!parsed||!fits&&!recovering){e.error=new ApiError(413,'filters_limit');this.publish();return false;}
    const envelope={filters:parsed,authority:e.saved?.authority??'a'.repeat(43),replace:[...FILTER_FAMILIES],...this.intents(e)};
    if(jsonBytes(envelope)>FILTER_BODY_LIMIT){e.error=new ApiError(413,'filters_limit');this.publish();return false;}
    e.current=parsed;e.generation++;e.error=fits?null:new ApiError(413,'filters_limit');this.persist(e);this.publish();return true;
  }
  toggle(family:FilterFamily,ref:FamilyRef,included:boolean,unit?:string,automatic=false){
    const e=this.entry();if(!e?.current||!e.saved)return;
    const previous={resets:{...e.resets},decisions:new Map(e.decisions),materialize:{...e.materialize}},current=structuredClone(e.current);const seq=++e.seq;
    if((family==='wallet'||family==='funds')&&current.legacy&&(family==='wallet'?current.legacy.walletByUnit:current.legacy.fundsByUnit||current.legacy.fundsPreferredByUnit)){
      if(!unit)return;
      e.materialize[family]={value:unit,seq};
      if(family==='wallet'){current.wallet=walletRule(current,unit);delete current.legacy.walletByUnit;}
      else{current.funds=fundsRule(current,unit);delete current.legacy.fundsByUnit;delete current.legacy.fundsPreferredByUnit;}
      if(!Object.keys(current.legacy).length)delete current.legacy;
    }
    if(family==='wallet')current.wallet=setWallet(current.wallet,ref as Parameters<typeof setWallet>[1],included,automatic);
    else current[family]=setSelection(current[family] as Parameters<typeof setSelection>[0],ref,included) as never;
    const decision={family,ref,included} as FilterDecision;e.decisions.set(family+':'+filterRefKey(ref),{value:decision,seq});
    if(!this.update(e,current)){e.resets=previous.resets;e.decisions=previous.decisions;e.materialize=previous.materialize;}
  }
  reset(family:FilterFamily|readonly FilterFamily[],mode:'all'|'none'){
    const e=this.entry();if(!e?.current)return;
    const previous={resets:{...e.resets},decisions:new Map(e.decisions),materialize:{...e.materialize}};
    let current=e.current;
    for(const part of typeof family==='string'?[family]:family){
      e.resets[part]={value:mode,seq:++e.seq};delete e.materialize[part as 'wallet'|'funds'];for(const [key,intent] of e.decisions)if(intent.value.family===part)e.decisions.delete(key);
      current=resetFilter(current,part,mode);
    }
    if(!this.update(e,current)){e.resets=previous.resets;e.decisions=previous.decisions;e.materialize=previous.materialize;}
  }
  restore(){const e=this.entry();if(!e?.saved)return;e.originSequence=++e.seq;e.conflicts=0;e.resets={};e.decisions.clear();e.materialize={};e.originRevision=e.saved.revision;e.originProjection=e.saved.filters;e.current=e.saved.filters;e.generation++;e.error=executableWorkFilters(e.current)?null:new ApiError(413,'filters_limit');this.persist(e);this.publish();}
  async save(){
    const e=this.entry();if(!e?.current||!e.saved||e.saving||e.saved.revision<e.revisionFloor)return;
    if(!parseDataFilters(e.current)||!executableWorkFilters(e.current)){e.error=new ApiError(413,'filters_limit');this.publish();return;}
    const key=this.key,board=this.board,seq=e.seq,basis=e.saved,authority=basis.authority;
    const filters=e.current,intents=this.intents(e),replace=FILTER_FAMILIES.filter(family=>JSON.stringify(filters[family])!==JSON.stringify(e.saved!.filters[family])||
      (family==='wallet'||family==='funds')&&JSON.stringify(filters.legacy)!==JSON.stringify(e.saved!.filters.legacy)||!!intents.resets[family]||intents.decisions.some(d=>d.family===family)||!!intents.materialize[family as 'wallet'|'funds']);
    const update:FilterUpdate={filters,authority,replace,...intents};if(!parseFilterUpdate(update)){e.error=new ApiError(413,'filters_limit');this.publish();return;}e.saving=true;e.error=null;this.publish();
    try{
      const reply=await this.env.save(board,e.saved.revision,update);
      if(reply.revision<e.revisionFloor)return;
      e.revisionFloor=reply.revision;
      if(e.saved!==basis&&e.saved?.authority!==reply.authority){
        e.error=new ApiError(409,'filters_context_changed');
        if(this.env.refresh){const latest=await this.env.refresh(board);if(this.key===key)this.accept(latest);}
        return;
      }
      e.saved=reply;if(e.originSequence<=seq){e.originRevision=reply.revision;e.originProjection=reply.filters;}
      for(const family of FILTER_FAMILIES)if(e.resets[family]&&e.resets[family]!.seq<=seq)delete e.resets[family];
      for(const [name,intent] of e.decisions)if(intent.seq<=seq)e.decisions.delete(name);
      for(const family of ['wallet','funds'] as const)if(e.materialize[family]&&e.materialize[family]!.seq<=seq)delete e.materialize[family];
      // A newer edit in flight keeps its own current value and remaining intents.
      if(e.seq===seq)e.current=reply.filters;
      this.persist(e,key);
    }catch(error){
      const data=(error as {data?:FilterEnvelope}).data;
      if(data?.filters&&this.key===key)this.accept(data);
      e.error=error;
    }finally{e.saving=false;if(this.key===key)this.publish();}
  }
}

/** A stable identity lets selectors subscribe without importing the board store. */
export const filterSelectionKey=(filters:DataFilters|null)=>filters?encodeDataFilters(filters):'';
export {defaultFilters};
