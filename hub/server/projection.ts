import {level, sameWindow, type AttentionState, type Candidate} from './domain/attention.js';
import {sourceHidden, isWindowHidden, titled} from './domain/presentation.js';
import type {Refresh} from './domain/refresh.js';
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
export type SourcePart = {card: Card; sessions: BoardSession[]; cadence: Cadence; refresh: Refresh};
export type ReaderPart = {mine: string[]; boards: Board[]};
export type HubPart = {resets: Partial<Record<ResetProvider, ResetStatus>>; trackers: TrackerHealth[]; past: Record<string, Announcement[]>};

/** The whole board for one reader at once (spec: `snapshot`). */
export type Snapshot = Omit<BoardPart, 'lineup'> & {
  historyStart: number;
  sources: Card[];
  sessions: Record<string, BoardSession[]>;
  cadence: Record<string, Cadence>;
  refresh: Record<string, Refresh>;
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

  /**
   * Whose agents' work the board's history shows, from when and under which names
   * (Store.workKey): when it changes, all of that history reads otherwise.
   */
  workKey(board: string): string {
    const {store, directory} = this.hub;
    return store.workKey(board, store.shown(board, directory.view(board).hidden));
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
    const refresh = ingest.refresh(source.id, now);
    const cadence = ingest.nextMeasurement(source.id, source.account, now);
    return {
      value: {card, sessions: ingest.live.of(source.id, people, now), cadence: cadence.value, refresh: refresh.value},
      changesAt: earliest(...state.windows.map(w => w.resetAt !== null && w.resetAt > now ? w.resetAt : null), stale ? null : state.successAt! + state.staleAfterMs! + 1, ingest.live.ofChangesAt(source.id, people, now), cadence.changesAt, refresh.changesAt),
    };
  }

  /** The same visible figures as the cards, with data quality independent of their level. */
  attention(board: string, now: number): AttentionState {
    const view = this.hub.directory.view(board);
    const cards = this.attentionCards(board, now).filter(c => !sourceHidden(view, c.id));
    let minimum: AttentionState['minimum'] = null;
    let partial = false;
    for (const card of cards) {
      const windows = card.windows.filter(w => !isWindowHidden(view, card.id, w.id));
      // A waiting source has no windows yet; it still makes a known minimum partial.
      if (!card.windows.length || windows.length) partial ||= card.stale || !!card.error || card.successAt === null;
      for (const w of windows) {
        if (!Number.isFinite(w.remaining)) { partial = true; continue; }
        if (!minimum || w.remaining < minimum.remaining) minimum = {sourceId: card.id, windowId: w.id, remaining: w.remaining};
        if (w.resetAt !== null && w.resetAt <= now) partial = true;
      }
    }
    return {boardId: board, level: minimum ? level(minimum.remaining) : null, quality: minimum ? partial ? 'partial' : 'current' : 'unavailable', minimum};
  }

  private attentionCards(board: string, now: number) {
    const members = this.members(board);
    return this.lineup(board).map(s => this.sourcePart(s, members, now).value.card);
  }

  /** Visibility and names are resolved again at delivery, after any intervening edit. */
  visibleCandidates(board: string, candidates: Candidate[], now: number): Candidate[] {
    const view = this.hub.directory.view(board);
    const cards = titled(this.attentionCards(board, now), view.names).filter(c => !sourceHidden(view, c.id));
    return candidates.flatMap((c): Candidate[] => {
      if (c.kind === 'announcement') return cards.some(s => s.provider === c.provider && s.windows.some(w => !isWindowHidden(view, s.id, w.id))) ? [c] : [];
      const source = cards.find(s => s.id === c.sourceId);
      const window = source?.windows.find(w => w.id === c.windowId && !isWindowHidden(view, source.id, w.id));
      if (!source || !window || !sameWindow(c.window, window)) return [];
      // Coalescing may hide an intermediate identity change from the card delta.
      // The ledger also rejects a candidate when an old label comes back later.
      const cycle = this.hub.store.attentionCycle(c.sourceId, c.windowId);
      return c.id === `${c.sourceId}/${c.windowId}/${cycle}/${c.kind}` ? [{...c, name: source.title}] : [];
    });
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
      refresh: Object.fromEntries(lineup.map((s, i) => [s.id, sources[i].refresh])),
      mine: this.mine(user, lineup),
      boards: this.boards(user),
      resets: this.hubPart(now).value,
    };
  }
}
