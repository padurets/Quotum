import {createHash} from 'node:crypto';
import type {Store} from './store/store.js';
import type {Directory} from './store/directory.js';
import {type FilterAuthority,type FilterEnvelope,type MoneyRef} from './domain/dataFilters.js';
import {parseStoredFilters,projectStoredFilters,storedProjectRefs} from './domain/dataFilterStorage.js';
import {moneyFamily,providerOf,supportsQuota} from './domain/providers.js';
import type {Ingest} from './ingest.js';
import type {WorkAccess} from './domain/workAccess.js';
import type {WorkFilter} from './domain/dataFilters.js';
import type {WorkChoices} from './domain/periodRead.js';

/** Explicit project choices use the same admitted history as saved projections. */
export function projectAuthority(store:Store,access:WorkAccess,liveProjects:ReadonlySet<string|null>,reserve:(bytes:number)=>void=()=>{}) {
  let bytes=512;for(const id of access.devices.keys())bytes+=256+id.length*4;reserve(bytes);
  const deviceFrom=JSON.stringify(Object.fromEntries([...access.devices].map(([id,scope])=>[id,scope.from]))),projects=new Map<string,boolean>();
  const project=store.db.prepare("SELECT 1 FROM agent_sessions s JOIN devices d ON d.id=s.device_id LEFT JOIN project_names n ON n.user_id=d.user_id AND n.reported=s.project JOIN json_each(?) j ON j.key=s.device_id WHERE COALESCE(n.name,NULLIF(s.project,''))=? AND EXISTS(SELECT 1 FROM agent_work w WHERE w.session_id=s.id AND w.to_at>CAST(j.value AS INTEGER)) LIMIT 1");
  return (ref:string|null)=>{if(ref===null)return true;if(!projects.has(ref)){reserve(128+ref.length*2);projects.set(ref,liveProjects.has(ref)||!!project.get(deviceFrom,ref));}return projects.get(ref)!;};
}

/** Removable explicit choices are authorized separately from the period universe. */
export function retainedWorkChoices(store:Store,access:WorkAccess,ingest:Ingest,filter:WorkFilter|undefined,facets:WorkChoices,now:number,reserve:(bytes:number)=>void,release:(bytes:number)=>void):WorkChoices|undefined {
  if(!filter)return;
  let scratch=0,owned=0,complete=false;
  const temp=(bytes:number)=>{reserve(bytes);scratch+=bytes;},drop=(bytes:number)=>{release(bytes);scratch-=bytes;},keep=(bytes:number)=>{reserve(bytes);owned+=bytes;};
  try{
    keep(384);const choices:WorkChoices={projects:[],devices:[],clients:[],funding:[]};
    temp(128+filter.projects.values.length*128);const missing=new Set(filter.projects.values.filter(ref=>!facets.projects.includes(ref)));
    if(missing.size){
      const live=ingest.live.projects(access,now,missing,temp,drop),allowed=projectAuthority(store,access,live,temp);
      for(const ref of missing)if(allowed(ref)){keep(128+(ref?.length??0)*2);choices.projects.push(ref);}
    }
    for(const id of filter.devices.values)if(!facets.devices.some(device=>device.id===id)&&access.devices.has(id)){
      temp(1024);
      try{const row=store.db.prepare('SELECT COALESCE(label,name) AS name FROM devices WHERE id=?').get(id);if(typeof row?.name==='string'){keep(256+id.length*2+row.name.length*2);choices.devices.push({id,name:row.name});}}
      finally{drop(1024);}
    }
    for(const ref of filter.clients.values)if(!facets.clients.includes(ref)){keep(128+(ref?.length??0)*2);choices.clients.push(ref);}
    for(const ref of filter.sources.values)if('status' in ref&&!facets.funding.includes(ref.status)){keep(128);choices.funding.push(ref.status);}
    if(!choices.projects.length&&!choices.devices.length&&!choices.clients.length&&!choices.funding.length){release(owned);owned=0;return;}
    complete=true;return choices;
  }finally{release(scratch);if(!complete&&owned)release(owned);}
}

/** Capture access once; saved intent never supplies permissions. */
export function filterContext(store:Store,board:string,ingest?:Ingest,capturedAccess?:ReturnType<Store['workAccess']>,capturedRoster?:ReturnType<Ingest['live']['board']>,now=Date.now()) {
  const sources=store.sources(board),bySource=new Map(sources.map(source=>[source.id,source]));
  const access=capturedAccess??store.workAccess(board,now),devices=JSON.stringify([...access.devices.keys()]);
  const liveProjects=capturedRoster?new Set([...[...capturedRoster.sessions.values()].flat(),...capturedRoster.unattributedSessions].map(row=>row.project)):ingest?.live.projects(access,now)??new Set();
  const projectAllowed=projectAuthority(store,access,liveProjects);
  const allowed:FilterAuthority=(family,ref)=>{
    if(family==='sources')return ref!==null&&typeof ref==='object'&&!Array.isArray(ref)&&('status' in ref||'source' in ref&&bySource.has(ref.source));
    if(family==='windows')return Array.isArray(ref)&&supportsQuota(providerOf(bySource.get(ref[0])?.provider??''));
    if(family==='wallet')return ref!==null&&typeof ref==='object'&&'source' in ref&&moneyFamily(providerOf(bySource.get(ref.source)?.provider??''))==='budget'&&bySource.get(ref.source)?.budget?.enabled!==false;
    if(family==='funds')return typeof ref==='string'&&moneyFamily(providerOf(bySource.get(ref)?.provider??''))==='funds'&&bySource.get(ref)?.budget?.enabled!==false;
    if(family==='devices')return typeof ref==='string'&&access.devices.has(ref);
    if(family==='clients')return true;
    if(ref===null)return true;
    if(typeof ref!=='string')return false;
    return projectAllowed(ref);
  };
  const names=store.db.prepare('SELECT n.user_id,CAST(n.reported AS BLOB) AS reported,CAST(n.name AS BLOB) AS name FROM project_names n WHERE n.user_id IN (SELECT user_id FROM devices WHERE id IN (SELECT value FROM json_each(?))) ORDER BY n.user_id,n.reported').iterate(devices);
  const labels=store.db.prepare('SELECT id,COALESCE(label,name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(devices);
  const raw=store.db.prepare('SELECT payload FROM board_filters WHERE board_id=?').get(board);
  const stored=raw?parseStoredFilters(JSON.parse(String(raw.payload))):null;
  const explicitProjects=stored?storedProjectRefs(stored):[];
  // Ordinary work credits and samples do not change this projection precondition.
  // Availability of saved dormant decisions does: a newly visible rule must not
  // disappear in a replacement based on the earlier projection.
  const hash=createHash('sha256').update(JSON.stringify([store.db.prepare("SELECT value FROM meta WHERE key='activityHubId'").get()?.value,board,
    sources.map(source=>[source.id,source.budget,source.holders]),[...access.sources].map(([id,scope])=>[id,scope.since]),[...access.devices]]).slice(0,-1));
  // Stream exact aliases so a catalogue page never materializes every correction.
  hash.update(',[');let first=true;
  for(const row of names){row.reported=Buffer.from(row.reported as Uint8Array).toString();row.name=Buffer.from(row.name as Uint8Array).toString();if(!first)hash.update(',');hash.update(JSON.stringify(row));first=false;}
  const authority=hash.update('],').update(JSON.stringify([labels,explicitProjects.map(ref=>[ref,allowed('projects',ref)])]).slice(1)).digest('base64url');
  const automatic=(ref:MoneyRef)=>ref.kind==='balance'||store.state(ref.source).keys?.slice(0,5).some(key=>key.id===ref.key)===true;
  return {allowed,authority,automatic};
}
export function filterEnvelope(directory:Directory,store:Store,board:string,context=filterContext(store,board)):FilterEnvelope {
  const raw=directory.filtersState(board);
  return {...projectStoredFilters(raw,context.allowed),revision:raw.revision,authority:context.authority};
}

export {executableWorkFilters} from './domain/dataFilters.js';
