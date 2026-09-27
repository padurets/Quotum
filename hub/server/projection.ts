import {config} from './config.js';
import type {Ingest} from './ingest.js';
import type {ResetFeed, TrackerHealth} from './resets.js';
import type {BoardSession} from './sessions.js';
import type {Why} from './cadence.js';
import type {SourceState} from './domain/quota.js';
import type {ResetProvider, ResetStatus} from './domain/resets.js';
import type {View} from './domain/view.js';
import type {Board, Directory} from './store/directory.js';
import type {Announcement, BoardSource, Store} from './store/store.js';

/**
 * What a board shows, as parts that change apart (spec/dashboard-v1.md): the board itself
 * (its name, view and cards), each of its sources, what is the reader's own, and what is
 * the same for the whole hub. `/api/overview` is put together from them, and so are the
 * page's events: one reading of the rules, never repeated.
 *
 * A part that changes with time alone says when: `changesAt` is the first moment after
 * `now` it may read otherwise with nothing new told to the hub (a card goes stale, a
 * machine's list of agents stops showing, a holder falls silent), sometimes sooner, never
 * later; null when only news changes it.
 */

export type Timed<T> = {value: T; changesAt: number | null};

/** A source as a card shows it: its state, whose it is on this board, and whether its numbers are too old. */
export type Card = SourceState & {owners: string[]; stale: boolean};

/** When a source is measured next and why, while its holder follows the hub's pace. */
export type Cadence = {next: number; why: Why} | null;

export type BoardPart = {board: {id: string; name: string; personal: boolean}; view: View; lineup: string[]};
export type SourcePart = {card: Card; sessions: BoardSession[]; cadence: Cadence};
export type ReaderPart = {mine: string[]; boards: Board[]};
export type HubPart = {resets: Partial<Record<ResetProvider, ResetStatus>>; trackers: TrackerHealth[]; past: Record<string, Announcement[]>};

/** The whole board for one reader at once (spec: `snapshot`). */
export type Snapshot = Omit<BoardPart, 'lineup'> & {
  historyStart: number;
  sources: Card[];
  sessions: Record<string, BoardSession[]>;
  cadence: Record<string, Cadence>;
} & ReaderPart & {resets: HubPart};

/** The first of several moments, null when there is none. */
export const earliest = (...moments: (number | null)[]): number | null => {
  const found = moments.filter((at): at is number => at !== null);
  return found.length ? Math.min(...found) : null;
};

const DAY = 86_400_000;

export class Projection {
  constructor(private readonly hub: {store: Store; directory: Directory; ingest: Ingest; resets: ResetFeed}) {}

  /** The sources a board shows, in order, with whose they are. */
  lineup(board: string): BoardSource[] {
    return this.hub.store.sources(board);
  }

  /** The board: its name, how it is arranged, which sources it shows in which order; null once it is gone. */
  boardPart(board: string, lineup = this.lineup(board)): BoardPart | null {
    const found = this.hub.directory.board(board);
    if (!found) return null;
    return {board: found, view: this.hub.directory.view(board), lineup: lineup.map(s => s.id)};
  }

  /** The people on a board, by id, with their names: whose each source is, and whose agents it shows. */
  members(board: string): Map<string, string> {
    return new Map(this.hub.directory.members(board).map(m => [m.id, m.name]));
  }

  /** One source of a board: its card, the agents running on it on the machines of its people there, and its pace. */
  sourcePart(source: BoardSource, members: Map<string, string>, now: number): Timed<SourcePart> {
    const {store, ingest} = this.hub;
    const state = store.state(source.id);
    const stale = state.successAt === null || state.staleAfterMs === null || now - state.successAt > state.staleAfterMs;
    const card: Card = {...state, owners: source.holders.flatMap(id => members.get(id) ?? []).sort(), stale};
    const people = source.holders.filter(id => members.has(id));
    const cadence = ingest.nextMeasurement(source.id, source.account, now);
    return {
      value: {card, sessions: ingest.live.of(source.id, people, now), cadence: cadence.value},
      changesAt: earliest(stale ? null : state.successAt! + state.staleAfterMs! + 1, ingest.live.ofChangesAt(source.id, people, now), cadence.changesAt),
    };
  }

  /** What is the reader's own on a board: which of its sources their devices measure. */
  mine(user: string, lineup: BoardSource[]): string[] {
    return lineup.filter(s => s.holders.includes(user)).map(s => s.id);
  }

  /** What is the reader's own on every board: their boards with their role on each. */
  boards(user: string): Board[] {
    return this.hub.directory.boards(user);
  }

  /** The same for everyone: the reset trackers' news, how they are doing, and the resets they reported as far back as history goes. */
  hubPart(now: number): Timed<HubPart> {
    const kept = config.retention.sampleDays * DAY;
    const past = this.hub.store.announcements(now - kept);
    // The oldest leaves the list as it falls out of the history.
    const oldest = earliest(...Object.values(past).map(list => list[0]?.at ?? null));
    return {value: {...this.hub.resets.snapshot(), past}, changesAt: oldest === null ? null : oldest + kept + 1};
  }

  /** The board as the reader sees it now; null once it is gone. */
  snapshot(user: string, board: string, now: number): Snapshot | null {
    const lineup = this.lineup(board);
    const part = this.boardPart(board, lineup);
    if (!part) return null;
    const members = this.members(board);
    const sources = lineup.map(source => this.sourcePart(source, members, now).value);
    return {
      board: part.board,
      view: part.view,
      historyStart: this.hub.store.historyStart(now),
      sources: sources.map(s => s.card),
      sessions: Object.fromEntries(lineup.map((s, i) => [s.id, sources[i].sessions])),
      cadence: Object.fromEntries(lineup.map((s, i) => [s.id, sources[i].cadence])),
      mine: this.mine(user, lineup),
      boards: this.boards(user),
      resets: this.hubPart(now).value,
    };
  }
}
