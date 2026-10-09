export type ValuePath=(string|number)[];
export type ValueChange=[number,unknown]|[number]|[number,number,number,unknown[]];

/** Exact JSON changes preserve strings, absent fields and entering or leaving array entries. */
export class ValueChanges {
  readonly paths:ValuePath[]=[];
  private readonly ids=new Map<string,number>();
  constructor(private readonly reserve:(bytes:number)=>void) {}
  pathId(path:ValuePath){const key=JSON.stringify(path),old=this.ids.get(key);if(old!==undefined)return old;this.reserve(key.length*6+96);const id=this.paths.length;this.ids.set(key,id);this.paths.push(path);return id;}
  between(before:unknown,after:unknown,path:ValuePath=[],output:ValueChange[]=[]):ValueChange[] {
    if(Object.is(before,after))return output;
    if(Array.isArray(before)&&Array.isArray(after)&&before.length!==after.length){
      // Boundary points enter or leave while the other exact points stay unchanged.
      let first=0,last=0;const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
      while(first<Math.min(before.length,after.length)&&equal(before[first],after[first]))first++;
      while(last<Math.min(before.length,after.length)-first&&equal(before[before.length-last-1],after[after.length-last-1]))last++;
      output.push([this.pathId(path),first,before.length-first-last,after.slice(first,after.length-last)]);return output;
    }
    if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)&&(!Array.isArray(before)||before.length===(after as unknown[]).length)){
      const a=before as Record<string,unknown>,b=after as Record<string,unknown>;
      for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
        const next=[...path,Array.isArray(before)?Number(key):key];
        if(b[key]===undefined){if(a[key]!==undefined)output.push([this.pathId(next)]);}
        else if(a[key]===undefined)output.push([this.pathId(next),b[key]]);
        else this.between(a[key],b[key],next,output);
      }
    }else output.push([this.pathId(path),after]);
    return output;
  }
}

export function valueLeaf(value:unknown,path:ValuePath):[Record<string|number,unknown>,string|number] {
  let part=value as Record<string|number,unknown>;for(const key of path.slice(0,-1))part=part[key] as typeof part;
  return [part,path.at(-1)!];
}
export function applyValueChanges(value:unknown,paths:ValuePath[],changes:ValueChange[]) {
  for(const change of changes){const [parent,key]=valueLeaf(value,paths[change[0]]);if(change.length===1)delete parent[key];else if(change.length===4)(parent[key] as unknown[]).splice(change[1],change[2],...structuredClone(change[3]));else parent[key]=structuredClone(change[1]);}
}
