import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Tracking} from '../domain/ingest.js';
import {CREDIT_MS} from '../sessions.js';

// A database connection is not a hub restart. Finished spans retain their evidence.
const runtimeEpoch=randomUUID();
type Witness={payload:string;last_at:number;epoch:string;topology_version:number};
const digest=(tracking:Tracking)=>createHash('sha256').update(JSON.stringify([tracking.clients,tracking.routeDisabled])).digest('hex');

export class CoverageStore {
  constructor(private readonly db:DatabaseSync) {}
  revision():string {return String(this.db.prepare("SELECT value FROM meta WHERE key='coverageVersion'").get()?.value??0);}
  topology(user:string):number {return Number(this.db.prepare('SELECT version FROM owner_coverage_versions WHERE user_id=?').get(user)?.version??0);}

  /** Current policy is separate from the proof carried by a delayed interval. */
  policy(device:string,tracking:Tracking,now:number,user:string):boolean {
    const previous=this.db.prepare('SELECT payload FROM device_tracking WHERE device_id=?').get(device);
    const old=previous?JSON.parse(String(previous.payload)) as Tracking:null;
    if(old&&JSON.stringify([old.clients,old.routeDisabled])===JSON.stringify([tracking.clients,tracking.routeDisabled]))return false;
    this.db.prepare('DELETE FROM device_tracking_policy WHERE device_id=?').run(device);
    for(const client of tracking.routeDisabled)this.db.prepare('INSERT INTO device_tracking_policy VALUES (?,?,0)').run(device,client);
    this.db.prepare('INSERT INTO device_tracking VALUES (?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET payload=excluded.payload,last_at=excluded.last_at,epoch=excluded.epoch,topology_version=excluded.topology_version')
      .run(device,JSON.stringify({...tracking,complete:false}),now,'observed',this.topology(user));
    this.db.prepare("INSERT INTO meta VALUES ('coverageVersion','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
    return true;
  }

  /** Only an issued proof and two completed compatible endpoints establish known time. */
  recordCaptured(device:string,from:number,to:number,scope:string,epoch:string,version:number):boolean {
    if(to<=from)return false;
    const previous=this.db.prepare('SELECT from_at,to_at,scope_digest,epoch,topology_version FROM work_coverage WHERE device_id=? ORDER BY from_at DESC LIMIT 1').get(device);
    if(previous&&previous.to_at===from&&previous.scope_digest===scope&&previous.epoch===epoch&&previous.topology_version===version)
      this.db.prepare('UPDATE work_coverage SET to_at=? WHERE device_id=? AND from_at=?').run(to,device,Number(previous.from_at));
    else this.db.prepare('INSERT INTO work_coverage VALUES (?,?,?,?,?,?)').run(device,from,to,scope,epoch,version);
    this.db.prepare("INSERT INTO meta VALUES ('coverageVersion','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
    return true;
  }

  /** Returns policy changes separately from coverage changes. The caller owns the transaction. */
  record(device:string,user:string,tracking:Tracking|null,now:number,epoch:string=runtimeEpoch):{policy:boolean;coverage:boolean} {
    const previous=this.db.prepare('SELECT * FROM device_tracking WHERE device_id=?').get(device) as Witness|undefined;
    const old=previous?JSON.parse(previous.payload) as Tracking:null;
    const next=tracking??(old?{...old,complete:false}:null);
    if(!next)return {policy:false,coverage:false};
    const version=this.topology(user),rollback=previous!==undefined&&now<=previous.last_at;
    const value=rollback?{...next,complete:false}:next;
    const policy=tracking!==null&&JSON.stringify(old?.routeDisabled??[])!==JSON.stringify(next.routeDisabled);
    if(tracking){
      this.db.prepare('DELETE FROM device_tracking_policy WHERE device_id=?').run(device);
      const insert=this.db.prepare('INSERT INTO device_tracking_policy VALUES (?,?,0)');
      for(const client of next.routeDisabled)insert.run(device,client);
    }
    const scope=digest(value),gap=previous?now-previous.last_at:0;
    if(previous&&old?.complete&&value.complete&&value.clients.length&&gap>0&&gap<=CREDIT_MS&&previous.epoch===epoch&&previous.topology_version===version&&digest(old)===scope) {
      const last=this.db.prepare('SELECT from_at,to_at,scope_digest,epoch,topology_version FROM work_coverage WHERE device_id=? ORDER BY from_at DESC LIMIT 1').get(device);
      if(last&&last.to_at===previous.last_at&&last.scope_digest===scope&&last.epoch===epoch&&last.topology_version===version)
        this.db.prepare('UPDATE work_coverage SET to_at=? WHERE device_id=? AND from_at=?').run(now,device,Number(last.from_at));
      else this.db.prepare('INSERT INTO work_coverage VALUES (?,?,?,?,?,?)').run(device,previous.last_at,now,scope,epoch,version);
    }
    const high=Math.max(now,previous?.last_at??now);
    this.db.prepare('INSERT INTO device_tracking VALUES (?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET payload=excluded.payload,last_at=excluded.last_at,epoch=excluded.epoch,topology_version=excluded.topology_version')
      .run(device,JSON.stringify(value),high,epoch,version);
    this.db.prepare("INSERT INTO meta VALUES ('coverageVersion','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
    return {policy,coverage:true};
  }

  /** Every currently connected holder device must witness the whole interval. */
  full(source:string,from:number,to:number):boolean {
    return this.reader(source,from,to)(from,to);
  }

  /** One bounded coverage read serves every qualifying window interval. */
  reader(source:string,from:number,to:number):(from:number,to:number)=>boolean {
    const holders=this.db.prepare('SELECT user_id,since FROM holders WHERE source_id=?').all(source) as {user_id:string;since:number}[];
    if(!holders.length)return ()=>false;
    const devices=this.db.prepare('SELECT d.id,d.user_id,d.created_at,t.payload FROM devices d LEFT JOIN device_tracking t ON t.device_id=d.id WHERE d.revoked_at IS NULL AND d.user_id IN (SELECT user_id FROM holders WHERE source_id=?)').all(source) as {id:string;user_id:string;created_at:number;payload:string|null}[];
    if(holders.some(h=>!devices.some(d=>d.user_id===h.user_id)))return ()=>false;
    const spans=this.db.prepare('SELECT device_id,from_at,to_at,scope_digest,topology_version FROM work_coverage WHERE device_id IN (SELECT value FROM json_each(?)) AND to_at>? AND from_at<? ORDER BY device_id,from_at').all(JSON.stringify(devices.map(d=>d.id)),from,to) as {device_id:string;from_at:number;to_at:number;scope_digest:string;topology_version:number}[];
    const versions=new Map(holders.map(h=>[h.user_id,this.topology(h.user_id)]));
    return (from,to)=>!holders.some(h=>h.since>from)&&devices.every(device=>{
      if(device.created_at>from||!device.payload)return false;
      const tracking=JSON.parse(device.payload) as Tracking;if(!tracking.clients.length)return false;
      const scope=digest(tracking),version=versions.get(device.user_id);let until=from;
      for(const span of spans){if(span.device_id!==device.id||span.scope_digest!==scope||span.topology_version!==version)continue;if(span.from_at>until)return false;until=Math.max(until,span.to_at);if(until>=to)return true;}
      return false;
    });
  }

  prune(cutoff:number) {
    this.db.prepare('DELETE FROM work_coverage WHERE to_at<=?').run(cutoff);
    this.db.prepare('UPDATE work_coverage SET from_at=? WHERE from_at<? AND to_at>?').run(cutoff,cutoff,cutoff);
  }
}
