export type ValuePath=(string|number)[];
export type ValueChange=[number,unknown]|[number]|[number,number,0]|[number,number,number,unknown[]];
type Advance={amount?:number;children?:Map<string,Advance>};

function equal(before:unknown,after:unknown,advance?:Advance):boolean {
  if(advance?.amount!==undefined)before=(before as number)+advance.amount;
  if(Object.is(before,after)&&!advance?.children)return true;
  if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)!==Array.isArray(after))return false;
  if(Array.isArray(before)&&before.length!==(after as unknown[]).length)return false;
  const a=before as Record<string,unknown>,b=after as Record<string,unknown>;
  for(const key of Object.keys(a))if(!equal(a[key],Object.hasOwn(b,key)?b[key]:undefined,advance?.children?.get(key)))return false;
  for(const key of Object.keys(b))if((!Object.hasOwn(a,key)||a[key]===undefined)&&b[key]!==undefined)return false;
  return true;
}

/** Exact JSON changes preserve strings, absent fields and entering or leaving array entries. */
export class ValueChanges {
  readonly paths:ValuePath[]=[];
  private readonly ids=new Map<string,number>();
  constructor(private readonly reserve:(bytes:number)=>void) {}
  pathId(path:ValuePath){const key=JSON.stringify(path),old=this.ids.get(key);if(old!==undefined)return old;this.reserve(key.length*6+96);const id=this.paths.length;this.ids.set(key,id);this.paths.push(path);return id;}
  between(before:unknown,after:unknown,path:ValuePath=[],output:ValueChange[]=[]):ValueChange[] {
    return this.compare(before,after,path,output);
  }
  /** Compare the predicted numbers in place, without copying the preceding summary. */
  advanced(before:unknown,after:unknown,steps:readonly (readonly [number,number])[],offset:number):ValueChange[] {
    if(!offset||!steps.length)return this.between(before,after);
    const advance:Advance={};
    for(const [id,step] of steps){let node=advance;for(const part of this.paths[id]){const key=String(part);node.children??=new Map();let child=node.children.get(key);if(!child)node.children.set(key,child={});node=child;}node.amount=step*offset;}
    return this.compare(before,after,[],[],advance);
  }
  private compare(before:unknown,after:unknown,path:ValuePath,output:ValueChange[],advance?:Advance):ValueChange[] {
    if(advance?.amount!==undefined)before=(before as number)+advance.amount;
    if(Object.is(before,after)&&!advance?.children)return output;
    if(typeof before==='number'&&typeof after==='number'&&Number.isSafeInteger(before)&&Number.isSafeInteger(after)&&Number.isSafeInteger(after-before)&&String(after-before).length+2<String(after).length){
      output.push([this.pathId(path),after-before,0]);return output;
    }
    if(Array.isArray(before)&&Array.isArray(after)&&before.length!==after.length){
      // Boundary points enter or leave while the other exact points stay unchanged.
      let first=0,last=0;
      while(first<Math.min(before.length,after.length)&&equal(before[first],after[first],advance?.children?.get(String(first))))first++;
      while(last<Math.min(before.length,after.length)-first&&equal(before[before.length-last-1],after[after.length-last-1],advance?.children?.get(String(before.length-last-1))))last++;
      output.push([this.pathId(path),first,before.length-first-last,after.slice(first,after.length-last)]);return output;
    }
    if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)&&(!Array.isArray(before)||before.length===(after as unknown[]).length)){
      const a=before as Record<string,unknown>,b=after as Record<string,unknown>;
      for(const key of Object.keys(a)){
        const next=[...path,Array.isArray(before)?Number(key):key];
        if(!Object.hasOwn(b,key)||b[key]===undefined){if(a[key]!==undefined)output.push([this.pathId(next)]);}
        else if(a[key]===undefined)output.push([this.pathId(next),b[key]]);
        else this.compare(a[key],b[key],next,output,advance?.children?.get(key));
      }
      for(const key of Object.keys(b))if(!Object.hasOwn(a,key)&&b[key]!==undefined)output.push([this.pathId([...path,Array.isArray(before)?Number(key):key]),b[key]]);
    }else output.push([this.pathId(path),after]);
    return output;
  }
}

export function valueLeaf(value:unknown,path:ValuePath):[Record<string|number,unknown>,string|number] {
  let part=value as Record<string|number,unknown>;for(const key of path.slice(0,-1))part=part[key] as typeof part;
  return [part,path.at(-1)!];
}
export function applyValueChanges(value:unknown,paths:ValuePath[],changes:ValueChange[]) {
  for(const change of changes){const [parent,key]=valueLeaf(value,paths[change[0]]);if(change.length===1)delete parent[key];else if(change.length===4)(parent[key] as unknown[]).splice(change[1],change[2],...structuredClone(change[3]));else if(change.length===3)parent[key]=(parent[key] as number)+change[1];else parent[key]=structuredClone(change[1]);}
}
