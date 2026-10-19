import type {Cdp} from './cdp.js';
import {deadline} from './deadline.js';
import {numberAt,SAMPLE_WIDTH} from '../server/domain/periodTape.js';

/** Collect only after a completed reading; observer failures never replace its original error. */
export async function observePreparations<T>(read:()=>Promise<T>,cdp:Pick<Cdp,'evaluate'>,evidence:{save(name:string,value:unknown):void},name:'idle-retirement-routes'|'idle-preparation-owners',signal?:AbortSignal){
  const save=(value:unknown)=>{try{evidence.save(name,value);return true;}catch{return false;}};
  const unavailable=(reason:string)=>({mode:'diagnostic',status:'insufficient-evidence',reason});
  let reading:T;
  try{reading=await read();}
  catch(error){save(unavailable('original idle recording interrupted'));throw error;}
  if(signal?.aborted){save(unavailable('preparation observer recording cancelled'));return {reading,status:undefined};}
  try{
    const report=await deadline(2000,signal=>cdp.evaluate<{status?:string}>('window.__quotumPreparationProbe?.stop()??{mode:"diagnostic",status:"insufficient-evidence",reason:"preparation observer unavailable"}',signal),signal);
    return {reading,status:save(report)?report?.status:undefined};
  }catch{save(unavailable('preparation observer read unavailable'));return {reading,status:undefined};}
}

/** Count actual retirement factory routes without advancing or wrapping their iterators. */
export function retirementRoutesScript() {
  return `pool=>{
    const numberAt=${numberAt.toString()},width=${SAMPLE_WIDTH};
    let started=false,stopped=false,active=false,invalid=0,omitted=0,retirementCalls=0,unmatched=0,member,opening,accountingRef,call;
    let keys=new WeakMap(),rows=[],restores=[];
    const cap=2048;
    const basis=p=>{
      if(typeof p.identity!=='string'||!p.identity||typeof p.scopeKeys?.quota!=='string'||!p.scopeKeys.quota
        ||![p.generation,p.revision,p.proofEpoch].every(Number.isSafeInteger)||p.selection?.mode!=='live'
        ||!Number.isFinite(p.selection.periodMs)||p.selection.periodMs<=0)throw Error('basis unavailable');
      return {identity:p.identity,generation:p.generation,revision:p.revision,proofEpoch:p.proofEpoch,
        scopeKey:p.scopeKeys.quota,selection:JSON.stringify(p.selection)};
    };
    const settled=p=>p.active===true&&!p.retiring&&!p.retirementPreparing&&!p.workNeeded
      &&p.dirtyScopes instanceof Set&&!p.dirtyScopes.size&&p.transport?.flights instanceof Set&&!p.transport.flights.size
      &&Array.isArray(p.transport.queue)&&!p.transport.queue.length&&!p.get().loading&&!p.get().error&&!p.projectionErrors?.quota;
    const record=(kind,args)=>{
      if(kind==='retirement'){
        retirementCalls++;
        if(call){invalid++;return;}
        const [tape,,,,,,tails]=args;
        const prior=accountingRef.deref();if(!prior||args[3]!==prior){invalid++;return;}
        if(!tape||!Array.isArray(tape.quota)||!(tails instanceof Map)){invalid++;return;}
        if(tape.quota.length>cap){omitted+=tape.quota.length-cap;return;}
        call={tape:new WeakRef(tape),tails:tails.size,retiring:member.retiring===true,preparing:member.retirementPreparing===true,fallbackCalls:0};
        for(const series of tape.quota){
          if(!series||typeof series!=='object'||keys.has(series)){invalid++;continue;}
          const row={id:rows.length,tail:tails.has(series),samples:series.samples.length/5,attempts:0,builds:0,reuses:0,fallback:0};
          if(!Number.isSafeInteger(row.samples)||row.samples<0){invalid++;continue;}
          keys.set(series,row);rows.push(row);
        }
        if(tails.size!==rows.filter(row=>row.tail).length)invalid++;
      }else if(kind==='fallback'){
        const prior=accountingRef.deref();if(!call||!prior||args[3]!==prior){unmatched++;return;}
        const tape=args[0];if(!Array.isArray(tape?.quota)){invalid++;return;}
        if(tape.quota.length>cap){omitted+=tape.quota.length-cap;return;}
        call.fallbackCalls++;
        for(const series of tape.quota){const row=keys.get(series);if(!row){invalid++;continue;}row.fallback++;}
      }else{
        if(!call){unmatched++;return;}
        const row=keys.get(args[0]);if(!row){unmatched++;return;}
        if(kind==='attempt'){
          row.attempts++;
          const [series,activity,known,prior,tail]=args;
          row.firstGuard={
            proofMatches:tail.removed===1&&tail.before===prior.series&&tail.after===series
              &&'columns' in prior.series.samples&&'columns' in series.samples
              &&prior.series.samples.length/width===series.samples.length/width+1,
            activitySame:prior.activity===activity,knownSame:Object.is(prior.known,known),
            prefixColumns:['spent','worked','during'].every(key=>'base' in prior[key]),
            spentZero:Object.is(numberAt(prior.spent,1),0),workedZero:Object.is(numberAt(prior.worked,1),0),duringZero:Object.is(numberAt(prior.during,1),0),
          };
        }else{row.builds++;if(args[3]?.series===args[0])row.reuses++;}
      }
    };
    const wrap=(target,name,kind)=>{
      const descriptor=Object.getOwnPropertyDescriptor(target,name);
      if(!descriptor||typeof descriptor.value!=='function'||!descriptor.configurable||!descriptor.writable){invalid++;return;}
      const original=descriptor.value;
      const wrapped=function(...args){
        const result=Reflect.apply(original,this,args);
        if(active)try{record(kind,args);}catch{invalid++;}
        return result;
      };
      Object.defineProperty(target,name,{...descriptor,value:wrapped});
      restores.push(()=>{if(Object.getOwnPropertyDescriptor(target,name)?.value!==wrapped){invalid++;return;}Object.defineProperty(target,name,descriptor);});
    };
    return {
      start(){
        if(started){invalid++;return;}started=true;
        try{
          const members=[...pool.members].filter(p=>p.tapes instanceof Map);
          if(members.length!==1){invalid++;return;}member=members[0];
          const accounting=member.tapes.get('quota')?.accounting;
          if(!(accounting?.quota instanceof Map)||!accounting.quota.size||accounting.quota.size>cap||!settled(member)){invalid++;return;}
          const constructors=new Set([...accounting.quota.values()].map(index=>index.constructor));
          if(constructors.size!==1){invalid++;return;}
          opening=basis(member);
          accountingRef=new WeakRef(accounting);
          const quota=[...constructors][0];
          wrap(accounting.constructor,'prepareRetirement','retirement');wrap(accounting.constructor,'prepare','fallback');
          wrap(quota,'retire','attempt');wrap(quota,'prepare','build');
          active=!invalid;
        }catch{invalid++;}
      },
      stop(){
        active=false;if(stopped)invalid++;stopped=true;
        let published=false,basisSame=false,finished=false;
        try{
          basisSame=!!opening&&JSON.stringify(opening)===JSON.stringify(basis(member));finished=!!member&&settled(member);
          const entry=member?.tapes.get('quota'),accounting=entry?.accounting,captured=call?.tape.deref();
          published=!!captured&&entry?.tape===captured&&accounting?.tape===captured;
          if(published){
            if(!Array.isArray(captured.quota)||captured.quota.length!==rows.length||!(accounting.quota instanceof Map)||accounting.quota.size!==rows.length)published=false;
            else{
              const seen=new Set();
              for(const series of captured.quota){
                const row=keys.get(series),index=accounting.quota.get(series.source+String.fromCharCode(10)+series.window);
                if(!row||seen.has(row.id)||index?.series!==series){invalid++;continue;}
                seen.add(row.id);row.published=true;
              }
              if(seen.size!==rows.length)published=false;
            }
          }
        }catch{invalid++;}
        finally{for(const restore of restores.reverse())try{restore();}catch{invalid++;}restores=[];}
        const shape=retirementCalls===1&&!!call&&call.tails>0&&call.retiring&&call.preparing&&call.fallbackCalls===1&&rows.length>0
          &&rows.every(row=>row.published&&row.attempts===(row.tail?1:0)&&row.fallback<=1&&row.builds===row.fallback&&row.reuses<=row.builds&&(!row.tail||!row.reuses&&!!row.firstGuard));
        const complete=started&&!invalid&&!omitted&&basisSame&&finished&&published&&shape;
        const report={mode:'diagnostic',status:complete?'complete':'insufficient-evidence',started,stopped,invalid,omitted,unmatched,
          basisSame,settled:finished,published,retirementCalls,tails:call?.tails??null,fallbackCalls:call?.fallbackCalls??0,rows,
          tailIncrementalRows:complete?rows.filter(row=>row.tail&&!row.builds).length:null,
          tailFullBuilds:complete?rows.filter(row=>row.tail&&row.builds).length:null,
          nonTailBuildCalls:complete?rows.filter(row=>!row.tail&&row.builds).length:null,
          quotaPrepareCalls:rows.reduce((sum,row)=>sum+row.builds,0),
          kind:'Factory routes, input counts and first-guard operands only; later guards remain unknown. No iterator advancement or CPU-cost attribution; observer overhead is unqualified.'};
        keys=new WeakMap();member=opening=accountingRef=call=undefined;rows=[];
        return report;
      }
    };
  }`;
}
