/** Observe scheduler selections through an existing reader; never create or advance work. */
export function preparationOwnersScript() {
  return `pool=>{
    const schedulers=new Set(),readers=new Set(),wrapped=new WeakSet();
    let active=false,started=false,stopped=false,invalid=0,omitted=0,nextOwner=0,nextJob=0;
    let owners=new WeakMap(),jobs=new WeakMap(),rows=[],opening=null,closing=null;
    const now=()=>{const at=performance.now();if(!Number.isFinite(at)||at<0)throw Error();return at;};
    const id=(map,key,owner)=>{let value=map.get(key);if(value===undefined){value=owner?++nextOwner:++nextJob;map.set(key,value);}return value;};
    const shape=s=>s&&s.jobs instanceof Map&&Array.isArray(s.queue)&&typeof s.slice==='function';
    const snapshot=()=>{try{return {at:now(),readers:readers.size,schedulers:schedulers.size,
      pending:[...schedulers].map(s=>({jobs:s.jobs.size,queued:s.queue.length}))};}catch{invalid++;return null;}};
    const classify=owner=>{
      if(!owner)return {kind:'unknown',matches:0};
      const matches=[];
      for(const member of pool.members){
        if(member.preparationOwner===owner)matches.push({kind:'period',retiring:member.retiring===true,preparing:member.retirementPreparing===true});
        const scope=['quota','budget'].includes(member.scope)?member.scope:null;
        if(member.plotOwner===owner)matches.push({kind:'history-plot',scope});
        if(member.composeOwner===owner)matches.push({kind:'history-compose',scope});
      }
      return matches.length===1?matches[0]:{kind:'unknown',matches:matches.length};
    };
    const attach=s=>{
      if(!shape(s)){invalid++;return;}
      if(wrapped.has(s))return;
      wrapped.add(s);schedulers.add(s);
      const slice=s.slice;
      s.slice=function(...args){
        if(!active)return Reflect.apply(slice,this,args);
        let row,owner,job;
        try{
          if(rows.length>=2048)omitted++;
          else{
            owner=this.queue[0];job=this.jobs.get(owner);
            row={at:now(),owner:owner&&typeof owner==='object'?id(owners,owner,true):null,
              job:job&&typeof job==='object'?id(jobs,job,false):null,
              ...classify(owner),queued:this.queue.length,jobs:this.jobs.size,returned:false};
            rows.push(row);
          }
        }catch{invalid++;}
        try{const value=Reflect.apply(slice,this,args);if(row)row.returned=true;return value;}
        finally{if(row)try{
          row.to=now();row.sameJob=!!job&&this.jobs.get(owner)===job;
          row.requeued=this.queue.includes(owner);row.queuedAfter=this.queue.length;row.jobsAfter=this.jobs.size;
        }catch{invalid++;}}
      };
    };
    const register=pool.register;
    pool.register=function(...args){
      const member=args[0],value=Reflect.apply(register,this,args);
      try{if(!readers.has(member)&&Object.hasOwn(member,'plotOwner')&&Object.hasOwn(member,'composeOwner')){
        readers.add(member);
        const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(member),'preparations');
        if(typeof descriptor?.get!=='function'){invalid++;return value;}
        Object.defineProperty(member,'preparations',{configurable:true,get:function(){
          const scheduler=Reflect.apply(descriptor.get,this,[]);
          try{attach(scheduler);}catch{invalid++;}
          return scheduler;
        }});
      }}catch{invalid++;}
      return value;
    };
    return {
      start(){if(started){invalid++;return;}started=true;opening=snapshot();active=true;},
      stop(){active=false;if(stopped)invalid++;stopped=true;closing=snapshot();
        return {mode:'diagnostic',status:started&&!invalid&&!omitted&&opening?.readers===3&&opening?.schedulers===1&&opening.pending.every(s=>s.jobs===0&&s.queued===0)&&closing?.readers===3&&closing?.schedulers===1?'complete':'insufficient-evidence',
          started,stopped,invalid,omitted,opening,closing,rows,
          kind:'Selected jobs only; deletion or replacement does not prove completion. Observer overhead is unqualified.'};}
    };
  }`;
}
