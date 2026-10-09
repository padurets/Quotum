import {MAX_ROWS} from './grid';

type Size = {min:number;natural:number};
type Report = Size & {shown:number};

/** Content measurements move grid boxes without rendering their contents. */
export class WidgetSizing {
  heights:Record<string,number>={};
  sizes:Record<string,Size>={};
  short=0;
  private readonly allocations=new Map<string,number>();
  private readonly listeners=new Map<string,Set<()=>void>>();
  constructor(private readonly same:(a:number|undefined,b:number|undefined)=>boolean){}
  report(id:string,size:Report|null) {
    const was=this.sizes[id];let changed=false;
    if(size? !this.same(was?.min,size.min)||!this.same(was?.natural,size.natural):!!was){
      if(size)this.sizes[id]={min:size.min,natural:size.natural};else delete this.sizes[id];
      changed=true;
    }
    if(size&&!this.same(this.heights[id],size.shown)){this.heights[id]=size.shown;changed=true;}
    return changed;
  }
  measure(next:Record<string,number>,short:number,release=false) {
    const old=this.heights;
    const kept=Object.fromEntries(Object.entries(next).map(([id,h])=>[id,this.same(old[id],h)||(release&&this.sizes[id]&&old[id]!==undefined)?old[id]:h]));
    let changed=Object.keys(kept).length!==Object.keys(old).length||Object.entries(kept).some(([id,h])=>old[id]!==h);
    if(changed)this.heights=kept;
    if(!this.same(this.short*MAX_ROWS,short*MAX_ROWS)){this.short=short;changed=true;}
    return changed;
  }
  allocated(id:string){return this.allocations.get(id)??0;}
  allocate(next:Map<string,number>){
    const changed:string[]=[];
    for(const id of new Set([...this.allocations.keys(),...next.keys()])){
      const value=next.get(id)??0;
      if(this.same(this.allocated(id),value))continue;
      if(next.has(id))this.allocations.set(id,value);else this.allocations.delete(id);
      changed.push(id);
    }
    for(const id of changed)for(const listener of this.listeners.get(id)??[])listener();
  }
  subscribe(id:string,listener:()=>void){
    let set=this.listeners.get(id);if(!set)this.listeners.set(id,set=new Set());
    set.add(listener);
    return()=>{set.delete(listener);if(!set.size)this.listeners.delete(id);};
  }
}
