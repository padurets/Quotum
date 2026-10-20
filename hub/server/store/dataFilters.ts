import type {DatabaseSync} from 'node:sqlite';
import {decodeFixedView,decodeView,encodeView} from '../domain/view.js';
import {filtersFromView} from '../domain/dataFilterMerge.js';

/** Run after the released view upgrades, inside their schema transaction. */
export function migrateDataFilters(db:DatabaseSync,now:number,original:ReadonlyMap<string,number>) {
  const boards=db.prepare('SELECT b.id,b.created_by,v.payload,v.updated_by FROM boards b LEFT JOIN views v ON v.board_id=b.id').all();
  for(const board of boards){
    const raw=board.payload?JSON.parse(String(board.payload)):undefined;
    if(decodeView(raw))continue;
    const view=decodeFixedView(raw);
    if(!view)throw new Error('Invalid stored board view');
    const filters=filtersFromView(view),revision=(original.get(String(board.id))??0)+1;
    if(!Number.isSafeInteger(revision))throw new Error('View revision exhausted');
    const next={...view,version:5 as const,windows:[],shown:view.shown.filter(id=>!id.includes('/key:'))};
    if(!decodeView(encodeView(next)))throw new Error('Invalid migrated board view');
    db.prepare('INSERT INTO board_filters VALUES (?,?,0,?,?)').run(board.id,JSON.stringify(filters),board.updated_by??board.created_by,now);
    db.prepare('UPDATE views SET payload=?,revision=? WHERE board_id=?').run(JSON.stringify(encodeView(next)),revision,board.id);
  }
}
