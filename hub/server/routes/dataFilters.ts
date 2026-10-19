import type {FastifyInstance} from 'fastify';
import type {Guards,Hub} from '../api.js';
import {FILTER_BODY_LIMIT,FILTER_BYTES,jsonBytes,parseFilterUpdate} from '../domain/dataFilters.js';
import {mergeStoredFilters,projectStoredFilters} from '../domain/dataFilterStorage.js';
import {executableWorkFilters,filterContext,filterEnvelope} from '../dataFilters.js';

export function dataFilterRoutes(app:FastifyInstance,hub:Hub,guards:Guards) {
  app.get<{Params:{board:string}}>('/api/boards/:board/filters',(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    return reply.header('Cache-Control','no-store').send(filterEnvelope(hub.directory,hub.store,access.board.id,filterContext(hub.store,access.board.id,hub.ingest)));
  });
  app.put<{Params:{board:string}}>('/api/boards/:board/filters',{bodyLimit:FILTER_BODY_LIMIT},(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    if(access.board.role!=='owner')return reply.code(403).send({error:'forbidden'});
    const match=request.headers['if-match'];
    if(match===undefined||!request.body||typeof request.body==='object'&&!('authority' in request.body))return reply.code(428).send({error:'filters_reload_required'});
    if(typeof match!=='string'||!/^"(?:0|[1-9][0-9]*)"$/.test(match)||!Number.isSafeInteger(Number(match.slice(1,-1))))return reply.code(400).send({error:'invalid_request'});
    if(typeof request.body==='object'&&request.body!==null&&'filters' in request.body&&jsonBytes(request.body.filters)>FILTER_BYTES)return reply.code(413).send({error:'filters_limit'});
    const update=parseFilterUpdate(request.body);if(!update)return reply.code(400).send({error:'invalid_request'});
    return hub.directory.transaction(()=>{
      const board=access.board.id,context=filterContext(hub.store,board,hub.ingest),current=hub.directory.filtersState(board),envelope=filterEnvelope(hub.directory,hub.store,board,context);
      if(current.revision!==Number(match.slice(1,-1)))return reply.code(409).send({error:'filters_conflict',...envelope});
      if(context.authority!==update.authority)return reply.code(409).send({error:'filters_context_changed',...envelope});
      const merged=mergeStoredFilters(current,update,context.allowed,context.automatic);
      if(!merged)return reply.code(400).send({error:'invalid_request'});
      if(!executableWorkFilters(projectStoredFilters(merged,context.allowed).filters))return reply.code(413).send({error:'filters_limit'});
      hub.directory.saveFilters(board,merged.filters,access.user.id,Date.now(),merged.retained);
      return reply.header('Cache-Control','no-store').send(filterEnvelope(hub.directory,hub.store,board,filterContext(hub.store,board,hub.ingest)));
    });
  });
}
