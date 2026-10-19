import {createHash} from 'node:crypto';
import type {Store} from './store/store.js';
import type {Directory} from './store/directory.js';
import {type FilterAuthority,type FilterEnvelope,type MoneyRef} from './domain/dataFilters.js';
import {parseStoredFilters,projectStoredFilters,storedProjectRefs} from './domain/dataFilterStorage.js';
import {moneyFamily,providerOf,supportsQuota} from './domain/providers.js';
import type {Ingest} from './ingest.js';

/** Capture access once; saved intent never supplies permissions. */
export function filterContext(store:Store,board:string,ingest?:Ingest,capturedAccess?:ReturnType<Store['workAccess']>,capturedRoster?:ReturnType<Ingest['live']['board']>) {
  const sources=store.sources(board),bySource=new Map(sources.map(source=>[source.id,source]));
  const access=capturedAccess??store.workAccess(board),devices=JSON.stringify([...access.devices.keys()]);
  const projects=new Map<string,boolean>();
  const liveProjects=capturedRoster?new Set([...[...capturedRoster.sessions.values()].flat(),...capturedRoster.unattributedSessions].map(row=>row.project)):ingest?.live.projects(access,Date.now())??new Set();
  const project=store.db.prepare("SELECT 1 FROM agent_sessions s JOIN devices d ON d.id=s.device_id LEFT JOIN project_names n ON n.user_id=d.user_id AND n.reported=s.project JOIN json_each(?) j ON j.key=s.device_id WHERE COALESCE(n.name,NULLIF(s.project,''))=? AND EXISTS(SELECT 1 FROM agent_work w WHERE w.session_id=s.id AND w.to_at>CAST(j.value AS INTEGER)) LIMIT 1");
  const deviceFrom=JSON.stringify(Object.fromEntries([...access.devices].map(([id,scope])=>[id,scope.from])));
  const allowed:FilterAuthority=(family,ref)=>{
    if(family==='sources')return ref!==null&&typeof ref==='object'&&!Array.isArray(ref)&&('status' in ref||'source' in ref&&bySource.has(ref.source));
    if(family==='windows')return Array.isArray(ref)&&supportsQuota(providerOf(bySource.get(ref[0])?.provider??''));
    if(family==='wallet')return ref!==null&&typeof ref==='object'&&'source' in ref&&moneyFamily(providerOf(bySource.get(ref.source)?.provider??''))==='budget'&&bySource.get(ref.source)?.budget?.enabled!==false;
    if(family==='funds')return typeof ref==='string'&&moneyFamily(providerOf(bySource.get(ref)?.provider??''))==='funds'&&bySource.get(ref)?.budget?.enabled!==false;
    if(family==='devices')return typeof ref==='string'&&access.devices.has(ref);
    if(family==='clients')return true;
    if(ref===null)return true;
    if(typeof ref!=='string')return false;
    if(!projects.has(ref))projects.set(ref,liveProjects.has(ref)||!!project.get(deviceFrom,ref));return projects.get(ref)!;
  };
  const names=store.db.prepare('SELECT n.user_id,n.reported,n.name FROM project_names n WHERE n.user_id IN (SELECT user_id FROM devices WHERE id IN (SELECT value FROM json_each(?))) ORDER BY n.user_id,n.reported').all(devices);
  const labels=store.db.prepare('SELECT id,COALESCE(label,name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(devices);
  const raw=store.db.prepare('SELECT payload FROM board_filters WHERE board_id=?').get(board);
  const stored=raw?parseStoredFilters(JSON.parse(String(raw.payload))):null;
  const explicitProjects=stored?storedProjectRefs(stored):[];
  // Ordinary work credits and samples do not change this projection precondition.
  // Availability of saved dormant decisions does: a newly visible rule must not
  // disappear in a replacement based on the earlier projection.
  const authority=createHash('sha256').update(JSON.stringify([store.db.prepare("SELECT value FROM meta WHERE key='activityHubId'").get()?.value,board,
    sources.map(source=>[source.id,source.budget,source.holders]),[...access.sources].map(([id,scope])=>[id,scope.since]),[...access.devices],names,labels,explicitProjects.map(ref=>[ref,allowed('projects',ref)])])).digest('base64url');
  const automatic=(ref:MoneyRef)=>ref.kind==='balance'||store.state(ref.source).keys?.slice(0,5).some(key=>key.id===ref.key)===true;
  return {allowed,authority,automatic};
}
export function filterEnvelope(directory:Directory,store:Store,board:string,context=filterContext(store,board)):FilterEnvelope {
  const raw=directory.filtersState(board);
  return {...projectStoredFilters(raw,context.allowed),revision:raw.revision,authority:context.authority};
}

export {executableWorkFilters} from './domain/dataFilters.js';
