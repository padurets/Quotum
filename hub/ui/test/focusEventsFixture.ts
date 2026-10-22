/** Deliberate input, DOM retirement and controlled focus are separate test phases. */
export function focusEventsFixture(){
  const listeners=new Map<string,Set<(event:{target:unknown})=>void>>();
  const document={body:{},documentElement:{},activeElement:null as unknown,
    addEventListener:(type:string,listener:(event:{target:unknown})=>void)=>{let group=listeners.get(type);if(!group)listeners.set(type,group=new Set());group.add(listener);},
    removeEventListener:(type:string,listener:(event:{target:unknown})=>void)=>{listeners.get(type)?.delete(listener);},
  };
  document.activeElement=document.body;
  const emit=(type:string,target:unknown=document.body)=>{for(const listener of [...(listeners.get(type)??[])])listener({target});};
  const target=(name:string)=>{
    const node={name,isConnected:true,matches:()=>false,closest:()=>null,getClientRects:()=>[{}],focus:()=>{document.activeElement=node;emit('focusin',node);}};return node;
  };
  return {document,emit,target,listeners:()=>[...listeners.values()].reduce((sum,group)=>sum+group.size,0)};
}
