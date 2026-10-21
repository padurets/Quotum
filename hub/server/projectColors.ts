import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {filterContext} from './dataFilters.js';
import type {Ingest} from './ingest.js';
import type {Store} from './store/store.js';
import type {WorkAccess} from './domain/workAccess.js';
import type {ProjectColorEnvelope} from './domain/projectColors.js';
import {readProjectColors} from './store/projectColors.js';

type Roster=ReturnType<Ingest['live']['board']>&{access:WorkAccess};

/** One process-private key serves all projections of a hub, never its persisted data. */
export class ProjectColors {
  private readonly key=randomBytes(32);
  constructor(private readonly store:Store,private readonly ingest:Ingest) {}

  context(board:string,roster?:Roster,now=Date.now()) {
    const access=roster?.access??this.store.workAccess(board,now);
    const raw=readProjectColors(this.store.db,board);
    const filters=filterContext(this.store,board,this.ingest,access,roster,now);
    const allowed=(name:string)=>filters.allowed('projects',name);
    const outcomes=raw.pins.map(([name])=>[name,allowed(name)]);
    const authority=this.mac(['quotum/project-colors/authority/v1',board,filters.authority,outcomes]);
    const envelope:ProjectColorEnvelope={version:1,pins:raw.pins.filter(([name])=>allowed(name)),revision:raw.revision,authority};
    return {access,allowed,raw,envelope};
  }

  choices(board:string,query:string,cursor?:string,now=Date.now(),personal?:{user:string;since:number}) {
    const context=this.context(board,undefined,now),authority=context.envelope.authority;
    let after:string|null=null;
    if(cursor){
      const [payload,signature,...extra]=cursor.split('.');
      if(extra.length||!payload||!signature||payload.length>2048||!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]{43}$/.test(signature))throw new Error('invalid_cursor');
      const expected=this.mac(['quotum/project-colors/cursor/v1',payload]);
      if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error('invalid_cursor');
      let parsed:unknown;try{parsed=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw new Error('invalid_cursor');}
      if(!Array.isArray(parsed)||parsed.length!==(personal?5:4)||parsed[0]!==board||parsed[1]!==query||typeof parsed[3]!=='string'||personal&&parsed[4]!==personal.user)throw new Error('invalid_cursor');
      if(parsed[2]!==authority)return {changed:true as const,envelope:context.envelope};
      after=parsed[3];
    }
    const devices=JSON.stringify(Object.fromEntries([...context.access.devices].map(([id,scope])=>[id,scope.from])));
    const retained=this.store.db.prepare(`WITH projects AS (SELECT DISTINCT COALESCE(n.name,NULLIF(s.project,'')) AS project_name
      FROM agent_sessions s JOIN devices d ON d.id=s.device_id JOIN json_each(?) j ON j.key=s.device_id
      LEFT JOIN project_names n ON n.user_id=d.user_id AND n.reported=s.project
      WHERE EXISTS(SELECT 1 FROM agent_work w WHERE w.session_id=s.id AND w.to_at>CAST(j.value AS INTEGER)))
      SELECT CAST(project_name AS BLOB) AS project_bytes FROM projects
      WHERE project_name IS NOT NULL AND instr(project_name,?)>0 AND (? IS NULL OR project_name COLLATE BINARY>?)
      ORDER BY project_name COLLATE BINARY LIMIT 51`).all(devices,query,after,after).map(row=>Buffer.from(row.project_bytes as Uint8Array).toString());
    const live=this.ingest.live.projectChoices(context.access,now,query,after,51);
    const own=personal?this.store.projectChoices(personal.user,personal.since,query,after,51):[];
    const names=[...new Set([...retained,...live,...own])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    const projects=names.slice(0,50),last=projects.at(-1);
    const payload=last&&names.length>50?Buffer.from(JSON.stringify([board,query,authority,last,...(personal?[personal.user]:[])])).toString('base64url'):null;
    return {changed:false as const,projects,authority,...(payload?{nextCursor:payload+'.'+this.mac(['quotum/project-colors/cursor/v1',payload])}:{})};
  }

  private mac(value:unknown) {return createHmac('sha256',this.key).update(JSON.stringify(value)).digest('base64url');}
}

// Route and event composition may wrap the same hub parts in different objects.
const services=new WeakMap<Ingest,ProjectColors>();
export function projectColorsOf(hub:{store:Store;ingest:Ingest;projectColors?:ProjectColors}) {
  const service=hub.projectColors??services.get(hub.ingest)??new ProjectColors(hub.store,hub.ingest);
  services.set(hub.ingest,service);hub.projectColors=service;return service;
}
