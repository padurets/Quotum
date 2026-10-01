import {decodeCells, encodeCells, TILE_CELLS, type Chunk, type DecodedCell, type HistoryMeta} from '../../server/domain/history';
import {MeterTile} from './meterTiles';

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
  private sessions: Session[] = [];
  private groups: Group[] = [];
  private readonly devices: Record<string, string> = {};
  private activity = new ArrayBuffer(HEAD);
  private resets: Chunk['resets'] = [];
  private grants: Chunk['grants'] = [];
  private readonly meters: MeterTile;
  private hasMeters=false;

  constructor(readonly from: number, readonly cell: number) {
    this.readFrom = this.validTo = this.readTo = from;
    this.meters=new MeterTile(from,cell);
  }

  get to() {return this.from + TILE_CELLS * this.cell;}

  get bytes() {
    return this.activity.byteLength + this.meters.bytes + [...this.series.values()].reduce((sum, s) => sum + s.values.byteLength + 256, 0) + this.sessions.length * 320 + this.groups.length * 192 + (this.resets.length + this.grants.length) * 192 + 1024;
  }

  merge(chunk: Chunk, known: HistoryMeta['known']) {
    this.hasMeters ||= chunk.meterSeries!==undefined;
    this.meters.merge(chunk.from,chunk.to,chunk.meterSeries??[]);
    const first = (chunk.from - this.from) / this.cell;
    const last = (chunk.to - this.from) / this.cell;
    for (const s of this.series.values()) s.values.fill(NaN, first * FIELDS, last * FIELDS);
    for (const s of chunk.series) {
      const key = `${s.source} ${s.window}`;
      let packed = this.series.get(key);
      if (!packed) {
        const values = new Float64Array(TILE_CELLS * FIELDS);
        values.fill(NaN);
        this.series.set(key, (packed = {source: s.source, window: s.window, values}));
      }
      const since = Math.max(known.work, known.sources[s.source] ?? Infinity);
      for (const v of decodeCells(s, chunk.from, this.cell, since)) {
        const i = (v.at - this.from) / this.cell * FIELDS;
        packed.values.set([v.low, v.first, v.last, v.open ?? NaN, +v.gap, v.hold, v.spent, v.covered, ...v.work], i);
      }
    }
    for (const [key, s] of this.series) {
      let kept = false;
      for (let i = 0; i < s.values.length; i += FIELDS) if (!Number.isNaN(s.values[i])) {kept = true; break;}
      if (!kept) this.series.delete(key);
    }
    const rows = this.activityRows();
    const translated = chunk.activity.sessions.map(session => {
      let index = this.sessions.findIndex(s => s[0] === session[0]);
      if (index < 0) index = this.sessions.push(session) - 1;
      else this.sessions[index] = session;
      return index;
    });
    Object.assign(this.devices, chunk.activity.devices);
    for (let i = first; i < last; i++) rows[i] = [];
    for (const [i, active, members, groups] of chunk.activity.cells) {
      const row = [active, members.length];
      for (const member of members) {
        const [index, ms] = typeof member === 'number' ? [member, active] : member;
        row.push(translated[index], ms);
      }
      row.push(groups.length);
      for (const [dim, key, ms] of groups) {
        let index = this.groups.findIndex(g => g[0] === dim && g[1] === key);
        if (index < 0) index = this.groups.push([dim, key]) - 1;
        row.push(index, ms);
      }
      rows[first + i] = row;
    }
    this.compact(rows);
    this.activity = new ArrayBuffer(HEAD + rows.reduce((sum, row) => sum + row.length, 0) * 8);
    const offsets = new Uint32Array(this.activity, 0, 61);
    const values = new Float64Array(this.activity, HEAD);
    let at = 0;
    rows.forEach((row, i) => {offsets[i] = at; values.set(row, at); at += row.length;});
    offsets[60] = at;
    this.resets = [...this.resets.filter(([, , at]) => at < chunk.from || at >= chunk.to), ...chunk.resets];
    this.grants = [...this.grants.filter(([, at]) => at < chunk.from || at >= chunk.to), ...chunk.grants];
  }

  /** References in all retained rows survive, including a suffix not yet read in this epoch. */
  private compact(rows: number[][]) {
    const sessions: Session[] = [], groups: Group[] = [];
    const sessionIndexes = new Map<number, number>(), groupIndexes = new Map<number, number>();
    const devices = new Set<string>();
    for (const row of rows) {
      if (!row.length) continue;
      let at = 2;
      for (let n = 0; n < row[1]; n++, at += 2) {
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
    for (const device of Object.keys(this.devices)) if (!devices.has(device)) delete this.devices[device];
  }

  private activityRows(): number[][] {
    const offsets = new Uint32Array(this.activity, 0, 61);
    const values = new Float64Array(this.activity, HEAD);
    return Array.from({length: 60}, (_, i) => Array.from(values.subarray(offsets[i], offsets[i + 1])));
  }

  /** Only the read interval is materialized; old epoch data stays held until replaced. */
  chunk(known: HistoryMeta['known']): Chunk {
    const first = (this.readFrom - this.from) / this.cell;
    const chunk: Chunk = {from: this.readFrom, to: this.readTo, series: [], activity: {sessions: this.sessions, devices: this.devices, cells: []}, resets: this.resets.filter(([, , at]) => at >= this.readFrom && at < this.readTo), grants: this.grants.filter(([, at]) => at >= this.readFrom && at < this.readTo)};
    if(this.hasMeters)chunk.meterSeries=this.meters.chunk(this.readFrom,this.readTo);
    for (const s of this.series.values()) {
      const cells: DecodedCell[] = [];
      for (let i = first; this.from + i * this.cell < this.readTo; i++) {
        const at = i * FIELDS;
        if (Number.isNaN(s.values[at])) continue;
        const v = s.values.subarray(at, at + FIELDS);
        cells.push({at: this.from + i * this.cell, low: v[0], first: v[1], last: v[2], open: Number.isNaN(v[3]) ? null : v[3], gap: !!v[4], hold: v[5], spent: v[6], covered: v[7], work: [v[8], v[9], v[10]]});
      }
      if (cells.length) chunk.series.push(encodeCells(s.source, s.window, this.readFrom, this.cell, Math.max(known.work, known.sources[s.source] ?? Infinity), cells));
    }
    this.activityRows().forEach((row, i) => {
      if (!row.length || i < first || this.from + i * this.cell >= this.readTo) return;
      const [active, count] = row;
      const members: Chunk['activity']['cells'][number][2] = [];
      let at = 2;
      for (let n = 0; n < count; n++, at += 2) members.push(row[at + 1] === active ? row[at] : [row[at], row[at + 1]]);
      const groupCount = row[at++];
      const groups: Chunk['activity']['cells'][number][3] = [];
      for (let n = 0; n < groupCount; n++, at += 2) groups.push([...this.groups[row[at]], row[at + 1]]);
      chunk.activity.cells.push([i - first, active, members, groups]);
    });
    return chunk;
  }
}
