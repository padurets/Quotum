import {createHash} from 'node:crypto';
import type {Store} from './store/store.js';
import type {Directory} from './store/directory.js';
import {jsonBytes,workFilter,type DataFilters,type FilterAuthority,type FilterEnvelope,type MoneyRef} from './domain/dataFilters.js';
import {projectFilters} from './domain/dataFilterMerge.js';

/** Capture access once; saved intent never supplies permissions. */
export function filterContext(store:Store,board:string) {
  const sources=store.sources(board),bySource=new Map(sources.map(source=>[source.id,source]));
  const access=store.workAccess(board),devices=JSON.stringify([...access.devices.keys()]);
  const projects=new Map<string,boolean>();
  const project=store.db.prepare("SELECT 1 FROM agent_sessions s JOIN devices d ON d.id=s.device_id LEFT JOIN project_names n ON n.user_id=d.user_id AND n.reported=s.project JOIN json_each(?) j ON j.key=s.device_id WHERE COALESCE(n.name,NULLIF(s.project,''))=? AND EXISTS(SELECT 1 FROM agent_work w WHERE w.session_id=s.id AND w.to_at>CAST(j.value AS INTEGER)) LIMIT 1");
  const deviceFrom=JSON.stringify(Object.fromEntries([...access.devices].map(([id,scope])=>[id,scope.from])));
  const allowed:FilterAuthority=(family,ref)=>{
    if(family==='sources')return ref!==null&&typeof ref==='object'&&!Array.isArray(ref)&&('status' in ref||'source' in ref&&bySource.has(ref.source));
    if(family==='windows')return Array.isArray(ref)&&bySource.has(ref[0]);
    if(family==='wallet')return ref!==null&&typeof ref==='object'&&'source' in ref&&bySource.has(ref.source)&&bySource.get(ref.source)?.budget?.enabled!==false;
    if(family==='funds')return typeof ref==='string'&&bySource.has(ref)&&bySource.get(ref)?.budget?.enabled!==false;
    if(family==='devices')return typeof ref==='string'&&access.devices.has(ref);
    if(family==='clients')return true;
    if(ref===null)return true;
    if(typeof ref!=='string')return false;
    if(!projects.has(ref))projects.set(ref,!!project.get(deviceFrom,ref));return projects.get(ref)!;
  };
  const names=store.db.prepare('SELECT n.user_id,n.reported,n.name FROM project_names n WHERE n.user_id IN (SELECT user_id FROM devices WHERE id IN (SELECT value FROM json_each(?))) ORDER BY n.user_id,n.reported').all(devices);
  const labels=store.db.prepare('SELECT id,COALESCE(label,name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(devices);
  // Ordinary work credits and samples do not change this projection precondition.
  const authority=createHash('sha256').update(JSON.stringify([store.db.prepare("SELECT value FROM meta WHERE key='activityHubId'").get()?.value,board,
    sources.map(source=>[source.id,source.budget,source.holders]),[...access.sources].map(([id,scope])=>[id,scope.since]),[...access.devices],names,labels])).digest('base64url');
  const automatic=(ref:MoneyRef)=>ref.kind==='balance'||store.state(ref.source).keys?.slice(0,5).some(key=>key.id===ref.key)===true;
  return {allowed,authority,automatic};
}
export function filterEnvelope(directory:Directory,store:Store,board:string,context=filterContext(store,board)):FilterEnvelope {
  const {filters:raw,revision}=directory.filtersState(board);
  return {...projectFilters(raw,context.allowed),revision,authority:context.authority};
}

/** Reserve the released cursor and detail envelope before accepting an opening default. */
export function executableWorkFilters(filters:DataFilters) {
  const predicate=workFilter(filters);
  return jsonBytes({version:1,selection:{mode:'live',periodMs:86_400_000},evaluatedAt:Number.MAX_SAFE_INTEGER,sessions:{cursor:'x'.repeat(2048)},workFilter:predicate})<=76*1024&&
    jsonBytes({version:1,selection:{mode:'live',periodMs:86_400_000},evaluatedAt:Number.MAX_SAFE_INTEGER,cursor:'x'.repeat(2048),refs:Array.from({length:100},()=> '01234567'),workFilter:predicate})<=80*1024;
}
