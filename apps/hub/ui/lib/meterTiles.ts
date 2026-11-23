import {
  meterIdentity,
  type MeterCell,
  type MeterSeriesCells,
} from '../../server/domain/meterHistory';
import type {ExceptionalStep, MeterSemantics} from '../../server/domain/meters';
import {TILE_CELLS} from '../../server/domain/history';
import {drain, type Preparation} from './prepare';
import {MeterMetadata, type SemanticsRef} from './meterMetadata';

type StoredCell = {row: MeterCell; before: MeterSemantics | null; semantics: MeterSemantics | null};
type UnpackedCell = {row: MeterCell; before: SemanticsRef; semantics: SemanticsRef};
type Series = Omit<MeterSeriesCells, 'cells' | 'semantics'>;
type Packed = {
  series: Series;
  first: number;
  // Each boundary holds the byte and dictionary-reference offsets of the next cell.
  offsets: Uint32Array;
  data: Uint8Array;
  references: Uint32Array;
};
const packedSize = (offsets: number, data: number, references: number) =>
  256 + 3 * 128 + (offsets + references) * Uint32Array.BYTES_PER_ELEMENT + data;
const packedBytes = (packed: Packed) =>
  packedSize(packed.offsets.length, packed.data.length, packed.references.length);
const boundary = (packed: Packed, cell: number) =>
  Math.max(0, Math.min(packed.offsets.length / 2 - 1, Math.ceil(cell) - packed.first)) * 2;
function removablePrefix(packed: Packed, pos: number, headroom: number) {
  const end = packed.offsets[pos],
    removed = end + packed.offsets[pos + 1] * 4 + pos * 4;
  // Whole unseen series need no copy. Keep any larger overlapping series charged
  // and let the tile's read boundary exclude its unvisited cells.
  return end === packed.data.length || packedBytes(packed) - removed <= headroom ? removed : 0;
}
const cellBytes = (packed: Packed, pos: number) =>
  packed.data.subarray(packed.offsets[pos], packed.offsets[pos + 2]);
type Staging = {metadata: MeterMetadata; bytes: number};
type PendingCell = StoredCell & {references: Set<number>};
type EncodedExtra = Omit<
  NonNullable<MeterCell[5]>,
  'semantics' | 'openSemantics' | 'observations'
> & {openSemantics?: SemanticsRef};
type PackedRow = [
  value: string,
  coveredMs: number,
  extra: Record<string, unknown>,
  spentInternal?: string | null,
  spentExceptional?: string,
];
type PackedHeader = [
  before: SemanticsRef,
  semantics: SemanticsRef,
  row: PackedRow,
  steps?: number,
  topupSteps?: number,
  observations?: number,
];
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const fields = [
  'pointOffsetMs',
  'openOffsetMs',
  'openSemantics',
  'validUntil',
  'first',
  'open',
  'segment',
  'knownFrom',
  'knownUntil',
  'topupInternal',
  'at',
  'value',
  'semantics',
  'from',
  'to',
  'amount',
  'evidence',
];
// Cell headers and interval leaves repeat the same field names thousands of times.
// Short local keys keep every value and unknown field without retaining those names.
const compact = (value: object) => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const index = fields.indexOf(key);
    result[index < 0 ? 'x:' + key : index] = (value as Record<string, unknown>)[key];
  }
  return result;
};
const expand = <T>(value: object): T =>
  Object.fromEntries(
    Object.entries(value).map(([key, value]) => [
      key.startsWith('x:') ? key.slice(2) : fields[Number(key)],
      value,
    ]),
  ) as T;

const sameSemantics = (a: SemanticsRef, b: SemanticsRef) =>
  a === b ||
  (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

// Dictionary IDs start at one. Zero in a secondary slot reuses the full opening reference.
const SAME_BEFORE = 0;
function readSemantics(metadata: MeterMetadata) {
  const templates = new Map<number, ReturnType<MeterMetadata['semantics']>>();
  return (ref: SemanticsRef): MeterSemantics | null => {
    if (ref === null) return null;
    const id = typeof ref === 'number' ? ref : ref[0];
    let template = templates.get(id);
    if (!template) {
      template = metadata.semantics(id);
      templates.set(id, template);
    }
    if (typeof ref === 'number') return template.base;
    const conversion = template.conversion!;
    return {
      ...template.base,
      conversion: {...conversion, original: {...conversion.original, amount: ref[1], at: ref[2]}},
    };
  };
}

// JSON.stringify escapes lone surrogates, so every high surrogate here starts a pair.
function utf8Length(text: string) {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < 0x800) bytes++;
    else {
      bytes += 2;
      if (code >= 0xd800 && code <= 0xdbff) i++;
    }
  }
  return bytes;
}

/** Measure and write the same frames directly from the response's observations. */
function* pack(
  cell: StoredCell,
  keep: (value: MeterSemantics | null) => SemanticsRef,
  frame: (text: string) => void,
): Preparation<void> {
  const before = keep(cell.before);
  const relative = (value: MeterSemantics | null) => {
    if (value === cell.before) return SAME_BEFORE;
    const ref = keep(value);
    return sameSemantics(ref, before) ? SAME_BEFORE : ref;
  };
  const {
    steps = [],
    topupSteps = [],
    observations,
    semantics: _semantics,
    openSemantics,
    ...extra
  } = cell.row[5] ?? {};
  // The series offsets locate the cell. Only write optional trailing fields through
  // their last supplied value, preserving unavailable spending and empty observations.
  const [, value, spentInternal, spentExceptional, coveredMs] = cell.row;
  const row: PackedRow = [
    value,
    coveredMs,
    compact({...extra, ...(openSemantics ? {openSemantics: relative(openSemantics)} : {})}),
  ];
  if (spentExceptional !== null) row.push(spentInternal, spentExceptional);
  else if (spentInternal !== null) row.push(spentInternal);
  const head: PackedHeader = [before, relative(cell.semantics), row];
  if (observations) head.push(steps.length, topupSteps.length, observations.length);
  else if (topupSteps.length) head.push(steps.length, topupSteps.length);
  else if (steps.length) head.push(steps.length);
  frame(JSON.stringify(head));
  yield;
  for (const values of [steps, topupSteps])
    for (const step of values) {
      frame(JSON.stringify(compact(step)));
      yield;
    }
  for (const point of observations ?? []) {
    frame(
      JSON.stringify(
        compact({...point, ...(point.semantics ? {semantics: relative(point.semantics)} : {})}),
      ),
    );
    yield;
  }
}
const header = (bytes: Uint8Array) => {
  const [before, semantics, row, steps = 0, topupSteps = 0, observations] = JSON.parse(
    decoder.decode(
      bytes.subarray(
        4,
        4 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0),
      ),
    ),
  ) as PackedHeader;
  return {
    before,
    semantics: semantics === SAME_BEFORE ? before : semantics,
    row,
    steps,
    topupSteps,
    observations,
  };
};
function* unpack(
  bytes: Uint8Array,
  index: number,
  read: ReturnType<typeof readSemantics>,
): Preparation<UnpackedCell> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    head = header(bytes);
  let at = 4 + view.getUint32(0);
  yield;
  const [value, coveredMs, fields, spentInternal = null, spentExceptional = null] = head.row;
  const {openSemantics, ...rest} = expand<EncodedExtra>(fields);
  const extra: NonNullable<MeterCell[5]> = {
    ...rest,
    ...(openSemantics === undefined
      ? {}
      : {openSemantics: read(openSemantics === SAME_BEFORE ? head.before : openSemantics)!}),
  };
  for (const [name, count] of [
    ['steps', head.steps],
    ['topupSteps', head.topupSteps],
  ] as const) {
    if (!count) continue;
    const steps: ExceptionalStep[] = [];
    for (let i = 0; i < count; i++) {
      const size = view.getUint32(at);
      steps.push(expand(JSON.parse(decoder.decode(bytes.subarray(at + 4, at + 4 + size)))));
      at += 4 + size;
      yield;
    }
    extra[name] = steps;
  }
  if (head.observations !== undefined) {
    const observations: NonNullable<typeof extra.observations> = [];
    for (let i = 0; i < head.observations; i++) {
      const size = view.getUint32(at),
        point = expand<
          Omit<NonNullable<typeof extra.observations>[number], 'semantics'> & {
            semantics?: SemanticsRef;
          }
        >(JSON.parse(decoder.decode(bytes.subarray(at + 4, at + 4 + size))));
      const {semantics, ...rest} = point;
      observations.push({
        ...rest,
        ...(semantics === undefined
          ? {}
          : {semantics: read(semantics === SAME_BEFORE ? head.before : semantics)}),
      });
      at += 4 + size;
      yield;
    }
    extra.observations = observations;
  }
  return {
    row: [index, value, spentInternal, spentExceptional, coveredMs, extra],
    before: head.before,
    semantics: head.semantics,
  };
}

// A retained cell may contain many intervals. Copy it in bounded pieces too.
function* copyPrepared(
  target: Uint8Array | Uint32Array,
  at: number,
  source: Uint8Array | Uint32Array,
): Preparation<void> {
  const block = (16 * 1024) / source.BYTES_PER_ELEMENT;
  for (let i = 0; i < source.length; i += block) {
    target.set(source.subarray(i, i + block), at + i);
    if (i + block < source.length) yield;
  }
}

/** Exact strings and interval metadata use byte buffers, within the shared tile budget. */
export class MeterTile {
  private series = new Map<string, Packed>();
  private metadata = new MeterMetadata();
  private seriesBytes = 0;
  private staging?: Staging;
  private shared = false;
  private readers = 0;
  share() {
    this.shared = true;
    return this;
  }
  prefixBytes(before: number, headroom = Infinity) {
    if (this.shared) return 0;
    let bytes = 0;
    for (const packed of this.series.values()) {
      const pos = boundary(packed, (before - this.from) / this.cell);
      bytes += removablePrefix(packed, pos, headroom);
    }
    return bytes;
  }
  /** Eviction releases only exclusively owned packed cells, never a published reading. */
  discardPrefix(before: number, headroom = Infinity) {
    if (this.shared || this.readers || this.staging) return 0;
    const initial = this.bytes;
    for (const [key, packed] of this.series) {
      const pos = boundary(packed, (before - this.from) / this.cell);
      if (!removablePrefix(packed, pos, headroom)) continue;
      const byteEnd = packed.offsets[pos],
        refsEnd = packed.offsets[pos + 1];
      if (byteEnd === packed.data.length) {
        this.series.delete(key);
      } else {
        // Suffix views would still own the entire old buffers.
        const offsets = packed.offsets.slice(pos);
        for (let i = 0; i < offsets.length; i += 2) {
          offsets[i] -= byteEnd;
          offsets[i + 1] -= refsEnd;
        }
        const kept = {
          ...packed,
          first: packed.first + pos / 2,
          data: packed.data.slice(byteEnd),
          references: packed.references.slice(refsEnd),
          offsets,
        };
        this.series.set(key, kept);
        this.seriesBytes += packedBytes(kept);
      }
      for (let i = 0; i < refsEnd; i++) this.metadata.release(packed.references[i]);
      this.seriesBytes -= packedBytes(packed);
    }
    return initial - this.bytes;
  }
  constructor(
    private readonly from: number,
    private readonly cell: number,
  ) {}
  get bytes() {
    return (
      this.metadata.bytes +
      this.seriesBytes +
      (this.staging ? this.staging.bytes + this.staging.metadata.bytes : 0)
    );
  }
  /** Charge private backing buffers and dictionary storage beside a pinned version. */
  measureBeside(held: MeterTile): () => number {
    if (this === held) return () => 0;
    let version: Map<string, Packed> | undefined,
      shared = 0;
    return () => {
      // A write publishes its map and dictionary together. During preparation only
      // scratch changes, so each slice can reuse the previous identity comparison.
      if (this.series !== version) {
        version = this.series;
        shared = this.metadata === held.metadata ? this.metadata.bytes : 0;
        if (this.series === held.series) shared += this.seriesBytes;
        else
          for (const [key, packed] of this.series)
            if (held.series.get(key) === packed) shared += packedBytes(packed);
      }
      return this.bytes - shared;
    };
  }

  *clonePrepared(): Preparation<MeterTile> {
    const copy = new MeterTile(this.from, this.cell);
    // Shared series and their dictionary remain immutable until the writer commits.
    if (this.series.size) {
      this.shared = true;
      copy.shared = true;
    }
    copy.metadata = this.metadata;
    copy.series = this.series;
    copy.seriesBytes = this.seriesBytes;
    return copy;
  }
  merge(from: number, to: number, series: readonly MeterSeriesCells[]) {
    drain(this.mergePrepared(from, to, series));
  }
  *mergePrepared(from: number, to: number, series: readonly MeterSeriesCells[]): Preparation<void> {
    const first = (from - this.from) / this.cell,
      last = (to - this.from) / this.cell;
    const incoming = new Map<string, MeterSeriesCells[]>();
    for (const s of series) {
      const key = meterIdentity(s),
        group = incoming.get(key);
      if (group) group.push(s);
      else incoming.set(key, [s]);
      yield;
    }
    if (!this.series.size && !incoming.size) return;
    const staged: Staging = {metadata: new MeterMetadata(), bytes: 0};
    this.staging = staged;
    try {
      // Copy the reference counts once for this whole write. Cancellation can then
      // discard the private dictionary and buffers immediately, even for a dense cell.
      yield* this.metadata.copyInto(staged.metadata);
      const series = new Map<string, Packed>();
      let bytes = 0;
      for (const key of new Set([...this.series.keys(), ...incoming.keys()])) {
        const old = this.series.get(key),
          next = yield* this.replaceSeries(old, first, last, incoming.get(key) ?? [], staged);
        if (next) {
          series.set(key, next);
          bytes += packedBytes(next);
        }
      }
      this.series = series;
      this.seriesBytes = bytes;
      this.metadata = staged.metadata;
    } finally {
      this.staging = undefined;
    }
  }
  private *replaceSeries(
    old: Packed | undefined,
    first: number,
    last: number,
    incoming: MeterSeriesCells[],
    staged: Staging,
  ): Preparation<Packed | undefined> {
    const cells: (number | PendingCell | undefined)[] = [];
    const left = old ? boundary(old, first) : 0,
      right = old ? boundary(old, last) : 0;
    if (old && !incoming.length && old.offsets[left] === old.offsets[right]) return old;
    const earlierBytes = staged.bytes;
    // At most one input row per tile cell. Superseded rows still advance the
    // opening semantics of their successor, but never acquire dictionary references.
    staged.bytes += 128 + TILE_CELLS * 8;
    if (old) {
      for (let pos = 0; pos + 2 < old.offsets.length; pos += 2) {
        if ((pos < left || pos >= right) && old.offsets[pos] !== old.offsets[pos + 2])
          cells[old.first + pos / 2] = pos;
        yield;
      }
    }
    for (const s of incoming) {
      let semantics = s.semantics;
      for (const row of s.cells) {
        const i = first + row[0];
        if (!Number.isInteger(i) || i < 0 || i >= TILE_CELLS || i < first || i >= last) {
          yield;
          continue;
        }
        if (cells[i] === undefined) staged.bytes += 256; // The row descriptor and its reference set.
        const before = semantics;
        semantics = row[5]?.semantics ?? semantics;
        cells[i] = {row, before, semantics, references: new Set()};
        yield;
      }
    }
    let start = cells.length,
      byteCount = 0,
      refCount = 0;
    for (const [i, cell] of cells.entries()) {
      if (cell === undefined) continue;
      start = Math.min(start, i);
      if (typeof cell === 'number') {
        const offsets = old!.offsets;
        byteCount += offsets[cell + 2] - offsets[cell];
        refCount += offsets[cell + 3] - offsets[cell + 1];
      } else {
        const keep = (value: MeterSemantics | null) => {
          const count = cell.references.size;
          const ref = staged.metadata.retainSemantics(value, cell.references);
          staged.bytes += (cell.references.size - count) * 8;
          return ref;
        };
        yield* pack(cell, keep, text => {
          byteCount += 4 + utf8Length(text);
        });
        refCount += cell.references.size;
      }
    }
    let next: Packed | undefined;
    if (byteCount) {
      const offsets = (cells.length - start + 1) * 2;
      // Admission runs at the yield, before any of the three backing stores exist.
      staged.bytes += packedSize(offsets, byteCount, refCount);
      yield;
      const s = old?.series ?? incoming[0];
      next = {
        series: old?.series ?? {
          source: s.source,
          meter: s.meter,
          kind: s.kind,
          unit: s.unit,
          accounting: s.accounting,
          role: s.role,
          pointMode: s.pointMode,
        },
        first: start,
        offsets: new Uint32Array(offsets),
        references: new Uint32Array(refCount),
        data: new Uint8Array(byteCount),
      };
      const data = next.data,
        view = new DataView(data.buffer);
      let at = 0,
        ref = 0;
      for (let i = start; i < cells.length; i++) {
        const cell = cells[i];
        if (typeof cell === 'number') {
          const bytes = cellBytes(old!, cell),
            refs = old!.references.subarray(old!.offsets[cell + 1], old!.offsets[cell + 3]);
          yield* copyPrepared(next.data, at, bytes);
          yield* copyPrepared(next.references, ref, refs);
          at += bytes.length;
          ref += refs.length;
        } else if (cell) {
          // A single template ID covers every non-null slot, including different
          // FX anchors. For mixed cells the same set keeps repeated lookups balanced.
          const id = cell.references.size === 1 ? cell.references.values().next().value : undefined;
          const keep = (value: MeterSemantics | null): SemanticsRef => {
            if (!value) return null;
            if (id === undefined) return staged.metadata.retainSemantics(value, cell.references);
            const original = value.conversion?.original;
            return original ? [id, original.amount, original.at] : id;
          };
          yield* pack(cell, keep, text => {
            const {written} = encoder.encodeInto(text, data.subarray(at + 4));
            view.setUint32(at, written);
            at += 4 + written;
          });
          for (const id of cell.references) {
            next.references[ref++] = id;
            yield;
          }
        }
        const pos = 2 * (i - start + 1);
        next.offsets[pos] = at;
        next.offsets[pos + 1] = ref;
        yield;
      }
    }
    if (old)
      for (let i = old.offsets[left + 1]; i < old.offsets[right + 1]; i++) {
        staged.metadata.release(old.references[i]);
        yield;
      }
    staged.bytes = earlierBytes + (next ? packedBytes(next) : 0);
    return next;
  }
  chunk(from: number, to: number): MeterSeriesCells[] {
    return drain(this.chunkPrepared(from, to));
  }
  *chunkPrepared(from: number, to: number): Preparation<MeterSeriesCells[]> {
    this.readers++;
    try {
      const first = (from - this.from) / this.cell,
        last = (to - this.from) / this.cell;
      const result: MeterSeriesCells[] = [];
      const read = readSemantics(this.metadata);
      for (const packed of this.series.values()) {
        const left = boundary(packed, first),
          right = boundary(packed, last);
        if (packed.offsets[left] === packed.offsets[right]) continue;
        let beforeRef: SemanticsRef = null;
        for (let pos = left - 2; pos >= 0; pos -= 2) {
          const bytes = cellBytes(packed, pos);
          if (bytes.length) {
            beforeRef = header(bytes).semantics;
            break;
          }
        }
        const cells: MeterCell[] = [];
        let semantics: SemanticsRef = null;
        for (let pos = left; pos < right; pos += 2) {
          const bytes = cellBytes(packed, pos);
          if (!bytes.length) continue;
          const c = yield* unpack(bytes, packed.first + pos / 2 - first, read),
            extra = c.row[5]!;
          if (!cells.length) {
            beforeRef ??= c.before;
            semantics = beforeRef;
          }
          if (!sameSemantics(c.semantics, semantics)) {
            const next = read(c.semantics);
            if (next) extra.semantics = next;
            semantics = c.semantics;
          }
          cells.push(c.row);
        }
        result.push({...packed.series, semantics: read(beforeRef), cells});
      }
      return result;
    } finally {
      this.readers--;
    }
  }
}
