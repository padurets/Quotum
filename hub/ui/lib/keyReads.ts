import {KEY_IDS_LIMIT,KEY_IDS_QUERY_LIMIT} from '../../server/domain/sourceKeys';
import type {KeyPart,Meter} from '../../server/domain/meters';
import type {Card} from './types';
import {ApiError,call} from './http';

export type KeyPage={keys:KeyPart[];meters:Meter[];total:number;inventory:Card['inventory']|null;next:string|null};
type KeySelection=Pick<KeyPage,'keys'|'meters'>;

/** A saved selection can exceed one lookup; closing its consumer stops the next read. */
export async function readKeyIds(board:string,source:string,ids:readonly string[],signal?:AbortSignal):Promise<KeySelection>{
  signal?.throwIfAborted();
  const selected=[...new Set(ids)],result:KeySelection={keys:[],meters:[]};
  const base=`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(source)}/keys?ids=`;
  for(let from=0;from<selected.length;){
    signal?.throwIfAborted();
    let to=Math.min(selected.length,from+KEY_IDS_LIMIT),query=encodeURIComponent(JSON.stringify(selected.slice(from,to)));
    // Bound the encoded target too: legacy references need not be ASCII hashes.
    while(query.length>KEY_IDS_QUERY_LIMIT&&to>from+1){to--;query=encodeURIComponent(JSON.stringify(selected.slice(from,to)));}
    if(query.length>KEY_IDS_QUERY_LIMIT)throw new ApiError(400,'invalid_request');
    const page=await call<KeyPage>('GET',base+query,undefined,12_000,signal);
    signal?.throwIfAborted();
    result.keys.push(...page.keys);result.meters.push(...page.meters);from=to;
  }
  return result;
}
