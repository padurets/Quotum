import {page} from './board';
import {dataFilters,setFilterCards} from './dataFilters';
import {call} from './http';
import {publishDataFilters} from './filterSelection';
import type {FilterEnvelope} from '../../server/domain/dataFilters';

/** The ordinary stream supplies configuration; old bootstraps get one metadata read. */
export function followDataFilters(user:string,board:string,savedOnly=false){
  dataFilters.open(user,board,savedOnly);
  let loading=false,retired=false,version=0;
  const sync=()=>{
    const current=page.get().board;if(!current||current.id!==board)return;
    setFilterCards(current.lineup.flatMap(id=>current.cards[id]??[]));
    if(current.filters&&current.filters.revision===current.filtersRevision&&current.filters.authority===current.filtersAuthority){version++;dataFilters.accept(current.filters);return;}
    if(current.filtersRevision!==undefined||loading)return;
    loading=true;const captured=++version;
    void call<FilterEnvelope>('GET','/api/boards/'+encodeURIComponent(board)+'/filters').then(envelope=>{
      if(!retired&&captured===version&&page.get().board?.id===board)dataFilters.accept(envelope);
    }).catch(()=>{});
  };
  const stop=page.listen(sync);sync();
  return()=>{retired=true;stop();dataFilters.close();publishDataFilters(null,false);};
}
