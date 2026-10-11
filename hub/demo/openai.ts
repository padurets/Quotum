import {openAIPlatform,decodeOpenAI} from '../server/connectors/openai.js';
import {ConnectorStatus,ConnectorTransport} from '../server/connectors/transport.js';
import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';

/** Pagination failures, counter corrections and month boundaries are held by openai.test.ts. */
export const OPENAI_SCENES=[
  {id:'enforcing',expect:['month-costs','configured-limit','enforcing']},
  {id:'inactive',expect:['month-costs','configured-limit','inactive']},
  {id:'over-threshold',expect:['month-costs','configured-limit']},
  {id:'zero',expect:['zero-limit']},
  {id:'permission',expect:['limit-unavailable']},
  {id:'unknown',expect:['limit-unavailable']},
  {id:'empty',expect:['unknown-costs']},
  {id:'adjustment',expect:['signed-costs']},
] as const;
export const OPENAI_KEY=(index:number)=>'sk-admin-demo-'+index.toString().padStart(32,'0');
export function openAIFixture(index:number,operation:string,_from:number,_to:number,now:number,total?:number):unknown {
  const day=86_400_000,today=Math.floor(now/day)*day;
  if(operation==='limit')return {object:'organization.spend_limit',threshold_amount:index===3?0:10000,currency:'USD',interval:'month',enforcement:{status:index===1?'inactive':'enforcing'}};
  return {object:'page',data:[{object:'bucket',start_time:today/1000,end_time:(today+day)/1000,results:index===6?[]:[{object:'organization.costs.result',amount:{currency:'usd',value:total??(index===2?110:index===7?-1:30)}}]}],has_more:false,next_page:null};
}
export async function seedOpenAI(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0];if(!owner)return;
  const end=Date.now();
  for(const [index,scene] of OPENAI_SCENES.entries()) {
    const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
    let at=end-12*3_600_000,total=index===7?-3:10;
    transport.send=async(op,_secret,query={})=>{
      if(op==='limit'&&(index===4||index===5))throw new ConnectorStatus(index===4?403:404,null);
      return {organization:'org-demo-openai-'+index,data:decodeOpenAI(JSON.stringify(openAIFixture(index,op,Number(query.start_time)*1000,Number(query.end_time)*1000,at,total)))};
    };
    let sourceId:string;
    try {
      const connector=openAIPlatform(transport,()=>at),answer=await connector.identify(Buffer.from(OPENAI_KEY(index)));
      sourceId=store.source('openai_platform',answer.account,at);store.hold(sourceId,owner.id,at);
      store.record(sourceId,{...answer.measurement!,staleAfterMs:3*3600000});
      for(const offset of [6,0]) {
        at=end-offset*3_600_000;total=index===7?offset?-2:-1:index===2?offset?60:110:offset?20:30;
        const next=await connector.measure(Buffer.from(OPENAI_KEY(index)),{account:answer.account,expiresAt:null});
        store.record(sourceId,{...next.measurement!,staleAfterMs:3*3600000});
      }
      // Two connections also exercise encrypted storage and the owner form flow.
      if(index<2)await owner.post('/api/credentials',{provider:'openai_platform',secret:OPENAI_KEY(index),allowUnknownExpiry:true});
    }finally{transport.close();}
    const personal=directory.boards(owner.id).find(b=>b.personal)!;
    const view=directory.view(personal.id);view.names[sourceId]='OpenAI '+scene.id;directory.saveView(personal.id,view,owner.id,end);
    for(const board of directory.boards(owner.id).filter(b=>!b.personal))store.share(board.id,sourceId,owner.id,end);
  }
}
