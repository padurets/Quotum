import {createHmac, randomBytes} from 'node:crypto';
import {config} from './config.js';
import {tileEnd, tileOf, tileStart,planRowDeadline, type Chunk, type HistoryBasis, type HistoryScope} from './domain/history.js';
import type {Shown, Store, WorkRead} from './store/store.js';
import type {MeterSelection} from './domain/meterHistory.js';
import {sharedWork} from './periodWork.js';

export class HistoryLimit extends Error { constructor() {super('history_limit');} }

type Kept = {owner:string|null;devices:Set<string>;users:Set<string>;scope?: HistoryScope; sourceWork?:boolean; workKey: string; sources: Set<string>; cell: number; tile: number; json: string; bytes: number;validUntil:number};

/** JSON permits shorter exact integer spellings (300000 is 3e5); names stay untouched. */
export function compactJSON(value: unknown, replacer?: (this: unknown, key: string, value: unknown) => unknown): string {
  return JSON.stringify(value,replacer).replace(/"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g, (token, number: string | undefined) => {
    if (!number || !/^-?\d+0{3,}$/.test(number)) return token;
    const end = number.match(/0+$/)![0].length;
    const shorter = `${number.slice(0, -end)}e${end}`;
    return shorter.length < number.length ? shorter : token;
  });
}

/** Only whole, closed tiles are shared; touches invalidate them even without readers. */
export class HistoryTiles {
  private readonly key = randomBytes(32);
  private readonly kept = new Map<string, Kept>();
  private readonly refs = new Map<string, string>();
  private bytes = 0;
  private retentionRevision = 0;
  private reserved = 0;

  constructor(private readonly store: Store, private readonly budget = 32 * 1024 * 1024) {}

  metadata(board: string, value: Omit<HistoryBasis, 'now' | 'meta'>, scope?: HistoryScope) {
    return createHmac('sha256', this.key).update(`meta:${board}:${scope ?? 'legacy'}:${JSON.stringify(value)}`).digest('base64url');
  }

  ref(board: string, session: number) {
    return this.cachedRef(`${board}:${session}`);
  }

  fragmentRef(board: string, session: number, source: string | null, sourceStatus?:'notProvided') {
    return this.cachedRef(JSON.stringify([board, session, source,sourceStatus]));
  }

  /** Partial tiles reuse these immutable pseudonyms without hashing every read. */
  private cachedRef(input: string) {
    const hit=this.refs.get(input);if(hit!==undefined)return hit;
    const bytes=this.refBytes(input);this.makeRoom(bytes);
    const value=createHmac('sha256',this.key).update(input).digest('base64url').slice(0,8);
    if(this.bytes+this.reserved+bytes<=this.budget){this.refs.set(input,value);this.bytes+=bytes;}
    return value;
  }

  private refBytes(input:string){return 256+input.length*2;}
  private makeRoom(bytes:number){
    while(this.bytes+this.reserved+bytes>this.budget){
      if(this.refs.size){const key=this.refs.keys().next().value!;this.refs.delete(key);this.bytes-=this.refBytes(key);}
      else if(this.kept.size)this.drop(this.kept.keys().next().value!);
      else break;
    }
  }

  /** Request projections share the tile budget and release their reservation on every exit. */
  reservation() {
    let used = 0;
    return {
      add: (bytes: number) => {
        if (bytes + this.reserved > this.budget) throw new HistoryLimit();
        this.makeRoom(bytes);
        this.reserved += bytes; used += bytes;
      },
      remove: (bytes: number) => {if(bytes<0||bytes>used)throw new Error('invalid_reservation');this.reserved-=bytes;used-=bytes;},
      close: () => {this.reserved -= used; used = 0;},
    };
  }

  touch(source: string, since: number, scopes?: readonly HistoryScope[], work=false) {
    for (const [key, tile] of this.kept) if ((!work||tile.scope!=='budget'||tile.sourceWork) && (!tile.scope || !scopes || scopes.includes(tile.scope)) && tile.sources.has(source) && tileEnd(tile.tile, tile.cell) > since) this.drop(key);
  }

  touchClient(user:string,since:number,device?:string) {
    for (const [key,tile] of this.kept) if ((device?tile.devices.has(device):tile.users.has(user)) && (!tile.scope || tile.scope === 'quota'||tile.sourceWork) && tileEnd(tile.tile, tile.cell) > since) this.drop(key);
  }

  private drop(key: string) {
    const tile = this.kept.get(key);
    if (tile) this.bytes -= tile.bytes;
    this.kept.delete(key);
  }

  /** JSON is stored as sent, so hits do not allocate or serialize all the cells again. */
  read(board: string, cell: number, from: number, to: number, now: number, shown: Shown, meters?: MeterSelection, scope?: HistoryScope, work?: WorkRead, sourceWork=false): string[] {
    const reservation=!work&&(scope!=='budget'||sourceWork)?this.reservation():null;
    try{
    if(reservation)work=sharedWork({store:this.store},shown,{from,to},reservation.add,reservation.remove,null,now,board);
    if (this.retentionRevision !== this.store.retentionRevision) {
      this.kept.clear();
      this.refs.clear();
      this.bytes = 0;
      this.retentionRevision = this.store.retentionRevision;
    }
    const access=scope==='budget'&&!sourceWork?null:work!.ensureAccess!();
    work?.reserve?.(128*((access?.devices.size??0)*2+(access?.sources.size??0)));
    const sources=new Set(access?access.sources.keys():this.store.sources(board).map(s=>s.id));
    const devices=new Set(access?.devices.keys()),users=new Set([...(access?.devices.values()??[])].map(d=>d.owner));
    const oldest = now - (config.retention.sampleDays - 1) * 86_400_000;
    const parts: {from: number; to: number; tile: number; key: string; eligible: boolean; json?: string}[] = [];
    for (let at = from; at < to;) {
      const tile = tileOf(at, cell);
      const end = Math.min(to, tileEnd(tile, cell));
      parts.push({from: at, to: end, tile, key: `${board} ${scope ?? 'legacy'} ${cell} ${tile}${sourceWork ? ' work' : ''}${meters ? ' '+JSON.stringify(meters) : ''}`, eligible: at === tileStart(tile, cell) && end === tileEnd(tile, cell) && end <= now && at >= oldest});
      at = end;
    }
    const workKey = ((scope !== 'budget'||sourceWork) && parts.some(p => p.eligible) ? (work!.authority??this.store.workKey(board, shown,access!,work!.reserve,work!.release))+JSON.stringify([...shown]) : '') + (meters ? this.store.financialKey(board) : '');
    for (const part of parts) {
      const hit = part.eligible ? this.kept.get(part.key) : undefined;
      if (hit?.workKey !== workKey||now>=hit.validUntil) continue;
      part.json = hit.json;
      this.kept.delete(part.key);
      this.kept.set(part.key, hit);
    }
    for (let i = 0; i < parts.length;) {
      if (parts[i].json !== undefined) {i++; continue;}
      const start = i;
      while (i < parts.length && parts[i].json === undefined) i++;
      const reservation=this.reservation();
      let chunks:Chunk<number>[];
      try{chunks=this.store.cells(board,cell,parts[start].from,parts[i-1].to,{now,shown,meters,scope,work,sourceWork,reserve:reservation.add});}finally{reservation.close();}
      chunks.forEach((raw, offset) => {
        const part = parts[start + offset];
        const chunk: Chunk = {...raw, activity: {...raw.activity, sessions: raw.activity.sessions.map(([id,source,project,device,sourceStatus])=>[this.fragmentRef(board,id,source,sourceStatus),source,project,device,sourceStatus,this.ref(board,id)])}};
        const json = (part.json = compactJSON(chunk));
        if (meters && Buffer.byteLength(json) > this.budget / 2) throw new HistoryLimit();
        if (part.eligible) {
          this.drop(part.key);
          const bytes=Buffer.byteLength(json)+256+devices.size*128+users.size*128+sources.size*128+workKey.length*2+part.key.length*2;
          const validUntil=(chunk.plans??[]).reduce((next,row)=>Math.min(next,planRowDeadline(row)),Infinity);
          this.kept.set(part.key, {owner:this.store.privateOwner(board),devices,users,scope,sourceWork,workKey,sources,cell,tile:part.tile,json,bytes,validUntil});
          this.bytes += bytes;
          this.makeRoom(0);
        }
      });
    }
    const result=parts.map(p => p.json!);
    if(meters && result.reduce((sum,json)=>sum+Buffer.byteLength(json),0)>this.budget/2)throw new HistoryLimit();
    return result;
    }finally{reservation?.close();}
  }
}
