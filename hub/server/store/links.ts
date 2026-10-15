import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {afterCommit, transaction} from '../touches.js';
import {validClientId} from '../domain/clients.js';
import {providerOf} from '../domain/providers.js';
import type {ClientLink, LinkContext, LinkInput, LinkRoute} from '../domain/links.js';

export type LinkBatch=((owner:string,device:string,client:string)=>LinkContext)&{revision:string};

type Row = {id: string; client: string; device_id: string | null; route_class: LinkRoute['class'] | null; route_provider: string | null; source_id: string; from_at: number; to_at: number | null; created_at: number};
const linkOf = (r: Row): ClientLink => ({id: r.id, clientId: r.client, deviceId: r.device_id, route: r.route_class ? {class: r.route_class, provider: r.route_provider} : null, sourceId: r.source_id, from: r.from_at, to: r.to_at, createdAt: r.created_at});
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Owner rules and receipts commit with the revision and all validation. */
export class LinkStore {
  onChange: ((owner: string) => void) | null = null;
  constructor(private readonly db: DatabaseSync) {}
  revision(owner: string): string {return String(this.db.prepare('SELECT version FROM link_versions WHERE user_id=?').get(owner)?.version ?? 0);}
  list(owner: string): ClientLink[] {return (this.db.prepare('SELECT * FROM client_links WHERE user_id=? ORDER BY client,device_id,from_at,id').all(owner) as Row[]).map(linkOf);}
  context(owner: string, device: string, links = this.list(owner), held = this.held(owner)): LinkContext {
    const policy = this.db.prepare('SELECT route_enabled FROM device_tracking_policy WHERE device_id=? AND client=?').get(device, '*');
    return {links, held, routeEnabled: policy?.route_enabled !== 0};
  }
  forClient(context: LinkContext, device: string, client: string): LinkContext {
    const row = this.db.prepare('SELECT route_enabled FROM device_tracking_policy WHERE device_id=? AND client=?').get(device, client);
    return {...context, routeEnabled: context.routeEnabled && row?.route_enabled !== 0};
  }
  held(owner: string): Map<string, string> {return new Map((this.db.prepare("SELECT h.source_id,COALESCE(s.provider,'') AS provider FROM holders h LEFT JOIN sources s ON s.id=h.source_id WHERE h.user_id=?").all(owner) as {source_id: string; provider: string}[]).map(r => [r.source_id, r.provider]));}
  /** One captured rule set serves all owners, clients and devices of a projection. */
  batch(owners: readonly string[],reserve?:(bytes:number)=>void,at=Date.now()):LinkBatch {
    reserve?.(256+owners.reduce((bytes,owner)=>bytes+160+owner.length*4,0));
    const users=[...new Set(owners)],people = JSON.stringify(users), links = new Map<string, Map<string, ClientLink[]>>(), held = new Map<string, Map<string, string>>();
    const next=new Map<string,{version:number;clients:Map<string,ClientLink[]>}>();
    const rows=this.db.prepare("SELECT r.value AS owner,COALESCE(v.version,0) AS version,l.* FROM json_each(?) r LEFT JOIN link_versions v ON v.user_id=r.value LEFT JOIN client_links l ON l.user_id=r.value").iterate(people);
    for(const raw of rows) {
      const row=raw as unknown as Row&{owner:string;version:number};
      let group=next.get(row.owner);
      if(!group){reserve?.(256);next.set(row.owner,group={version:row.version,clients:new Map()});links.set(row.owner,group.clients);}
      if(row.id){
        reserve?.(768+2*(row.owner.length+row.client.length+(row.device_id?.length??0)+row.source_id.length+(row.route_provider?.length??0)));
        let list=group.clients.get(row.client);if(!list)group.clients.set(row.client,list=[]);list.push(linkOf(row));
      }
    }
    for (const raw of this.db.prepare("SELECT h.user_id,h.source_id,COALESCE(s.provider,'') AS provider FROM holders h LEFT JOIN sources s ON s.id=h.source_id WHERE h.user_id IN (SELECT value FROM json_each(?))").iterate(people)) {
      const row=raw as {user_id:string;source_id:string;provider:string};
      reserve?.(256+2*(row.user_id.length+row.source_id.length+row.provider.length));
      let map = held.get(row.user_id); if (!map) held.set(row.user_id, map = new Map()); map.set(row.source_id, row.provider);
    }
    const disabled=new Set<string>();
    for(const raw of this.db.prepare('SELECT p.device_id,p.client FROM device_tracking_policy p JOIN devices d ON d.id=p.device_id WHERE d.user_id IN (SELECT value FROM json_each(?)) AND p.route_enabled=0').iterate(people)){
      const row=raw as {device_id:string;client:string};reserve?.(160+2*(row.device_id.length+row.client.length));disabled.add(JSON.stringify([row.device_id,row.client]));
    }
    const empty: ClientLink[] = [], noHoldings = new Map<string, string>();
    const targets:[string,string,boolean][]=[],versions:[string,number][]=[];let phase=0;
    for(const [owner,group] of next) {
      versions.push([owner,group.version]);const sources=new Set<string>();
      for(const list of group.clients.values())for(const link of list){sources.add(link.sourceId);phase+=Number(link.from<=at)+Number(link.to!==null&&link.to<=at);}
      for(const source of [...sources].sort())targets.push([owner,source,held.get(owner)?.has(source)??false]);
    }
    const evidence=this.db.prepare("SELECT key,value FROM meta WHERE key IN (SELECT 'workEvidence:'||value FROM json_each(?)) ORDER BY key").all(people);
    const revision=createHash('sha256').update(JSON.stringify([versions,targets,[...disabled].sort(),evidence,phase])).digest('base64url');
    return Object.assign((owner:string,device:string,client:string)=>({links:links.get(owner)?.get(client)??empty,held:held.get(owner)??noHoldings,routeEnabled:!disabled.has(JSON.stringify([device,'*']))&&!disabled.has(JSON.stringify([device,client]))}),{revision});
  }
  private own(owner: string, id: string): ClientLink {
    const row = this.db.prepare('SELECT * FROM client_links WHERE user_id=? AND id=?').get(owner, id) as Row | undefined;
    if (!row) throw new Error('not_found'); return linkOf(row);
  }
  private input(owner: string, value: unknown): LinkInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_link');
    const r = value as Record<string, unknown>, route = r.route as Record<string, unknown> | null;
    if (!validClientId(r.clientId) || r.deviceId !== null && typeof r.deviceId !== 'string' || typeof r.sourceId !== 'string'
      || !time(r.from) || r.to !== null && (!time(r.to) || r.to <= r.from)
      || route !== null && (!route || typeof route !== 'object' || Array.isArray(route) || !['subscription', 'api', 'unknown'].includes(String(route.class)) || route.provider !== null && (typeof route.provider !== 'string' || !providerOf(route.provider)))) throw new Error('invalid_link');
    if (r.deviceId !== null && !this.db.prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(r.deviceId as string, owner)) throw new Error('not_found');
    if (!this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(r.sourceId)) throw new Error('not_found');
    if (!this.held(owner).has(r.sourceId)) {
      // Only an existing own rule may identify an unavailable target.
      if (!this.db.prepare('SELECT 1 FROM client_links WHERE user_id=? AND source_id=? UNION ALL SELECT 1 FROM declared_accounts WHERE user_id=? AND source_id=? UNION ALL SELECT 1 FROM device_sources s JOIN devices d ON d.id=s.device_id WHERE d.user_id=? AND s.source_id=?').get(owner, r.sourceId, owner, r.sourceId, owner, r.sourceId)) throw new Error('not_found');
      throw new Error('source_not_held');
    }
    return {clientId: r.clientId, deviceId: r.deviceId as string | null, sourceId: r.sourceId, route: route as LinkRoute | null, from: r.from, to: r.to as number | null};
  }
  private overlap(owner: string, input: LinkInput, exclude: string | null = null) {
    if (this.db.prepare('SELECT 1 FROM client_links WHERE user_id=? AND client=? AND device_id IS ? AND route_class IS ? AND route_provider IS ? AND id IS NOT ? AND (? IS NULL OR from_at<?) AND (to_at IS NULL OR ?<to_at)').get(owner, input.clientId, input.deviceId, input.route?.class ?? null, input.route?.provider ?? null, exclude, input.to, input.to, input.from)) throw new Error('link_overlap');
  }
  private save(owner: string, link: ClientLink) {
    this.db.prepare('INSERT INTO client_links VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client=excluded.client,device_id=excluded.device_id,route_class=excluded.route_class,route_provider=excluded.route_provider,source_id=excluded.source_id,from_at=excluded.from_at,to_at=excluded.to_at').run(link.id, owner, link.clientId, link.deviceId, link.route?.class ?? null, link.route?.provider ?? null, link.sourceId, link.from, link.to, link.createdAt);
  }
  mutate(owner: string, operation: 'create' | 'correct' | 'change' | 'delete', id: string | null, body: unknown, now: number, fresh?: () => void): {status: number; body: {revision: string; links: ClientLink[]}} {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_link');
    const command = body as Record<string, unknown>;
    if ('userId' in command || 'owner' in command || 'ownerId' in command) throw new Error('invalid_link');
    if (typeof command.expectedRevision !== 'string' || !/^\d{1,20}$/.test(command.expectedRevision) || typeof command.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.requestId)) throw new Error('invalid_link');
    const hash = createHash('sha256').update(canonical({operation, id, body})).digest('hex');
    return transaction(this.db, () => {
      const receipt = this.db.prepare('SELECT hash,status,response FROM link_mutations WHERE user_id=? AND request_id=? AND created_at>=?').get(owner, command.requestId as string, now - 7 * 86_400_000) as {hash: string; status: number; response: string} | undefined;
      if (receipt) {if (receipt.hash !== hash) throw new Error('mutation_conflict'); return {status: receipt.status, body: JSON.parse(receipt.response)};}
      if (this.revision(owner) !== command.expectedRevision) throw new Error('links_changed');
      fresh?.();
      const old = id === null ? null : this.own(owner, id);
      let changed = true;
      if (operation === 'delete') {if (!old) throw new Error('not_found'); this.db.prepare('DELETE FROM client_links WHERE id=? AND user_id=?').run(old.id, owner);}
      else if (operation === 'change') {
        if (!old) throw new Error('not_found');
        if (!time(command.at) || command.at < old.from || old.to !== null && command.at >= old.to) throw new Error('invalid_link');
        const replacement=Object.fromEntries(['clientId','deviceId','route','to'].filter(key=>Object.hasOwn(command,key)).map(key=>[key,command[key]]));
        const input = this.input(owner, {...old, ...replacement, sourceId: command.newSourceId, from: command.at});
        this.overlap(owner, input, old.id);
        changed = canonical(input) !== canonical({clientId:old.clientId,deviceId:old.deviceId,route:old.route,sourceId:old.sourceId,from:input.from,to:old.to});
        if (changed) {
          if (input.from === old.from) this.save(owner, {...old, ...input});
          else {this.save(owner, {...old, to: input.from}); this.save(owner, {...input, id: randomUUID(), createdAt: now});}
        }
      } else {
        const input = this.input(owner, command); this.overlap(owner, input, old?.id ?? null);
        changed = !old || canonical(input) !== canonical({clientId: old.clientId, deviceId: old.deviceId, route: old.route, sourceId: old.sourceId, from: old.from, to: old.to});
        if (changed) this.save(owner, {...input, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now});
      }
      if (changed) {
        this.db.prepare('INSERT INTO link_versions VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET version=version+1').run(owner);
        this.db.prepare('INSERT INTO account_revisions VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1').run(owner);
        afterCommit(() => this.onChange?.(owner));
      }
      const result = {revision: this.revision(owner), links: this.list(owner)}, status = operation === 'create' ? 201 : 200;
      this.db.prepare('DELETE FROM link_mutations WHERE created_at<?').run(now - 7 * 86_400_000);
      this.db.prepare('INSERT OR REPLACE INTO link_mutations VALUES (?,?,?,?,?,?)').run(owner, command.requestId as string, hash, status, JSON.stringify(result), now);
      return {status, body: result};
    });
  }
}
