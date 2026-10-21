import type {DatabaseSync} from 'node:sqlite';
import {canonicalPins,parseProjectColors,type ProjectColorPins,type StoredProjectColors} from '../domain/projectColors.js';

export function readProjectColors(db:DatabaseSync,board:string):StoredProjectColors&{revision:number} {
  const row=db.prepare('SELECT payload,revision FROM board_project_colors WHERE board_id=?').get(board);
  if(!row)return {version:1,pins:[],revision:0};
  const parsed=parseProjectColors(JSON.parse(String(row.payload))),revision=Number(row.revision);
  if(!parsed||!Number.isSafeInteger(revision)||revision<0)throw new Error('Invalid stored project colours');
  return {...parsed,revision};
}

/** Caller owns the transaction and publishes a board touch only when bytes change. */
export function saveProjectColors(db:DatabaseSync,board:string,pins:ProjectColorPins,user:string,now:number,baseRevision?:number):boolean {
  const next=parseProjectColors({version:1,pins}),current=readProjectColors(db,board);
  if(!next)throw new Error('Invalid stored project colours');
  if(JSON.stringify(current.pins)===JSON.stringify(canonicalPins(next.pins)))return false;
  // One editor save may have already reconciled an alias inside this transaction.
  const revision=(baseRevision??current.revision)+1;
  if(!Number.isSafeInteger(revision))throw new Error('Project colour revision exhausted');
  db.prepare('INSERT INTO board_project_colors VALUES (?,?,?,?,?) ON CONFLICT(board_id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
    .run(board,JSON.stringify(next),revision,user,now);
  return true;
}
