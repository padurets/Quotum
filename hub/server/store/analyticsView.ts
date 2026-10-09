import type {DatabaseSync} from 'node:sqlite';
import {legacyWidgetTargets, migrateAnalytics, type AnalyticsResources} from '../domain/analyticsView.js';
import {providers} from '../domain/providers.js';
import {budgetAccess} from '../domain/resources.js';

/** Membership alone determines relevance, even while a supplier has no accepted samples. */
export function analyticsResources(db: DatabaseSync, board: string): AnalyticsResources {
  const owner = db.prepare('SELECT personal, created_by FROM boards WHERE id=?').get(board) as {personal: number; created_by: string} | undefined;
  if (!owner) return [];
  const rows = owner.personal
    ? db.prepare('SELECT s.id,s.provider FROM holders h JOIN sources s ON s.id=h.source_id WHERE h.user_id=? ORDER BY h.since,s.rowid').all(owner.created_by)
    : db.prepare('SELECT s.id,s.provider,h.budget_since,h.budget_anchor_at,h.budget_revision FROM shares h JOIN sources s ON s.id=h.source_id WHERE h.board_id=? ORDER BY h.shared_at,s.rowid').all(board);
  return (rows as {id:string;provider:string;budget_since:number|null;budget_anchor_at:number|null;budget_revision:string}[]).map(row=>({id:row.id,provider:row.provider,budget:budgetAccess(row.provider,!!owner.personal,row)})).sort((a,b) => providers.indexOf(a.provider as typeof providers[number]) - providers.indexOf(b.provider as typeof providers[number]));
}

/** Called inside the schema transaction, before the upgraded database can be served. */
export function migrateAnalyticsViews(db: DatabaseSync, now: number) {
  const boards = db.prepare('SELECT b.id,b.created_by,v.payload,v.revision,v.updated_by FROM boards b LEFT JOIN views v ON v.board_id=b.id').all() as {id: string; created_by: string; payload: string | null; revision: number | null; updated_by: string | null}[];
  for (const board of boards) {
    const resources = analyticsResources(db, board.id), input = board.payload ? JSON.parse(board.payload) : undefined;
    const view = migrateAnalytics(input, resources);
    if (input?.version === 2) continue;
    db.prepare('INSERT INTO views(board_id,payload,updated_by,updated_at,revision) VALUES(?,?,?,?,?) ON CONFLICT(board_id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision').run(board.id, JSON.stringify(view), board.updated_by ?? board.created_by, now, (board.revision ?? 0) + 1);
    const receipts = db.prepare("SELECT id,item FROM board_additions WHERE board_id=? AND json_extract(item,'$.kind')='widget'").all(board.id) as {id: string; item: string}[];
    for (const receipt of receipts) {
      const item = JSON.parse(receipt.item) as {widgetId: string};
      const targets = legacyWidgetTargets(item.widgetId, resources.map(source=>source.provider==='codex'?{...source,budget:{enabled:false}}:source), !resources.length);
      db.prepare('UPDATE board_additions SET widget_targets=? WHERE id=?').run(JSON.stringify(targets), receipt.id);
    }
  }
}
