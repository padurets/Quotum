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
  /** A source has measurements at `since` or later that its charts have not shown. */
  history(source: string, since: number): void;
  /** Some sessions of this person may have ended. */
  dropSessions(user: string): void;
  /** This person may be off this board. */
  dropMember(board: string, user: string): void;
  /** This board may be gone. */
  dropBoard(board: string): void;
};

/** Tells the observer, if there is one; its trouble is logged and never undoes the change told of. */
export function tell(observer: Touches | null, touch: (observer: Touches) => void) {
  if (!observer) return;
  try {
    touch(observer);
  } catch (error) {
    console.error(JSON.stringify({event: 'error', url: 'events', message: String((error as Error)?.message ?? error)}));
  }
}
