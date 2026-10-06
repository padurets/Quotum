import type {FastifyInstance} from 'fastify';
import type {Guards, Hub} from '../api.js';
import {AdditionError, BoardAdditions, WIDGETS, type AdditionItem} from '../additions.js';
import {currentUser, Limiter, sameSite} from '../session.js';
import {SecretError} from '../secrets/index.js';

const uuid = (value: unknown): value is string => typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const boardId = (value: unknown): value is string => typeof value==='string'&&/^[A-Za-z0-9_-]{12}$/.test(value);
const sourceId = (value: unknown): value is string => typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}:[a-f0-9]{12}$/.test(value);
export function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>![...required,...optional].includes(key))) throw new AdditionError('addition_invalid');
  return value as Record<string,unknown>;
}
function itemOf(value: unknown): AdditionItem {
  const kind=(value as {kind?:unknown}|null)?.kind;
  if(kind==='sources') {
    const input=fields(value,['kind','sourceIds']);
    if(!Array.isArray(input.sourceIds)||input.sourceIds.length<1||input.sourceIds.length>100||!input.sourceIds.every(sourceId))throw new AdditionError('addition_invalid');
    return {kind,sourceIds:input.sourceIds};
  }
  if(kind==='widget') {
    const input=fields(value,['kind','widgetId']);
    if(!WIDGETS.includes(input.widgetId as typeof WIDGETS[number]))throw new AdditionError('addition_invalid');
    return {kind,widgetId:input.widgetId as typeof WIDGETS[number]};
  }
  if(kind==='connection') {
    const input=fields(value,['kind','provider']);
    if(typeof input.provider!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(input.provider))throw new AdditionError('addition_invalid');
    return {kind,provider:input.provider};
  }
  if(kind==='replace') {
    const input=fields(value,['kind','credentialId']);
    if(!uuid(input.credentialId))throw new AdditionError('addition_invalid');
    return {kind,credentialId:input.credentialId};
  }
  throw new AdditionError('addition_invalid');
}

export async function additionRoutes(app: FastifyInstance, hub: Hub, guards: Guards, additions: BoardAdditions) {
  const attempts=new Limiter(10,60_000),requests=new Limiter(240,60_000);
  app.setErrorHandler((error: {statusCode?:number},_request,reply)=>{
    const code=error instanceof AdditionError||error instanceof SecretError?error.code:error.statusCode===413?'addition_invalid':'credential_failed';
    const status=code==='addition_not_found'?404:code==='addition_permission'?403:code==='addition_invalid'?400:code==='addition_limit'?429:code==='addition_conflict'||code==='addition_expired'?409:500;
    return reply.code(status).send({error:code});
  });
  app.addHook('onRequest',async(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    const keys=['user:'+user.id,'ip:'+request.ip];
    if(keys.some(key=>requests.blocked(key)))return reply.header('Retry-After','60').code(429).send({error:'too_many_attempts'});
    for(const key of keys)requests.record(key);
    if(request.method==='GET')return;
    const origin=request.headers.origin;
    let valid=false;
    try {const parsed=new URL(origin??'');valid=['http:','https:'].includes(parsed.protocol)&&parsed.origin===origin&&!parsed.username&&!parsed.password;}catch{/* Invalid Origin. */}
    if(!valid||!sameSite(origin!,request))return reply.code(403).send({error:'forbidden_origin'});
  });
  app.get<{Params:{board:string}}>('/api/boards/:board/catalogue',(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);return access?additions.catalogue(access.user.id,access.board.id):reply;
  });
  app.get('/api/connections',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    const boards=hub.directory.boards(user.id),personal=boards.find(board=>board.personal)!,names=hub.directory.view(personal.id).names;
    return {connections:hub.credentials!.list(user.id).map(record=>({...record,label:names[record.sourceId??'']??record.provider,lastSuccessAt:record.sourceId?hub.store.state(record.sourceId).successAt:null,
      placements:boards.filter(board=>record.sourceId&&hub.store.sources(board.id).some(source=>source.id===record.sourceId)).map(board=>({...board,visible:!hub.directory.view(board.id).hidden.includes('source:'+record.sourceId)}))}))};
  });
  app.post('/api/additions',{bodyLimit:32*1024},(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    const input=fields(request.body,['requestId','boardId','item']);
    if(!uuid(input.requestId)||input.boardId!==null&&!boardId(input.boardId))throw new AdditionError('addition_invalid');
    return additions.reserve(user.id,input.requestId,input.boardId as string|null,itemOf(input.item));
  });
  app.get<{Params:{id:string}}>('/api/additions/:id',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    if(!uuid(request.params.id))throw new AdditionError('addition_not_found');
    return additions.get(user.id,request.params.id);
  });
  app.get<{Querystring:{limit?:string;before?:string;requestId?:string}}>('/api/additions',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    const input=fields(request.query,[],['limit','before','requestId']),limit=input.limit===undefined?20:Number(input.limit);
    if(!Number.isInteger(limit)||limit<1||limit>50||input.before!==undefined&&(typeof input.before!=='string'||input.before.length>512)||input.requestId!==undefined&&!uuid(input.requestId))throw new AdditionError('addition_invalid');
    return additions.list(user.id,limit,input.before as string|undefined,input.requestId as string|undefined);
  });
  app.post<{Params:{id:string}}>('/api/additions/:id/run',{bodyLimit:32*1024},async(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    if(!uuid(request.params.id))throw new AdditionError('addition_not_found');
    const input=fields(request.body,[],['secret']),operation=additions.get(user.id,request.params.id);
    if(input.secret!==undefined&&(typeof input.secret!=='string'||input.secret.length>4096||!['connection','replace'].includes(operation.item.kind)))throw new AdditionError('addition_invalid');
    if(['ready','needs_input'].includes(operation.state)&&['connection','replace'].includes(operation.item.kind)) {
      const keys=['user:'+user.id,'ip:'+request.ip];
      if(keys.some(key=>attempts.blocked(key)))return reply.header('Retry-After','60').code(429).send({error:'too_many_attempts'});
      for(const key of keys)attempts.record(key);
    }
    return additions.run(user.id,request.params.id,input.secret,()=>currentUser(request,hub.directory)?.id===user.id);
  });
  if (!hub.local) {
    const onboarding=hub.deviceOnboarding!;
    app.post('/api/device-onboarding',(request,reply)=>{
      const user=guards.user(request,reply);if(!user)return reply;
      const input=fields(request.body,['requestId','boardId']);
      if(!uuid(input.requestId)||!boardId(input.boardId))throw new AdditionError('addition_invalid');
      return onboarding.reserve(user.id,input.requestId,input.boardId);
    });
    app.get<{Params:{id:string}}>('/api/device-onboarding/:id',(request,reply)=>{
      const user=guards.user(request,reply);if(!user)return reply;
      if(!uuid(request.params.id))throw new AdditionError('addition_not_found');
      return onboarding.get(user.id,request.params.id);
    });
    app.get<{Querystring:{limit?:string;before?:string}}>('/api/device-onboarding',(request,reply)=>{
      const user=guards.user(request,reply);if(!user)return reply;
      const input=fields(request.query,[],['limit','before']),limit=input.limit===undefined?20:Number(input.limit);
      if(!Number.isInteger(limit)||limit<1||limit>50||input.before!==undefined&&!uuid(input.before))throw new AdditionError('addition_invalid');
      return onboarding.list(user.id,limit,input.before as string|undefined);
    });
    app.post<{Params:{id:string}}>('/api/device-onboarding/:id/selection',(request,reply)=>{
      const user=guards.user(request,reply);if(!user)return reply;
      const input=fields(request.body,['requestId','deviceId','sourceIds']);
      if(!uuid(request.params.id)||!uuid(input.requestId)||!boardId(input.deviceId)||!Array.isArray(input.sourceIds)||input.sourceIds.length<1||input.sourceIds.length>100||!input.sourceIds.every(sourceId))throw new AdditionError('addition_invalid');
      return onboarding.select(user.id,request.params.id,input.deviceId,input.sourceIds,input.requestId);
    });
  }
}
