import type {HubEvent} from './board';

/** Work cutoffs retire evidence even when the board's authority string is unchanged. */
export function workChange(data:Extract<HubEvent,{type:'history'}>['data'],sources:readonly string[],before=Infinity) {
  const own=data.workSince!==undefined&&data.workSince<before;
  const changes=data.changes?.filter(change=>change.scope==='quota'&&sources.includes(change.source));
  const legacy=!data.changes&&data.workSince===undefined&&data.sources.some(id=>sources.includes(id));
  const relevant=changes?.filter(change=>(change.workSince??change.since)<before)??[];
  const retired=own&&data.workSince===0||relevant.some(change=>change.since===0||change.workSince===0)||legacy&&data.since===0;
  const since=Math.min(own?data.workSince!:Infinity,...relevant.map(change=>change.workSince??(change.since===0?0:Infinity)),legacy?data.since:Infinity);
  return {retired,since};
}
