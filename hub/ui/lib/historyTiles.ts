import {decodeCellsPrepared, encodeCellsPrepared, TILE_CELLS, type Chunk, type DecodedCell, type HistoryMeta} from '../../server/domain/history';

import {drain, type Preparation} from './prepare';

const FIELDS = 11;
const HEAD = 248; // 61 uint32 offsets, padded to a float64 boundary.
type PackedSeries = {source: string; window: string; values: Float64Array};
type Session = Chunk['activity']['sessions'][number];
type Group = ['s' | 'p' | 'd', string];

/** A tile owns one buffer per series and one for sparse activity, without cell objects. */
export class HistoryTile {
  readFrom: number;
  validTo: number;
  readTo: number;
  writeSeq = 0;
  shownAt = 0;
  private readonly series = new Map<string, PackedSeries>();
  private seriesBytes = 0;
  private sessions: Session[] = [];
  private groups: Group[] = [];
  private readonly devices: Record<string, string> = {};
  private activity = new ArrayBuffer(HEAD);
  private resets: Chunk['resets'] = [];
  private grants: Chunk['grants'] = [];

  constructor(readonly from: number, readonly cell: number) {
    this.readFrom = this.validTo = this.readTo = from;
  }

  get to() {return this.from + TILE_CELLS * this.cell;}

  get bytes() {
    return this.activity.byteLength + this.seriesBytes + this.sessions.length * 320 + this.groups.length * 192 + (this.resets.length + this.grants.length) * 192 + 1024;
  }

  /** A private COW tile keeps every published buffer untouched until response commit. */
  *staged(chunk: Chunk, known: HistoryMeta['known']): Preparation<HistoryTile> {
    const copy = new HistoryTile(this.from, this.cell);
    copy.readFrom = this.readFrom; copy.readTo = this.readTo; copy.validTo = this.validTo;
    copy.writeSeq = this.writeSeq; copy.shownAt = this.shownAt;
    for (const [key, series] of this.series) {copy.series.set(key, series); copy.seriesBytes += series.values.byteLength + 256; yield;}
    for (const session of this.sessions) {copy.sessions.push(session); yield;}
    for (const group of this.groups) {copy.groups.push(group); yield;}
    for (const key in this.devices) {copy.devices[key] = this.devices[key]; yield;}
    copy.activity = this.activity; copy.resets = this.resets; copy.grants = this.grants;
    yield* copy.mergePrepared(chunk, known);
    return copy;
  }

  merge(chunk: Chunk, known: HistoryMeta['known']) {drain(this.mergePrepared(chunk, known));}

  private *mergePrepared(chunk: Chunk, known: HistoryMeta['known']): Preparation<void> {
    const first = (chunk.from - this.from) / this.cell;
    const last = (chunk.to - this.from) / this.cell;
    for (const [key, s] of this.series) {
      const values = new Float64Array(s.values.length);
      for (let i = 0; i < values.length; i += FIELDS) {values.set(s.values.subarray(i, i + FIELDS), i); yield;}
      for (let i = first; i < last; i++) {values.fill(NaN, i * FIELDS, (i + 1) * FIELDS); yield;}
      this.series.set(key, {...s, values});
    }
    for (const s of chunk.series) {
      const key = `${s.source} ${s.window}`;
      let packed = this.series.get(key);
      if (!packed) {
        const values = new Float64Array(TILE_CELLS * FIELDS);
        values.fill(NaN);
        this.series.set(key, (packed = {source: s.source, window: s.window, values}));
        this.seriesBytes += values.byteLength + 256;
      }
      const since = Math.max(known.work, known.sources[s.source] ?? Infinity);
      for (const v of yield* decodeCellsPrepared(s, chunk.from, this.cell, since)) {
        yield;
        const i = (v.at - this.from) / this.cell * FIELDS;
        packed.values.set([v.low, v.first, v.last, v.open ?? NaN, +v.gap, v.hold, v.spent, v.covered, ...v.work], i);
      }
    }
    for (const [key, s] of this.series) {
      let kept = false;
      for (let i = 0; i < s.values.length; i += FIELDS) {yield; if (!Number.isNaN(s.values[i])) {kept = true; break;}}
      if (!kept) {this.series.delete(key); this.seriesBytes -= s.values.byteLength + 256;}
    }
    const rows = yield* this.activityRowsPrepared();
    const translated: number[] = [];
    const sessionIndexes = new Map<string, number>();
    for (let i = 0; i < this.sessions.length; i++) {sessionIndexes.set(this.sessions[i][0], i); yield;}
    for (const session of chunk.activity.sessions) {
      let index = sessionIndexes.get(session[0]);
      const snapshot: Session = [...session];
      if (index === undefined) {index = this.sessions.push(snapshot) - 1; sessionIndexes.set(session[0], index);}
      else this.sessions[index] = snapshot;
      translated.push(index); yield;
    }
    for (const key in chunk.activity.devices) {this.devices[key] = chunk.activity.devices[key]; yield;}
    const groupIndexes = new Map<string, number>();
    for (let i = 0; i < this.groups.length; i++) {groupIndexes.set(JSON.stringify(this.groups[i]), i); yield;}
    for (let i = first; i < last; i++) rows[i] = [];
    for (const [i, active, members, groups] of chunk.activity.cells) {
      const row = [active, members.length];
      for (const member of members) {
        yield;
        const [index, ms] = typeof member === 'number' ? [member, active] : member;
        row.push(translated[index], ms);
      }
      row.push(groups.length);
      for (const [dim, key, ms] of groups) {
        yield;
        const id = JSON.stringify([dim, key]);
        let index = groupIndexes.get(id);
        if (index === undefined) {index = this.groups.push([dim, key]) - 1; groupIndexes.set(id, index);}
        row.push(index, ms);
      }
      rows[first + i] = row;
    }
    yield* this.compact(rows);
    let size = 0;
    for (const row of rows) {size += row.length; yield;}
    this.activity = new ArrayBuffer(HEAD + size * 8);
    const offsets = new Uint32Array(this.activity, 0, 61);
    const values = new Float64Array(this.activity, HEAD);
    let at = 0;
    for (let i = 0; i < rows.length; i++) {offsets[i] = at; for (const value of rows[i]) {values[at++] = value; yield;}}
    offsets[60] = at;
    const resets: Chunk['resets'] = [], grants: Chunk['grants'] = [];
    for (const row of this.resets) {if (row[2] < chunk.from || row[2] >= chunk.to) resets.push(row); yield;}
    for (const row of chunk.resets) {resets.push([...row]); yield;}
    for (const row of this.grants) {if (row[1] < chunk.from || row[1] >= chunk.to) grants.push(row); yield;}
    for (const row of chunk.grants) {grants.push([...row]); yield;}
    this.resets = resets; this.grants = grants;
  }

  /** References in all retained rows survive, including a suffix not yet read in this epoch. */
  private *compact(rows: number[][]): Preparation<void> {
    const sessions: Session[] = [], groups: Group[] = [];
    const sessionIndexes = new Map<number, number>(), groupIndexes = new Map<number, number>();
    const devices = new Set<string>();
    for (const row of rows) {
      if (!row.length) continue;
      let at = 2;
      for (let n = 0; n < row[1]; n++, at += 2) {
        yield;
        const old = row[at];
        if (!sessionIndexes.has(old)) {
          sessionIndexes.set(old, sessions.length);
          const session = this.sessions[old];
          sessions.push(session); devices.add(session[3]);
        }
        row[at] = sessionIndexes.get(old)!;
      }
      const count = row[at++];
      for (let n = 0; n < count; n++, at += 2) {
        yield;
        const old = row[at];
        if (!groupIndexes.has(old)) {
          groupIndexes.set(old, groups.length);
          const group = this.groups[old];
          groups.push(group);
          if (group[0] === 'd') devices.add(group[1]);
        }
        row[at] = groupIndexes.get(old)!;
      }
    }
    this.sessions = sessions; this.groups = groups;
    for (const device in this.devices) {if (!devices.has(device)) delete this.devices[device]; yield;}
  }

  private *activityRowsPrepared(): Preparation<number[][]> {
    const offsets = new Uint32Array(this.activity, 0, 61);
    const values = new Float64Array(this.activity, HEAD);
    const rows: number[][] = [];
    for (let i = 0; i < 60; i++) {const row: number[] = []; for (let j = offsets[i]; j < offsets[i + 1]; j++) {row.push(values[j]); yield;} rows.push(row);}
    return rows;
  }

  /** Only the read interval is materialized; old epoch data stays held until replaced. */
  chunk(known: HistoryMeta['known'], plot = false): Chunk {return drain(this.chunkPrepared(known, plot));}

  *chunkPrepared(known: HistoryMeta['known'], plot = false): Preparation<Chunk> {
    const first = (this.readFrom - this.from) / this.cell;
    const chunk: Chunk = {from: this.readFrom, to: this.readTo, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []};
    for (const session of this.sessions) {chunk.activity.sessions.push([...session]); yield;}
    for (const key in this.devices) {chunk.activity.devices[key] = this.devices[key]; yield;}
    for (const row of this.resets) {if (row[2] >= this.readFrom && row[2] < this.readTo) chunk.resets.push([...row]); yield;}
    for (const row of this.grants) {if (row[1] >= this.readFrom && row[1] < this.readTo) chunk.grants.push([...row]); yield;}
    for (const s of this.series.values()) {
      if (plot) {
        const cells: Chunk['series'][number]['cells'] = [];
        for (let i = first; this.from + i * this.cell < this.readTo; i++) {
          yield;
          const at = i * FIELDS;
          if (Number.isNaN(s.values[at])) continue;
          cells.push([i - first, s.values[at], 0, 0, {g: s.values[at + 4] ? 1 : undefined, h: s.values[at + 5]}]);
        }
        if (cells.length) chunk.series.push({source: s.source, window: s.window, hold: 0, open: null, cells});
        continue;
      }
      const cells: DecodedCell[] = [];
      for (let i = first; this.from + i * this.cell < this.readTo; i++) {
          yield;
        const at = i * FIELDS;
        if (Number.isNaN(s.values[at])) continue;
        const v = s.values.subarray(at, at + FIELDS);
        cells.push({at: this.from + i * this.cell, low: v[0], first: v[1], last: v[2], open: Number.isNaN(v[3]) ? null : v[3], gap: !!v[4], hold: v[5], spent: v[6], covered: v[7], work: [v[8], v[9], v[10]]});
      }
      if (cells.length) chunk.series.push(yield* encodeCellsPrepared(s.source, s.window, this.readFrom, this.cell, Math.max(known.work, known.sources[s.source] ?? Infinity), cells));
    }
    const rows = yield* this.activityRowsPrepared();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.length || i < first || this.from + i * this.cell >= this.readTo) continue;
      const [active, count] = row;
      const members: Chunk['activity']['cells'][number][2] = [];
      let at = 2;
      for (let n = 0; n < count; n++, at += 2) {members.push(row[at + 1] === active ? row[at] : [row[at], row[at + 1]]); yield;}
      const groupCount = row[at++];
      const groups: Chunk['activity']['cells'][number][3] = [];
      for (let n = 0; n < groupCount; n++, at += 2) {groups.push([...this.groups[row[at]], row[at + 1]]); yield;}
      chunk.activity.cells.push([i - first, active, members, groups]);
    }
    return chunk;
  }
}
