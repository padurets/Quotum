import {randomUUID} from 'node:crypto';
import {Agent,type Person} from '../demo/client.js';
import {pseudonym} from '../demo/model.js';
import {sourceId} from '../server/domain/sources.js';
import {subscriptionKey} from '../server/domain/ingest.js';
import {EMPTY_VIEW} from '../server/domain/view.js';
import {openTab,type Browser} from './cdp.js';
import {inspectMeasurementDetails,type MeasurementCase} from './measurementDetails.js';

const H=3_600_000;
/** Isolated, real historical observations; none joins a measured benchmark cohort. */
export async function measurementDetailsFixture(owner:Person){
  const token=await owner.post<{id:string;secret:string}>('/api/tokens',{name:'Measurement disclosure fixture'});
  let board:string|undefined;
  const remove=async(path:string)=>{const response=await fetch(owner.base+path,{method:'DELETE',headers:{cookie:owner.cookie,origin:new URL(process.env.QUOTUM_PUBLIC_URL??owner.base).origin},signal:AbortSignal.timeout(10_000)});if(!response.ok)throw Error('measurement fixture cleanup: HTTP '+response.status);};
  const close=async()=>{const errors=[];for(const path of [...(board?['/api/boards/'+board]:[]),'/api/tokens/'+token.id])try{await remove(path);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Measurement fixture cleanup failed');};
  try{
    board=await owner.createBoard('Measurement disclosure fixture');
    const at=Date.now(),agent=new Agent(owner.base,{id:randomUUID(),name:'Measurement fixture',os:'linux',arch:'x86_64'},token.secret,owner.id);
    const cases:MeasurementCase[]=[];
    for(const status of ['fresh','stale','missing'] as const){
      const provider='claude',account=pseudonym(randomUUID()),source=sourceId(provider,subscriptionKey({provider,account,accountName:null},owner.id));
      const suffix='END-'+status.toUpperCase(),label=('Native allowance for parallel code review, analysis and integration work '+status+' ').padEnd(118-suffix.length,'x')+suffix;
      const window={id:'native-'+status,kind:'other',minutes:300,label,usedPercent:42,resetsAt:new Date(at+H).toISOString()};
      const snapshot=(observedAt:number,windows:object[],staleAfterMs=4*H)=>({provider,account,plan:'Fixture',via:'demo',client:'demo',observedAt:new Date(observedAt).toISOString(),staleAfterMs,windows});
      // This window first appears after the selected interval. Accepted missing
      // observations would instead preserve the last known number, correctly.
      const prior=status==='missing'?{...window,id:'other',label:'Other allowance'}:window;
      const snapshots=[snapshot(at-3*H,[{...prior,usedPercent:17}]),snapshot(at-2*H,[prior],status==='stale'?H/2:4*H),snapshot(at,[window])];
      const answer=await agent.ingest(snapshots,[],Date.now());if(answer.accepted!==3||answer.duplicates)throw Error('measurement fixture history was not accepted');
      await owner.share(board,source);cases.push({source,label,status});
    }
    await owner.saveView(board,{...EMPTY_VIEW,names:Object.fromEntries(cases.map(c=>[c.source,'Disclosure '+c.status])),layout:{columns:6,places:Object.fromEntries(cases.map((c,i)=>['source:'+c.source,{x:0,y:i,w:2}]))}});
    return {board,tokenId:token.id,from:at-4*H,to:at-H,cases,close};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Measurement fixture setup and cleanup failed',{cause:error});}throw error;}
}

/** Runs after all measurements, with a separate board and tab; restores shared preferences. */
export async function measurementDetails(browser:Browser,owner:Person){
  const fixture=await measurementDetailsFixture(owner),tab=await openTab(browser).catch(async error=>{try{await fixture.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Measurement tab and cleanup failed',{cause:error});}throw error;}),{cdp}=tab;
  let saved:Record<string,string|null>|undefined;
  const reports:unknown[]=[];let failed=false,primary:unknown;
  const navigate=async(url:string)=>{
    let timer:ReturnType<typeof setTimeout>;
    let loaded!:()=>void;
    const complete=new Promise<void>((resolve,reject)=>{loaded=resolve;timer=setTimeout(()=>reject(Error('measurement fixture navigation did not load')),10_000);});
    cdp.on('Page.loadEventFired',loaded);
    try{await Promise.all([cdp.send('Page.navigate',{url}),complete]);}
    finally{clearTimeout(timer!);cdp.off('Page.loadEventFired',loaded);}
  };
  try{
    await cdp.send('Network.enable');await cdp.send('Page.enable');
    const split=owner.cookie.indexOf('=');await cdp.send('Network.setCookie',{name:owner.cookie.slice(0,split),value:owner.cookie.slice(split+1),url:owner.base,httpOnly:true,sameSite:'Lax'});
    await navigate(owner.base+'/?board='+fixture.board);
    saved=await cdp.evaluate(`(async()=>{const end=Date.now()+10000;while(!document.querySelector('.widgets')){if(Date.now()>end)throw Error('measurement fixture board did not load');await new Promise(r=>setTimeout(r,20));}return Object.fromEntries(['quotum.locale','quotum.prefs'].map(key=>[key,localStorage.getItem(key)]));})()`);
    for(const locale of ['en','ru'])for(const width of [390,900]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await cdp.evaluate(`localStorage.setItem('quotum.locale',${JSON.stringify(locale)})`);
      for(const historical of [true,false]){
        const url=owner.base+'/?board='+fixture.board+(historical?'&from='+fixture.from+'&to='+fixture.to:'');
        await navigate(url);
        const actual=await cdp.evaluate<{url:string;width:number;locale:string}>('({url:location.href,width:innerWidth,locale:document.documentElement.lang})');
        if(actual.url!==url||actual.width!==width||actual.locale!==locale)throw Error('measurement fixture document did not match its scenario');
        for(const reading of historical?fixture.cases:[{...fixture.cases[0],status:'live' as const}])reports.push({locale,width,...await inspectMeasurementDetails(cdp,reading)});
      }
    }
    return reports;
  }catch(error){failed=true;primary=error;throw error;
  }finally{
    const errors=[];
    for(const cleanup of [async()=>{if(saved)await cdp.evaluate(`(()=>{for(const [key,value] of Object.entries(${JSON.stringify(saved)}))if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);})()`);},()=>tab.close(),()=>fixture.close()])try{await cleanup();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(failed?[primary,...errors]:errors,'Measurement disclosure cleanup failed',{cause:primary});
  }
}
