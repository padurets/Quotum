import type {FastifyInstance,onSendHookHandler} from 'fastify';
import type {Guards,Hub} from '../api.js';
import {projectColorsOf} from '../projectColors.js';
import {PROJECT_COLOR_BODY_BYTES,PROJECT_COLOR_PIN_LIMIT,parseProjectColorUpdate,parseProjectColorReset} from '../domain/projectColors.js';
import {readProjectColors,saveProjectColors} from '../store/projectColors.js';
import {currentUser} from '../session.js';
import {config} from '../config.js';

export function projectColorRoutes(app:FastifyInstance,hub:Hub,guards:Guards) {
  const colors=projectColorsOf(hub);
  const delivery:onSendHookHandler=(request,reply,payload,done)=>{
    if(typeof payload!=='string')return done(null,payload);
    const board=(request.params as {board:string}).board,user=currentUser(request,hub.directory);
    const send=(value:unknown)=>{reply.removeHeader('content-length');done(null,JSON.stringify(value));};
    if(!user){reply.code(401);return send({error:'unauthorized'});}
    const role=hub.directory.membership(board,user.id);
    if(!role){reply.code(404);return send({error:'board_not_found'});}
    const data=JSON.parse(payload);
    if(!data.authority)return done(null,payload);
    const current=colors.context(board);
    if(Array.isArray(data.projects)){
      if(data.authority!==current.envelope.authority||data.projects.some((name:string)=>!current.allowed(name))){reply.code(409);return send({error:'project_colors_context_changed',...current.envelope});}
      return send(data);
    }
    return send({...current.envelope,...(data.error?{error:data.error}:{})});
  };
  app.get<{Params:{board:string}}>('/api/boards/:board/project-colors',{onSend:delivery},(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    return colors.context(access.board.id).envelope;
  });
  app.get<{Params:{board:string};Querystring:{query?:string;cursor?:string}}>('/api/boards/:board/project-colors/choices',{onSend:delivery},(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    const {query='',cursor}=request.query;
    if(typeof query!=='string'||[...query].length>120||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>3000))return reply.code(400).send({error:'invalid_request'});
    try{
      const result=colors.choices(access.board.id,query,cursor);
      if(result.changed)return reply.code(409).send({error:'project_colors_context_changed',...result.envelope});
      const {projects,nextCursor,authority}=result;
      return {projects,...(nextCursor?{nextCursor}:{}),authority};
    }catch(error){if(error instanceof Error&&error.message==='invalid_cursor')return reply.code(400).send({error:'invalid_request'});throw error;}
  });
  for(const reset of [false,true]){
    app.route<{Params:{board:string}}>({method:reset?'POST':'PUT',url:'/api/boards/:board/project-colors'+(reset?'/reset':''),bodyLimit:PROJECT_COLOR_BODY_BYTES,onSend:delivery,handler(request,reply){
      const access=guards.board(request,reply,request.params.board);if(!access)return reply;
      if(access.board.role!=='owner')return reply.code(403).send({error:'forbidden'});
      const match=request.headers['if-match'];
      if(match===undefined||request.body&&typeof request.body==='object'&&!('authority' in request.body))return reply.code(428).send({error:'project_colors_reload_required'});
      if(typeof match!=='string'||!/^"(?:0|[1-9][0-9]*)"$/.test(match)||!Number.isSafeInteger(Number(match.slice(1,-1))))return reply.code(400).send({error:'invalid_request'});
      const patch=reset?null:parseProjectColorUpdate(request.body);
      const update=reset?parseProjectColorReset(request.body):patch;
      if(!update)return reply.code(400).send({error:'invalid_request'});
      return hub.directory.transaction(()=>{
        const board=access.board.id,context=colors.context(board),current=context.envelope;
        if(current.revision!==Number(match.slice(1,-1)))return reply.code(409).send({error:'project_colors_conflict',...current});
        if(current.authority!==update.authority)return reply.code(409).send({error:'project_colors_context_changed',...current});
        let pins=new Map(context.raw.pins);
        if(patch){
          if(!context.allowed(patch.project))return reply.code(400).send({error:'invalid_request'});
          let project=patch.project;
          if(patch.name!==undefined&&patch.name!==project){
            if(!hub.store.projectsOf(access.user.id,Date.now()-config.retention.sampleDays*86_400_000).some(group=>group.name===project))return reply.code(403).send({error:'forbidden'});
            hub.store.nameProjects(access.user.id,[project],patch.name);project=patch.name;
            pins=new Map(readProjectColors(hub.store.db,board).pins);
          }
          if('color' in patch){
            if(!colors.context(board).allowed(project))throw Object.assign(new Error('Invalid project'),{statusCode:400});
            if(patch.color===null)pins.delete(project);else pins.set(project,patch.color!);
          }
        }else pins.clear();
        // Throwing rolls back aliases too; returning an error reply would commit them.
        if(pins.size>PROJECT_COLOR_PIN_LIMIT)throw Object.assign(new Error('Project colour limit'),{statusCode:413});
        if(saveProjectColors(hub.store.db,board,[...pins],access.user.id,Date.now(),current.revision))hub.store.projectColorsChanged(board);
        return colors.context(board).envelope;
      });
    }});
  }
}
