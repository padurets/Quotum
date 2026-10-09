import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Hub,Guards} from '../api.js';
import type {CurrencyDefinition,CurrencyMutation} from '../domain/currency.js';

export function currencyRoutes(app:FastifyInstance,hub:Hub,guards:Guards) {
  const store=hub.store.currencies;
  const failure=(reply:FastifyReply,error:unknown,display=false)=>{
    const code=error instanceof Error?error.message:'';
    if(display&&(code==='currency_not_found'||code==='currency_archived'))return reply.code(400).send({error:'invalid_currency'});
    if(code==='currency_not_found')return reply.code(404).send({error:code});
    if(['currency_conflict','currency_selected','currency_archived','mutation_conflict'].includes(code))return reply.code(409).send({error:code});
    return reply.code(400).send({error:code==='currency_limit'?code:'invalid_currency'});
  };
  const command=(request:FastifyRequest,reply:FastifyReply,required:boolean,status:number,work:(owner:string,body:Record<string,unknown>)=>unknown,display=false)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try {
      if(!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw new Error('invalid_currency');
      const body=request.body as Record<string,unknown>,mutation=body.expectedRevision!==undefined||body.requestId!==undefined?{expectedRevision:body.expectedRevision,requestId:body.requestId} as CurrencyMutation:undefined;
      const result=store.mutation(user.id,request.url,body,mutation,required,status,()=>work(user.id,body));return reply.code(result.status).send(result.body);
    }catch(error){return failure(reply,error,display);}
  };
  app.get('/api/currencies',(request,reply)=>{const user=guards.user(request,reply);if(!user)return reply;return store.context(user.id);});
  app.get('/api/currencies/manage',(request,reply)=>{const user=guards.user(request,reply);if(!user)return reply;return store.manage(user.id);});
  app.post('/api/currencies/display',(request,reply)=>command(request,reply,false,200,(owner,body)=>{
    if(typeof body.currency!=='string')throw new Error('invalid_currency');store.select(owner,body.currency);return store.context(owner);
  },true));
  app.get<{Params:{id:string}}>('/api/currencies/:id',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try{return {definition:store.definition(user.id,request.params.id,true),rates:store.rates(user.id,request.params.id)};}catch(error){return failure(reply,error);}
  });
  app.get<{Params:{id:string};Querystring:{before?:string;limit?:string}}>('/api/currencies/:id/history',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try{return store.rateHistory(user.id,request.params.id,request.query.before,request.query.limit===undefined?32:Number(request.query.limit));}catch(error){return failure(reply,error);}
  });
  app.post('/api/currencies',(request,reply)=>command(request,reply,false,201,(owner,body)=>{
    if(typeof body.base!=='string'||typeof body.rate!=='string')throw new Error('invalid_currency');return store.create(owner,body as Omit<CurrencyDefinition,'id'>,body.base,body.rate,Date.now());
  }));
  app.post<{Params:{id:string}}>('/api/currencies/:id',(request,reply)=>command(request,reply,true,200,(owner,body)=>store.update(owner,request.params.id,body as Omit<CurrencyDefinition,'id'>)));
  app.post<{Params:{id:string}}>('/api/currencies/:id/archive',(request,reply)=>command(request,reply,true,200,(owner,body)=>{
    if(body.replacement!==undefined&&typeof body.replacement!=='string')throw new Error('invalid_currency');return store.archive(owner,request.params.id,body.replacement as string|undefined,Date.now());
  }));
  app.post<{Params:{id:string}}>('/api/currencies/:id/restore',(request,reply)=>command(request,reply,true,200,owner=>store.restore(owner,request.params.id)));
  app.post<{Params:{id:string}}>('/api/currencies/:id/rates',(request,reply)=>command(request,reply,request.params.id==='credits:codex',200,(owner,body)=>{
    if(typeof body.base!=='string'||typeof body.rate!=='string'||body.date!==undefined&&typeof body.date!=='number'||body.direction!==undefined&&body.direction!=='unitPerBase'&&body.direction!=='basePerUnit')throw new Error('invalid_currency');const now=Date.now();return store.setRate(owner,request.params.id,body.base,body.rate,(body.date as number|undefined)??now,now,body.direction as 'unitPerBase'|'basePerUnit'|undefined);
  }));
  app.post<{Params:{id:string}}>('/api/currencies/:id/rates/default',(request,reply)=>command(request,reply,true,200,owner=>store.defaultRate(owner,request.params.id,Date.now())));
  app.post<{Params:{id:string;quoteId:string}}>('/api/currencies/:id/rates/:quoteId/archive',(request,reply)=>command(request,reply,true,200,(owner,body)=>{
    if(typeof body.base!=='string')throw new Error('invalid_currency');return store.stopRate(owner,request.params.id,body.base,request.params.quoteId,Date.now());
  }));
}
