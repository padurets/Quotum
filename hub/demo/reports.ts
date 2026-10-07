import {openAIPlatform,decodeOpenAI} from '../server/connectors/openai.js';
import {ConnectorStatus,ConnectorTransport} from '../server/connectors/transport.js';
import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';

/** Report corrections and partial-page transitions are held by server/test/reports.test.ts. */
export const REPORT_SCENES=[
  {id:'enforcing',expect:['monthly-limit','allowance','enforcing']},
  {id:'inactive',expect:['monthly-limit','allowance','inactive']},
  {id:'overspend',expect:['overspend']},
  {id:'zero',expect:['zero-limit']},
  {id:'permission',expect:['limit-unavailable']},
  {id:'unknown',expect:['limit-unavailable']},
  {id:'missing-day',expect:['incomplete-month']},
  {id:'adjustment',expect:['signed-report']},
] as const;
export const REPORT_KEY=(index:number)=>'sk-admin-demo-'+index.toString().padStart(32,'0');
export function reportFixture(index:number,operation:string,from:number,to:number,now:number):unknown {
  const day=86_400_000,today=Math.floor(now/day)*day;
  if(operation==='limit')return {object:'organization.spend_limit',threshold_amount:index===3?0:10000,currency:'USD',interval:'month',enforcement:{status:index===1?'inactive':'enforcing'}};
  return {object:'page',data:Array.from({length:(to-from)/day},(_,i)=>from+i*day).filter(at=>index!==6||at!==today-day).map(at=>({object:'bucket',start_time:at/1000,end_time:(at+day)/1000,results:[{object:'organization.costs.result',amount:{currency:'usd',value:at===today?index===2?110:index===7?-1:30:0}}]})),has_more:false,next_page:null};
}
export async function seedReports(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0];if(!owner)return;
  for(const [index,scene] of REPORT_SCENES.entries()) {
    // Two saved connections exercise the public flow without exhausting its abuse limit.
    // Other durable measurement states use the same explicit synthetic adapter.
    let sourceId:string;
    if(index<2)sourceId=(await owner.post<{sourceId:string}>('/api/credentials',{provider:'openai_platform',secret:REPORT_KEY(index),allowUnknownExpiry:true})).sourceId;
    else {
      const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
      transport.send=async(op,_secret,query={})=>{
        if(op==='limit'&&(index===4||index===5))throw new ConnectorStatus(index===4?403:404,null);
        return {organization:'org-demo-reports-'+index,data:decodeOpenAI(JSON.stringify(reportFixture(index,op,Number(query.start_time)*1000,Number(query.end_time)*1000,Date.now())))};
      };
      try{const answer=await openAIPlatform(transport).identify(Buffer.from(REPORT_KEY(index)));sourceId=store.source('openai_platform',answer.account,Date.now());store.hold(sourceId,owner.id,Date.now());store.record(sourceId,{...answer.measurement!,staleAfterMs:3*3600000});}finally{transport.close();}
    }
    const personal=directory.boards(owner.id).find(b=>b.personal)!;
    const view=directory.view(personal.id);view.names[sourceId]='OpenAI '+scene.id;directory.saveView(personal.id,view,owner.id,Date.now());
    for(const board of directory.boards(owner.id).filter(b=>!b.personal))store.share(board.id,sourceId,owner.id,Date.now());
  }
}
