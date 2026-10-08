import type {Conversion, RateLeg} from '../../server/domain/currency';
import type {MeterSemantics} from '../../server/domain/meters';
import type {Preparation} from './prepare';

type Encoded = Omit<MeterSemantics, 'conversion'> & {conversion?: Omit<Conversion, 'rate' | 'steps'> & {rate: number; steps?: number[]}};
type Entry = {text: string; references: number; children: number[]; bytes: number};

/** Cells share immutable semantics and rate legs; references belong to one tile version. */
export class MeterMetadata {
  private readonly entries = new Map<number, Entry>();
  private readonly ids = new Map<string, number>();
  private next = 1;
  bytes = 0;

  *clonePrepared(): Preparation<MeterMetadata> {
    const copy = new MeterMetadata();
    copy.next = this.next; copy.bytes = this.bytes;
    for (const [id, entry] of this.entries) {copy.entries.set(id, {...entry}); copy.ids.set(entry.text, id); yield;}
    return copy;
  }

  private retain(value: unknown, children: number[] = []): number {
    const text = JSON.stringify(value), found = this.ids.get(text);
    if (found !== undefined) {
      this.entries.get(found)!.references++;
      for (const child of children) this.release(child);
      return found;
    }
    const id = this.next++, bytes = 160 + text.length * 2 + children.length * 8;
    this.entries.set(id, {text, children, bytes, references: 1}); this.ids.set(text, id); this.bytes += bytes;
    return id;
  }

  release(id: number) {
    const entry = this.entries.get(id)!;
    if (--entry.references) return;
    this.entries.delete(id); this.ids.delete(entry.text); this.bytes -= entry.bytes;
    for (const child of entry.children) this.release(child);
  }

  retainSemantics(value: MeterSemantics | null, references: Set<number>): number | null {
    if (!value) return null;
    const children: number[] = [];
    const leg = (value: RateLeg) => {const id = this.retain(value); children.push(id); return id;};
    const {conversion, ...semantics} = value;
    const encoded: Encoded = {...semantics, ...(conversion ? {conversion: {original: conversion.original, rate: leg(conversion.rate), ...(conversion.steps ? {steps: conversion.steps.map(leg)} : {})}} : {})};
    const id = this.retain(encoded, children);
    if (references.has(id)) this.release(id); else references.add(id);
    return id;
  }

  semantics(id: number | null): MeterSemantics | null {
    if (id === null) return null;
    const encoded = JSON.parse(this.entries.get(id)!.text) as Encoded;
    const leg = (id: number) => JSON.parse(this.entries.get(id)!.text) as RateLeg;
    const {conversion, ...semantics} = encoded;
    return {...semantics, ...(conversion ? {conversion: {original: conversion.original, rate: leg(conversion.rate), ...(conversion.steps ? {steps: conversion.steps.map(leg)} : {})}} : {})};
  }
}
