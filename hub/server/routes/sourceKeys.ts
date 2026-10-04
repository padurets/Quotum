import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Guards,Hub} from '../api.js';
import {sourceHidden} from '../domain/presentation.js';
import {utcPeriods} from '../domain/meters.js';

/** Cursors carry only safe key identity, bound to this source, ordering and hub run. */
export function sourceKeyRoutes(app:FastifyInstance,hub:Hub,guards:Guards) {
  const key=randomBytes(32);
  const sign=(value:string)=>createHmac('sha256',key).update(value).digest();
  app.get<{Params:{board:string;source:string};Querystring:{after?:string;limit?:string;ids?:string}}>('/api/boards/:board/sources/:source/keys',(request,reply)=>{
    const {board,source}=request.params,access=guards.board(request,reply,board);
    if(!access)return reply;
    if(!hub.store.sources(board).some(s=>s.id===source)||sourceHidden(hub.directory.view(board),source))return reply.code(404).send({error:'not_found'});
    const limit=request.query.limit===undefined?50:Number(request.query.limit);
    if(!Number.isInteger(limit)||limit<1||limit>50||Object.keys(request.query).some(k=>!['after','limit','ids'].includes(k)))return reply.code(400).send({error:'invalid_request'});
    let selected:Set<string>|null=null;
    if(request.query.ids!==undefined) {
      try {
        if(request.query.after!==undefined||request.query.limit!==undefined||request.query.ids.length>8192)throw new Error();
        const ids:unknown=JSON.parse(request.query.ids);
        if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>typeof id!=='string'||!id||id.length>120))throw new Error();
        selected=new Set(ids);
      }catch{return reply.code(400).send({error:'invalid_request'});}
    }
    const state=hub.store.state(source),keys=state.keys??[];
    const revision=createHash('sha256').update(JSON.stringify(keys.map(k=>[k.id,k.name,k.presence]))).digest('base64url').slice(0,16);
    let start=0;
    if(request.query.after!==undefined) {
      try {
        const cursor=request.query.after;
        if(cursor.length>2048||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(cursor))throw new Error();
        const [body,tag]=cursor.split('.'),expected=sign(body),actual=Buffer.from(tag,'base64url');
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();
        const parsed=JSON.parse(Buffer.from(body,'base64url').toString()) as {source:string;revision:string;id:string};
        if(parsed.source!==source)throw new Error();
        if(parsed.revision!==revision)return reply.code(409).send({error:'keys_changed'});
        const index=keys.findIndex(k=>k.id===parsed.id);if(index<0)return reply.code(409).send({error:'keys_changed'});start=index+1;
      }catch{return reply.code(400).send({error:'invalid_request'});}
    }
    const now=Date.now(),page=selected?keys.filter(k=>selected.has(k.id)):keys.slice(start,start+limit),ids=new Set(page.map(k=>k.id));
    const meters=(state.meters??[]).filter(m=>m.id.startsWith('key:')&&ids.has(m.id.split(':')[1])).map(m=>({...m,stale:m.stale||now>m.at+m.staleAfterMs||m.kind==='cap'&&m.resetAt!==null&&m.resetAt<=now}));
    let next:string|null=null;
    if(!selected&&start+page.length<keys.length){const body=Buffer.from(JSON.stringify({source,revision,id:page.at(-1)!.id})).toString('base64url');next=body+'.'+sign(body).toString('base64url');}
    return {keys:page.map(k=>({...k,periods:{day:utcPeriods(k.at).day===utcPeriods(now).day?k.periods.day:null,week:utcPeriods(k.at).week===utcPeriods(now).week?k.periods.week:null,month:utcPeriods(k.at).month===utcPeriods(now).month?k.periods.month:null}})),meters,total:keys.length,inventory:state.inventory??null,next};
  });
}
