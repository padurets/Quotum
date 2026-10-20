import {defaultFilters,encodeDataFilters,executableWorkFilters,workFilterBytes,FILTER_BODY_LIMIT,FILTER_FAMILIES,filterRefKey,fundsRule,jsonBytes,parseDataFilters,parseFilterUpdate,sameFilters,walletRule,
  type DataFilters,type FamilyRef,type FilterDecision,type FilterEnvelope,type FilterFamily,type FilterUpdate} from '../../server/domain/dataFilters';
import {rebaseFilterProjection,resetFilter,setSelection,setWallet} from '../../server/domain/dataFilterMerge';
import {ApiError} from './http';

type Intent<T>={value:T;seq:number};
type Migrated=Partial<Record<'wallet'|'funds',true>>;
type Entry={current:DataFilters|null;saved:FilterEnvelope|null;savedOnly:boolean;migrated:Migrated;conflicts:number;revisionFloor:number;originRevision:number;originProjection:DataFilters|null;originSequence:number;seq:number;resets:Partial<Record<FilterFamily,Intent<'all'|'none'>>>;
  decisions:Map<string,Intent<FilterDecision>>;materialize:Partial<Record<'wallet'|'funds',Intent<string>>>;saving:boolean;error:unknown;generation:number};
export type FilterState={current:DataFilters|null;saved:FilterEnvelope|null;dirty:boolean;saving:boolean;error:unknown;generation:number;conflicts:number};
type Env={save(board:string,revision:number,update:FilterUpdate):Promise<FilterEnvelope>;refresh?(board:string):Promise<FilterEnvelope>;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;migrationStorage?:Pick<Storage,'getItem'|'setItem'>;conflicts?:(filters:DataFilters)=>number;seed?:(filters:DataFilters)=>DataFilters};
const fresh=(savedOnly:boolean):Entry=>({current:null,saved:null,savedOnly,migrated:{},conflicts:0,revisionFloor:0,originRevision:0,originProjection:null,originSequence:0,seq:0,resets:{},decisions:new Map(),materialize:{},saving:false,error:null,generation:0});
const pendingIntents=(e:Entry)=>Object.keys(e.resets).length>0||e.decisions.size>0||Object.keys(e.materialize).length>0;
const dirty=(e:Entry)=>!!e.current&&!!e.saved&&(!sameFilters(e.current,e.saved.filters)||pendingIntents(e));
const readableEnvelope=(value:FilterEnvelope|null|undefined):value is FilterEnvelope=>!!value&&Number.isSafeInteger(value.revision)&&value.revision>=0&&typeof value.authority==='string'&&!!parseDataFilters(value.filters);

/** One tab's view; persisted opening defaults never autosave its draft. */
export class DataFilterState {
  private readonly entries=new Map<string,Entry>();
  private readonly listeners=new Set<()=>void>();
  private key='';private board='';private user='';private savedOnly=false;
  private state:FilterState={current:null,saved:null,dirty:false,saving:false,error:null,generation:0,conflicts:0};
  constructor(private readonly env:Env){}
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private entry(){return this.entries.get(this.key);}
  private publish(){const e=this.entry();this.state=e?{current:e.current,saved:e.saved,dirty:dirty(e),saving:e.saving,error:e.error,generation:e.generation,conflicts:e.conflicts}:{current:null,saved:null,dirty:false,saving:false,error:null,generation:0,conflicts:0};for(const listener of this.listeners)listener();}
  open(user:string,board:string,savedOnly=false){
    if(this.user&&this.user!==user)this.retire();this.user=user;
    const key=JSON.stringify([user,board,...(savedOnly?['saved']:[])]);if(this.key===key&&this.savedOnly===savedOnly)return;
    this.key=key;this.board=board;this.savedOnly=savedOnly;
    if(!this.entries.has(key))this.entries.set(key,fresh(savedOnly));this.publish();
  }
  close(){this.key='';this.board='';this.publish();}
  retire(){this.entries.clear();this.user='';this.close();}
  private owns(e:Entry,key:string){return this.entries.get(key)===e;}
  private canPublish(e:Entry,key:string,basis:FilterEnvelope,reply:FilterEnvelope){
    return readableEnvelope(reply)&&this.owns(e,key)&&reply.revision>=e.revisionFloor&&(e.saved===basis||e.saved?.authority===reply.authority);
  }
  private async refreshAccepted(e:Entry,key:string,board:string){
    const basis=e.saved;if(!basis||!this.env.refresh||this.key!==key||!this.owns(e,key))return;
    try{const reply=await this.env.refresh(board);if(this.key===key&&this.canPublish(e,key,basis,reply))this.accept(reply);}
    catch{/* The save error remains visible; a failed read cannot replace its accepted basis. */}
  }
  private persist(entry:Entry,key=this.key){
    if(entry.savedOnly)return;
    try{if(!dirty(entry))this.env.storage?.removeItem('quotum.filters.'+key);
      else this.env.storage?.setItem('quotum.filters.'+key,JSON.stringify({current:entry.current,originRevision:entry.originRevision,originProjection:entry.originProjection,originSequence:entry.originSequence,resets:entry.resets,decisions:[...entry.decisions],materialize:entry.materialize,seq:entry.seq,conflicts:entry.conflicts}));}catch{/* Storage is optional; current intent remains in this tab. */}
  }
  private opening(e:Entry,saved:DataFilters){
    try{for(const family of ['wallet','funds'] as const)if((this.env.migrationStorage??this.env.storage)?.getItem('quotum.filters.migration.'+this.key+'.'+family)==='1')e.migrated[family]=true;
    }catch{/* A missing migration receipt leaves the original seed available. */}
    const seeded=e.migrated.wallet&&e.migrated.funds?saved:this.env.seed?.(saved)??saved;
    const current=structuredClone(seeded),legacy={...current.legacy};
    if(e.migrated.wallet){current.wallet=saved.wallet;if(saved.legacy?.walletByUnit)legacy.walletByUnit=saved.legacy.walletByUnit;else delete legacy.walletByUnit;}
    if(e.migrated.funds){current.funds=saved.funds;
      if(saved.legacy?.fundsByUnit)legacy.fundsByUnit=saved.legacy.fundsByUnit;else delete legacy.fundsByUnit;
      if(saved.legacy?.fundsPreferredByUnit)legacy.fundsPreferredByUnit=saved.legacy.fundsPreferredByUnit;else delete legacy.fundsPreferredByUnit;
    }
    if(Object.keys(legacy).length)current.legacy=legacy;else delete current.legacy;
    return current;
  }
  private consumeMigration(e:Entry,families:readonly FilterFamily[]){
    if(e.savedOnly)return;
    // This receipt outlives a clean tab draft, without changing another board's seed.
    for(const family of families)if(family==='wallet'||family==='funds'){
      e.migrated[family]=true;
      try{(this.env.migrationStorage??this.env.storage)?.setItem('quotum.filters.migration.'+this.key+'.'+family,'1');}catch{/* Current intent still remains in this tab. */}
    }
  }
  accept(envelope:FilterEnvelope){
    const e=this.entry(),parsed=parseDataFilters(envelope.filters);if(!e||!parsed||!Number.isSafeInteger(envelope.revision)||envelope.revision<0||typeof envelope.authority!=='string')return;
    if(envelope.revision<e.revisionFloor)return;
    e.revisionFloor=envelope.revision;
    if(e.saved?.revision===envelope.revision&&e.saved.authority===envelope.authority&&sameFilters(e.saved.filters,parsed))return;
    const before=e.saved;e.saved={...envelope,filters:parsed};
    if(!e.current){
      e.current=!this.savedOnly&&envelope.revision===0?this.opening(e,parsed):parsed;e.originRevision=envelope.revision;e.originProjection=parsed;e.conflicts=!this.savedOnly&&envelope.revision===0&&!e.migrated.wallet?this.env.conflicts?.(parsed)??0:0;
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
  private update(e:Entry,current:DataFilters,families:readonly FilterFamily[]){
    const parsed=parseDataFilters(current),fits=parsed&&executableWorkFilters(parsed);
    const before=e.current&&workFilterBytes(e.current),after=parsed&&workFilterBytes(parsed);
    const recovering=before&&after&&!executableWorkFilters(e.current!)&&after.every((bytes,i)=>bytes<=before[i])&&after.some((bytes,i)=>bytes<before[i]);
    if(!parsed||!fits&&!recovering){e.error=new ApiError(413,'filters_limit');return false;}
    const envelope={filters:parsed,authority:e.saved?.authority??'a'.repeat(43),replace:[...FILTER_FAMILIES],...this.intents(e)};
    if(jsonBytes(envelope)>FILTER_BODY_LIMIT){e.error=new ApiError(413,'filters_limit');return false;}
    e.current=parsed;e.generation++;e.error=fits?null:new ApiError(413,'filters_limit');this.consumeMigration(e,families);this.persist(e);this.publish();return true;
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
    if(!this.update(e,current,[family])){e.resets=previous.resets;e.decisions=previous.decisions;e.materialize=previous.materialize;this.publish();}
  }
  reset(family:FilterFamily|readonly FilterFamily[],mode:'all'|'none'){
    const e=this.entry();if(!e?.current)return;
    const previous={resets:{...e.resets},decisions:new Map(e.decisions),materialize:{...e.materialize}};
    let current=e.current;
    for(const part of typeof family==='string'?[family]:family){
      e.resets[part]={value:mode,seq:++e.seq};delete e.materialize[part as 'wallet'|'funds'];for(const [key,intent] of e.decisions)if(intent.value.family===part)e.decisions.delete(key);
      current=resetFilter(current,part,mode);
    }
    if(!this.update(e,current,typeof family==='string'?[family]:family)){e.resets=previous.resets;e.decisions=previous.decisions;e.materialize=previous.materialize;this.publish();}
  }
  restore(){const e=this.entry();if(!e?.saved)return;e.originSequence=++e.seq;e.conflicts=0;e.resets={};e.decisions.clear();e.materialize={};e.originRevision=e.saved.revision;e.originProjection=e.saved.filters;e.current=e.saved.filters;e.generation++;e.error=executableWorkFilters(e.current)?null:new ApiError(413,'filters_limit');this.consumeMigration(e,['wallet','funds']);this.persist(e);this.publish();}
  async save(){
    const e=this.entry();if(!e?.current||!e.saved||e.saving||e.saved.revision<e.revisionFloor)return;
    if(!parseDataFilters(e.current)||!executableWorkFilters(e.current)){e.error=new ApiError(413,'filters_limit');this.publish();return;}
    const key=this.key,board=this.board,seq=e.seq,basis=e.saved,authority=basis.authority;
    const filters=e.current,intents=this.intents(e),replace=FILTER_FAMILIES.filter(family=>JSON.stringify(filters[family])!==JSON.stringify(e.saved!.filters[family])||
      (family==='wallet'||family==='funds')&&JSON.stringify(filters.legacy)!==JSON.stringify(e.saved!.filters.legacy)||!!intents.resets[family]||intents.decisions.some(d=>d.family===family)||!!intents.materialize[family as 'wallet'|'funds']);
    const update:FilterUpdate={filters,authority,replace,...intents};if(!parseFilterUpdate(update)){e.error=new ApiError(413,'filters_limit');this.publish();return;}e.saving=true;e.error=null;this.publish();
    try{
      const reply=await this.env.save(board,e.saved.revision,update);
      if(!this.owns(e,key))return;
      if(reply.revision<e.revisionFloor)return;
      const publish=this.canPublish(e,key,basis,reply);
      if(readableEnvelope(reply))e.revisionFloor=reply.revision;
      if(!publish){
        e.error=new ApiError(409,'filters_context_changed');
        await this.refreshAccepted(e,key,board);
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
      if(!this.owns(e,key))return;
      const data=(error as {data?:FilterEnvelope}).data;
      e.error=error;
      if(readableEnvelope(data)){
        const publish=this.canPublish(e,key,basis,data);e.revisionFloor=Math.max(e.revisionFloor,data.revision);
        if(publish&&this.key===key)this.accept(data);else await this.refreshAccepted(e,key,board);
      }
    }finally{e.saving=false;if(this.key===key&&this.owns(e,key))this.publish();}
  }
}

/** A stable identity lets selectors subscribe without importing the board store. */
export const filterSelectionKey=(filters:DataFilters|null)=>filters?encodeDataFilters(filters):'';
export {defaultFilters};
