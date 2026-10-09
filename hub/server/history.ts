import {createHmac, randomBytes} from 'node:crypto';
import {config} from './config.js';
import {tileEnd, tileOf, tileStart, type Chunk, type HistoryBasis, type HistoryScope} from './domain/history.js';
import type {Shown, Store, WorkRead} from './store/store.js';
import type {MeterSelection} from './domain/meterHistory.js';

export class HistoryLimit extends Error { constructor() {super('history_limit');} }

type Kept = {scope?: HistoryScope; workKey: string; sources: Set<string>; cell: number; tile: number; json: string; bytes: number};

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
  private bytes = 0;
  private retentionRevision = 0;
  private reserved = 0;

  constructor(private readonly store: Store, private readonly budget = 32 * 1024 * 1024) {}

  metadata(board: string, value: Omit<HistoryBasis, 'now' | 'meta'>, scope?: HistoryScope) {
    return createHmac('sha256', this.key).update(`meta:${board}:${scope ?? 'legacy'}:${JSON.stringify(value)}`).digest('base64url');
  }

  ref(board: string, session: number) {
    return createHmac('sha256', this.key).update(`${board}:${session}`).digest('base64url').slice(0, 8);
  }

  /** Request projections share the tile budget and release their reservation on every exit. */
  reservation() {
    let used = 0;
    return {
      add: (bytes: number) => {
        if (bytes + this.reserved > this.budget) throw new HistoryLimit();
        while (this.bytes + this.reserved + bytes > this.budget && this.kept.size) this.drop(this.kept.keys().next().value!);
        this.reserved += bytes; used += bytes;
      },
      remove: (bytes: number) => {if(bytes<0||bytes>used)throw new Error('invalid_reservation');this.reserved-=bytes;used-=bytes;},
      close: () => {this.reserved -= used; used = 0;},
    };
  }

  touch(source: string, since: number, scopes?: readonly HistoryScope[]) {
    for (const [key, tile] of this.kept) if ((!tile.scope || !scopes || scopes.includes(tile.scope)) && tile.sources.has(source) && tileEnd(tile.tile, tile.cell) > since) this.drop(key);
  }

  private drop(key: string) {
    const tile = this.kept.get(key);
    if (tile) this.bytes -= tile.bytes;
    this.kept.delete(key);
  }

  /** JSON is stored as sent, so hits do not allocate or serialize all the cells again. */
  read(board: string, cell: number, from: number, to: number, now: number, shown: Shown, meters?: MeterSelection, scope?: HistoryScope, work?: WorkRead): string[] {
    if (this.retentionRevision !== this.store.retentionRevision) {
      this.kept.clear();
      this.bytes = 0;
      this.retentionRevision = this.store.retentionRevision;
    }
    const sources = new Set(this.store.sources(board).map(s => s.id));
    const oldest = now - (config.retention.sampleDays - 1) * 86_400_000;
    const parts: {from: number; to: number; tile: number; key: string; eligible: boolean; json?: string}[] = [];
    for (let at = from; at < to;) {
      const tile = tileOf(at, cell);
      const end = Math.min(to, tileEnd(tile, cell));
      parts.push({from: at, to: end, tile, key: `${board} ${scope ?? 'legacy'} ${cell} ${tile}${meters ? ' '+JSON.stringify(meters) : ''}`, eligible: at === tileStart(tile, cell) && end === tileEnd(tile, cell) && end <= now && at >= oldest});
      at = end;
    }
    const workKey = (scope !== 'budget' && parts.some(p => p.eligible) ? this.store.workKey(board, shown) : '') + (meters ? this.store.financialKey(board) : '');
    for (const part of parts) {
      const hit = part.eligible ? this.kept.get(part.key) : undefined;
      if (hit?.workKey !== workKey) continue;
      part.json = hit.json;
      this.kept.delete(part.key);
      this.kept.set(part.key, hit);
    }
    for (let i = 0; i < parts.length;) {
      if (parts[i].json !== undefined) {i++; continue;}
      const start = i;
      while (i < parts.length && parts[i].json === undefined) i++;
      const chunks = this.store.cells(board, cell, parts[start].from, parts[i - 1].to, {now, shown, meters, scope, work});
      chunks.forEach((raw, offset) => {
        const part = parts[start + offset];
        const chunk: Chunk = {...raw, activity: {...raw.activity, sessions: raw.activity.sessions.map(([id, ...rest]) => [this.ref(board, id), ...rest])}};
        const json = (part.json = compactJSON(chunk));
        if (meters && Buffer.byteLength(json) > this.budget / 2) throw new HistoryLimit();
        if (part.eligible) {
          this.drop(part.key);
          const bytes = Buffer.byteLength(json);
          this.kept.set(part.key, {scope, workKey, sources, cell, tile: part.tile, json, bytes});
          this.bytes += bytes;
          while (this.bytes + this.reserved > this.budget && this.kept.size) this.drop(this.kept.keys().next().value!);
        }
      });
    }
    const result=parts.map(p => p.json!);
    if(meters && result.reduce((sum,json)=>sum+Buffer.byteLength(json),0)>this.budget/2)throw new HistoryLimit();
    return result;
  }
}
