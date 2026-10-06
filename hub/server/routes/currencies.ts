import type {FastifyInstance} from 'fastify';
import type {Hub,Guards} from '../api.js';
import type {CurrencyDefinition} from '../domain/currency.js';

/** The future settings section uses these same owner-scoped operations. */
export function currencyRoutes(app:FastifyInstance,hub:Hub,guards:Guards) {
  app.get('/api/currencies',(request,reply)=>{const user=guards.user(request,reply);if(!user)return reply;return hub.store.currencies.context(user.id);});
  app.post<{Body:{currency:string}}>('/api/currencies/display',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try {if(typeof request.body?.currency!=='string')throw new Error('invalid_currency');hub.store.currencies.select(user.id,request.body.currency);return hub.store.currencies.context(user.id);}
    catch{return reply.code(400).send({error:'invalid_currency'});}
  });
  app.get<{Params:{id:string}}>('/api/currencies/:id',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try {return {definition:hub.store.currencies.definition(user.id,request.params.id),rates:hub.store.currencies.rates(user.id,request.params.id)};}
    catch{return reply.code(404).send({error:'currency_not_found'});}
  });
  app.post<{Params:{id:string};Body:{base:string;rate:string;date?:number}}>('/api/currencies/:id/rates',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try {const input=request.body;if(!input||typeof input.base!=='string'||typeof input.rate!=='string')throw new Error('invalid_currency');const now=Date.now();return hub.store.currencies.setRate(user.id,request.params.id,input.base,input.rate,input.date??now,now);}
    catch{return reply.code(400).send({error:'invalid_currency'});}
  });
  app.post<{Body:Omit<CurrencyDefinition,'id'>&{base:string;rate:string}}>('/api/currencies',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    try {const input=request.body;if(!input||typeof input.base!=='string'||typeof input.rate!=='string')throw new Error('invalid_currency');
      const definition=hub.store.currencies.create(user.id,input,input.base,input.rate,Date.now());return reply.code(201).send(definition);
    }catch{return reply.code(400).send({error:'invalid_currency'});}
  });
}
