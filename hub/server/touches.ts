import type {HistoryScope} from './domain/history.js';
/**
 * What changes data tells the events of open dashboards (events.ts): what it touched.
 * Store, Directory, Ingest and the reset feed tell it as they change; working out what
 * readers see is left for later, so a change costs a note here and no more.
 */
export type Touches = {
  /** These sources changed: their cards, agents and pace, on every board that shows them. */
  touchSources(ids: string[]): void;
  /** These boards changed as a whole: their name, view, sources, or who is on them. */
  touchBoards(ids: string[]): void;
  /** What is this person's own changed: their boards, or which sources they measure. */
  touchUser(user: string): void;
  /** What is the same for everyone changed: the reset trackers' news. */
  touchHub(): void;
  /** A source's history changed from `since`: a measurement or credited agent work. */
  history(source: string, since: number, scopes?: readonly HistoryScope[], work?: boolean): void;
  touchClientSessions?(user: string): void;
  clientHistory?(user: string, since: number): void;
  /** Some sessions of this person may have ended. */
  dropSessions(user: string): void;
  /** This person may be off this board. */
  dropMember(board: string, user: string): void;
  /** This board may be gone. */
  dropBoard(board: string): void;
};

/** Tells the observer, if there is one; its trouble is logged and never undoes the change told of. */
let pending: (() => void)[] | null = null;

/** Synchronous database work publishes its changes only after the outer commit. */
export function transaction<T>(db: import('node:sqlite').DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec('BEGIN IMMEDIATE');
  const previous = pending, changes: (() => void)[] = [];
  pending = changes;
  let result: T;
  try {result = work(); db.exec('COMMIT');}
  catch (error) {db.exec('ROLLBACK'); throw error;}
  finally {pending = previous;}
  for (const change of changes) afterCommit(change);
  return result;
}

export function afterCommit(work: () => void) {
  if (pending) {pending.push(work); return;}
  try {work();} catch (error) {trouble(error);}
}

export function tell(observer: Touches | null, touch: (observer: Touches) => void) {
  if (!observer) return;
  afterCommit(() => touch(observer));
}

/** Logs trouble with the events of open dashboards, which never takes the hub down. */
export function trouble(error: unknown) {
  console.error(JSON.stringify({event: 'error', url: 'events', message: String((error as Error)?.message ?? error)}));
}
