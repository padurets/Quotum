import type {Conversion, RateLeg} from '../../server/domain/currency';
import type {MeterSemantics} from '../../server/domain/meters';
import type {Preparation} from './prepare';

type Encoded = [semantics:number,conversion?:[original:number,amount:string,at:number,rate:number,steps?:number[]]];
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
    const keep = (value: unknown) => {const id = this.retain(value); children.push(id); return id;};
    const {conversion, ...semantics} = value;
    const encoded:Encoded=[keep(semantics)];
    if(conversion){const {amount,at,...original}=conversion.original;encoded.push([keep(original),amount,at,keep(conversion.rate),...(conversion.steps?[conversion.steps.map(keep)]:[])] as NonNullable<Encoded[1]>);}
    const id = this.retain(encoded, children);
    if (references.has(id)) this.release(id); else references.add(id);
    return id;
  }

  semantics(id: number | null): MeterSemantics | null {
    if (id === null) return null;
    const encoded = JSON.parse(this.entries.get(id)!.text) as Encoded;
    const leg = (id: number) => JSON.parse(this.entries.get(id)!.text) as RateLeg;
    const semantics=JSON.parse(this.entries.get(encoded[0])!.text) as Omit<MeterSemantics,'conversion'>,conversion=encoded[1];
    if(!conversion)return semantics;
    const [original,amount,at,rate,steps]=conversion;
    return {...semantics,conversion:{original:{...JSON.parse(this.entries.get(original)!.text) as Omit<Conversion['original'],'amount'|'at'>,amount,at},rate:leg(rate),...(steps?{steps:steps.map(leg)}:{})}};
  }
}
