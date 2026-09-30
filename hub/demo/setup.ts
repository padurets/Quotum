import {COLUMNS, defaultWidth, starts, type Layout} from '../ui/lib/grid.js';
import type {Store, WorkKey} from '../server/store/store.js';
import {parseSessions} from '../server/domain/ingest.js';
import {Agent, Person} from './client.js';
import {
  awake,
  boards,
  cards,
  delivered,
  failuresAt,
  historyTimes,
  holdersOf,
  HOUR,
  homeOf,
  isOn,
  machineInfo,
  machines,
  MIN,
  people,
  personOf,
  problems,
  sessionsAt,
  snapshot,
  sourceOf,
  workSince,
  staleAfter,
  type Card,
  type DemoSet,
  type Machine,
} from './model.js';

/** Everyone signs in with this password: the demo is thrown away when it stops. */
export const PASSWORD = 'quotum-demo';

export const emailOf = (person: string) => `${person}@demo.quotum`;

/** A set brought up on a hub: who is who there, by the catalogue's names. */
export type Stand = {
  set: DemoSet;
  start: number;
  people: Map<string, Person>;
  /** Hub board ids by the catalogue's board ids; a person's id names their personal board. */
  boards: Map<string, string>;
  agents: Map<string, Agent>;
  /** Source ids by card id. */
  sources: Map<string, string>;
};

/** A batch holds at most this many measurements (spec: Batch). */
const BATCH = 500;

/** How long a still stand's last measurements hold from its start: longer than any run of the benchmark. */
const STILL_FOR = 3 * HOUR;

/**
 * Brings a set up on a fresh hub through its public requests, as people and agents would:
 * sign-ups and invites, boards, machine tokens and a code, the history of every card, the
 * failures, shares and every board's view. `now` is the hub's clock. `still`: the last
 * measurement of every card still fresh at `start` holds until `start + STILL_FOR`, so no
 * card goes stale while nothing is measured.
 */
export async function setUp(base: string, set: DemoSet, start: number, setupCode: string, now: () => number, still = false): Promise<Stand> {
  const wrong = problems(set);
  if (wrong.length) throw new Error(`the set ${set.id} is not right: ${wrong.join('; ')}`);
  const stand: Stand = {set, start, people: new Map(), boards: new Map(), agents: new Map(), sources: new Map()};
  await signUpEveryone(base, set, setupCode, stand);

  // Every machine says hello first, so it is known (and can be renamed) before it measures.
  const tokens = new Map<string, string>();
  for (const machine of machines(set)) {
    const person = stand.people.get(personOf(set, machine))!;
    const info = machineInfo(machine);
    let agent: Agent;
    if (machine.byCode) agent = await Agent.byCode(base, info, person);
    else {
      if (!tokens.has(person.id)) tokens.set(person.id, await person.machineToken('Demo machines'));
      agent = new Agent(base, info, tokens.get(person.id)!);
    }
    await agent.sessions([], now());
    stand.agents.set(machine.id, agent);
  }
  for (const machine of machines(set).filter(m => m.renamed)) {
    const person = stand.people.get(personOf(set, machine))!;
    const devices = await person.get<{id: string; reported: string}[]>('/api/devices');
    await person.renameDevice(devices.find(d => d.reported === machine.id)!.id, machine.renamed!);
  }
  // Before any agent reports: a name nothing has reported yet is corrected all the same.
  for (const person of people(set)) {
    for (const [reported, name] of Object.entries(person.projects ?? {})) await stand.people.get(person.id)!.renameProject(reported, name);
  }

  for (const card of cards(set)) {
    stand.sources.set(card.id, sourceOf(card, stand.people.get(homeOf(set, card))!.id));
    await seed(stand, card, now, still);
    if (card.measureIntervalMs != null) {
      const person = stand.people.get(homeOf(set, card))!;
      await person.post(`/api/boards/${stand.boards.get(homeOf(set, card))!}/sources/${stand.sources.get(card.id)!}/frequency`, {intervalMs: card.measureIntervalMs});
    }
    // The other machines join: their first measurement (the hub has it already) makes
    // their people hold it, so their agents show on it from the first list.
    const last = historyTimes(set, card).at(-1)!;
    for (const machine of card.machines.slice(1)) await stand.agents.get(machine)!.ingest([measured(card, start, last, still)], [], now());
  }
  // Failures last: a later measurement of the same client would clear them.
  for (const machine of machines(set).filter(m => awake(m, -MIN))) {
    const failures = failuresAt(set, machine, start, -MIN);
    if (failures.length) await stand.agents.get(machine.id)!.ingest([], failures, now());
  }

  for (const card of cards(set)) {
    for (const board of Object.keys(card.on ?? {}).filter(key => !stand.people.has(key))) {
      // Shared by one of those who measure it that is on the board, its first machine's person first.
      const on = boards(set).find(b => b.id === board)!;
      const sharer = [homeOf(set, card), ...holdersOf(set, card)].find(person => person === on.owner || on.members.includes(person))!;
      await stand.people.get(sharer)!.share(stand.boards.get(board)!, stand.sources.get(card.id)!);
    }
  }
  for (const [key, board] of stand.boards) await ownerOf(stand, key).saveView(board, viewOf(stand, key));
  return stand;
}

/** The first person with the setup code, then everyone else with an invite to a board they are on. */
async function signUpEveryone(base: string, set: DemoSet, setupCode: string, stand: Stand) {
  const invites = new Map<string, string[]>();
  const signUp = async (id: string, access: {setupCode: string} | {invite: string}) => {
    const entry = people(set).find(p => p.id === id)!;
    const person = await Person.signUp(base, {email: emailOf(id), name: entry.name, password: PASSWORD}, access);
    stand.people.set(id, person);
    stand.boards.set(id, person.personalBoard);
    for (const invite of (invites.get(id) ?? []).slice('invite' in access ? 1 : 0)) await person.accept(invite);
    invites.delete(id);
  };
  await signUp(people(set)[0].id, {setupCode});
  for (let progress = true; progress; ) {
    progress = false;
    for (const board of boards(set)) {
      const owner = stand.people.get(board.owner);
      if (stand.boards.has(board.id) || !owner) continue;
      stand.boards.set(board.id, await owner.createBoard(board.name));
      for (const member of board.members) {
        const invite = await owner.invite(stand.boards.get(board.id)!);
        const person = stand.people.get(member);
        if (person) await person.accept(invite);
        else invites.set(member, [...(invites.get(member) ?? []), invite]);
      }
      progress = true;
    }
    for (const [member, pending] of invites) {
      await signUp(member, {invite: pending[0]});
      progress = true;
    }
  }
  const missing = people(set).filter(p => !stand.people.has(p.id));
  if (missing.length) throw new Error(`the catalogue invites nobody of ${missing.map(p => p.id).join(', ')} to a board, so they cannot sign up`);
}

/** A card's seeded measurement at `t`; in a still stand, the last one holds for `STILL_FOR` if it is still fresh at the start. */
function measured(card: Card, start: number, {t, step}: {t: number; step: number}, still: boolean, last = true) {
  const taken = snapshot(card, start, t, step);
  return still && last && t + staleAfter(step) > 0 ? {...taken, staleAfterMs: STILL_FOR - t} : taken;
}

/** Sends a card's history from its first machine, oldest first; every measurement must be new to the hub. */
async function seed(stand: Stand, card: Card, now: () => number, still: boolean) {
  const agent = stand.agents.get(card.machines[0])!;
  const times = historyTimes(stand.set, card);
  for (let i = 0; i < times.length; i += BATCH) {
    const batch = times.slice(i, i + BATCH).map((time, j) => measured(card, stand.start, time, still, i + j === times.length - 1));
    const answer = await agent.ingest(batch, [], now());
    if (answer.accepted !== batch.length || answer.duplicates) {
      throw new Error(`card ${card.id}: the hub took ${answer.accepted} of ${batch.length} measurements (${answer.duplicates} duplicates)`);
    }
  }
}

const ownerOf = (stand: Stand, key: string) => stand.people.get(boards(stand.set).find(b => b.id === key)?.owner ?? key)!;

/** A board's view: its cards in the catalogue's order with their looks there, then the agents, agent activity, the chart and the table. */
export function viewOf(stand: Stand, key: string) {
  const {set} = stand;
  const personal = stand.people.has(key);
  const shown = cards(set).filter(card => (personal ? holdersOf(set, card).includes(key) : !!card.on?.[key]));
  const board = boards(set).find(b => b.id === key) ?? people(set).find(p => p.id === key);
  const view = {
    layout: {columns: COLUMNS, places: {}} as Layout,
    names: {} as Record<string, string>,
    hidden: [] as string[],
    shown: board?.agents ? ['agents'] : [],
    windows: [] as string[],
    plans: {} as Record<string, number[]>,
    unplanned: [] as string[],
    colors: {} as Record<string, string>,
    columns: {},
    shownColumns: board?.kind === 'board' && board.tableColumns ? {forecast: board.tableColumns} : {},
  };
  let cursor = 0;
  let rank = 0;
  const place = (w: number) => {
    const x = starts(COLUMNS, w).find(x => x >= cursor) ?? 0;
    cursor = x + w;
    return {x, y: rank++, w};
  };
  for (const card of shown) {
    const source = stand.sources.get(card.id)!;
    const looks = card.on?.[key] ?? {};
    const id = `source:${source}`;
    view.layout.places[id] = looks.place ?? place(looks.width ?? defaultWidth(id, COLUMNS));
    if (looks.name) view.names[source] = looks.name;
    if (looks.color) view.colors[source] = looks.color;
    if (looks.hidden) view.hidden.push(`source:${source}`);
    for (const window of looks.windows ?? []) view.windows.push(`${source}/${window}`);
    if (looks.plan === 'off') view.unplanned.push(source);
    else if (looks.plan) view.plans[source] = looks.plan;
  }
  view.layout.places.agents = board?.agentsPlace ?? place(COLUMNS);
  rank = cursor = 0;
  for (const id of ['activity', 'history', 'forecast'] as const) {
    const auto = place(id === 'forecast' ? board?.forecastWidth ?? COLUMNS : COLUMNS);
    view.layout.places[id] = board?.places?.[id] ?? auto;
  }
  return view;
}

/**
 * Writes how the agents of a stand worked before `start` straight into its hub's database
 * (`store`), as the hub credits the lists machines send (server/sessions.ts): each working
 * agent of an awake machine, a minute at a time, from when the hub is taken to have kept
 * work (`workSince`) on. Public requests cannot tell the past: the hub credits work by its
 * own clock, from the list it has now. The lists `Live` sends go on with the same sessions.
 * People joined boards and shared cards at `start`, in `setUp`: all of it moves back to
 * when the hub began keeping work, in the same order, and a member a board says `joined`
 * later joins then. In one transaction, with the hub running: nothing else writes then.
 */
export function seedWork(store: Store, stand: Stand) {
  const {set, start} = stand;
  const since = workSince(set);
  const {db} = store;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'agentWorkSince'").run(String(start + since));
    const earliest = (db.prepare('SELECT min(at) AS at FROM (SELECT joined_at AS at FROM members UNION ALL SELECT shared_at FROM shares)').get() as {at: number}).at;
    db.prepare('UPDATE members SET joined_at = joined_at - ?').run(earliest - (start + since));
    db.prepare('UPDATE shares SET shared_at = shared_at - ?').run(earliest - (start + since));
    for (const board of boards(set)) {
      for (const [person, at] of Object.entries(board.joined ?? {})) {
        db.prepare('UPDATE members SET joined_at = ? WHERE board_id = ? AND user_id = ?').run(start + at, stand.boards.get(board.id)!, stand.people.get(person)!.id);
      }
    }
    for (const machine of machines(set)) {
      const device = (db.prepare('SELECT id FROM devices WHERE user_id = ? AND machine_id = ?').get(stand.people.get(personOf(set, machine))!.id, machineInfo(machine).id) as {id: string}).id;
      // Its agents that ever work, each with the names the hub files it under, read as the hub reads a list.
      const agents = cards(set).flatMap(card =>
        (card.agents ?? [])
          .filter(agent => agent.machine === machine.id && agent.works)
          .map(agent => {
            const [told] = parseSessions({
              version: 1,
              agent: Agent.VERSION,
              machine: machineInfo(machine),
              sentAt: new Date(start).toISOString(),
              sessions: [{provider: card.provider, origin: agent.origin, project: agent.project, folder: agent.folder, startedAt: new Date(start + agent.since).toISOString(), working: true}],
            }).sessions;
            return {agent, key: {source: stand.sources.get(card.id)!, origin: told.origin, startedAt: told.startedAt, project: told.project ?? '', folder: told.folder ?? ''}};
          }),
      );
      const open = new Map<string, {key: WorkKey; from: number; to: number}>();
      const credit = (stretch: {key: WorkKey; from: number; to: number}) => store.creditWork(device, start + stretch.from, start + stretch.to, [stretch.key]);
      for (let t = since; t < 0; t += MIN) {
        // Agents alike in all of it are told apart by their place among those working, as the hub tells them.
        const alike = new Map<string, number>();
        const working = new Set<string>();
        for (const {agent, key} of awake(machine, t) ? agents : []) {
          if (agent.since > t || (agent.until !== undefined && t >= agent.until) || !isOn(agent.works!, t)) continue;
          const plain = JSON.stringify(key);
          const ordinal = alike.get(plain) ?? 0;
          alike.set(plain, ordinal + 1);
          const id = `${plain} ${ordinal}`;
          working.add(id);
          const stretch = open.get(id);
          if (stretch) stretch.to = t + MIN;
          else open.set(id, {key: {...key, ordinal}, from: t, to: t + MIN});
        }
        for (const [id, stretch] of open) {
          if (working.has(id)) continue;
          credit(stretch);
          open.delete(id);
        }
      }
      for (const stretch of open.values()) credit(stretch);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** How often each card is measured at `t` by a machine: the demo measures on the agent's schedule, the test faster or slower. */
export type Rhythm = (card: Card, machine: Machine, t: number) => number;

/**
 * What the machines of a stand send as time goes on: their measurements on each card's
 * rhythm while awake, their failures every five minutes, and their lists of running
 * agents. The demo's loop and the catalogue test both drive it. With `paced`, live
 * measurements follow the hub; only the explicit legacy scene measures on its own.
 */
export class Live {
  /** Up to when each machine has measured. */
  private readonly measured = new Map<string, number>();
  private readonly requested = new Set<string>();
  private readonly checked = new Set<string>();
  private readonly pending = new Map<string, {at: number; next: number}>();
  /** When the machines first asked: the live demo starts asking up to a minute into its time. */
  private first: number | null = null;

  constructor(
    private readonly stand: Stand,
    private readonly rhythm: Rhythm,
    private readonly paced = false,
  ) {}

  /** Measurement times of a card by a machine in (from, to]: minutes on its cadence. */
  private times(card: Card, machine: Machine, from: number, to: number): number[] {
    const found: number[] = [];
    for (let t = Math.floor(from / MIN) * MIN + MIN; t <= to; t += MIN) {
      if (t % this.rhythm(card, machine, t) === 0) found.push(t);
    }
    return found;
  }

  /** When a card is measured next after `t`. */
  private next(card: Card, machine: Machine, t: number): number {
    for (let at = t + MIN; ; at += MIN) if (at % this.rhythm(card, machine, at) === 0) return at - t;
  }

  /** Every machine sends what it measured since last time, up to `t`; `now` is the hub's clock. */
  async measure(t: number, now: number) {
    const {set, start} = this.stand;
    for (const machine of machines(set)) {
      const from = this.measured.get(machine.id) ?? -MIN;
      if (t <= from) continue;
      this.measured.set(machine.id, t);
      const snapshots = cards(set)
        .filter(card => card.machines.includes(machine.id) && (!this.paced || card.refresh?.legacy))
        .flatMap(card =>
          this.times(card, machine, from, t)
            .filter(at => awake(machine, at) && delivered(card, at))
            .map(at => snapshot(card, start, at, this.next(card, machine, at))),
        )
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      const failing = Math.floor(t / (5 * MIN)) > Math.floor(from / (5 * MIN)) && awake(machine, t);
      const failures = failing ? failuresAt(set, machine, start, Math.floor(t / (5 * MIN)) * 5 * MIN) : [];
      const agent = this.stand.agents.get(machine.id)!;
      for (let i = 0; i < Math.max(snapshots.length, failures.length ? 1 : 0); i += BATCH) {
        await agent.ingest(snapshots.slice(i, i + BATCH), i + BATCH >= snapshots.length ? failures : [], now);
      }
    }
  }

  /**
   * Every machine awake asks the hub about its cards every 15 seconds, and delivers
   * those it is told to measure,
   * promising the next as the hub did.
   */
  async pace(t: number, now: number) {
    const {set, start} = this.stand;
    this.first ??= t;
    for (const machine of machines(set)) {
      const live = cards(set).filter(card => card.machines.includes(machine.id) && delivered(card, t) && (!card.refresh?.silent || !this.checked.has(card.id)));
      if (!live.length || !awake(machine, t)) continue;
      const agent = this.stand.agents.get(machine.id)!;
      // The catalogue can put many example accounts on a machine; the protocol takes 16 at a time.
      for (let offset = 0; offset < live.length; offset += 16) {
        const batch = live.slice(offset, offset + 16);
        const asks = batch.map(card => {
          const {provider, account, accountName} = snapshot(card, start, t, MIN) as {provider: string; account?: string; accountName?: string};
          const minimum = card.minimum ?? card.refresh?.minimum;
          return {provider, account, accountName, active: false, ...(minimum ? {minIntervalMs: minimum} : {})};
        });
        const {subscriptions} = await agent.checkin(asks, !batch.some(card => card.refresh?.legacy));
        for (const card of batch) this.checked.add(card.id);
        for (const [i, card] of batch.entries()) {
          const answer = subscriptions[i];
          if (answer.measure && answer.nextInMs && !this.pending.has(card.id))
            this.pending.set(card.id, {at: t + (this.requested.has(card.id) ? card.refresh?.delay ?? 0 : 0), next: answer.nextInMs});
          const pending = this.pending.get(card.id);
          if (pending && t >= pending.at) {
            this.pending.delete(card.id);
            if (this.requested.has(card.id) && card.refresh?.response === 'failed') await agent.ingest([], [{provider: card.provider, observedAt: new Date(now).toISOString(), error: 'failed'}], now);
            else if (!this.requested.has(card.id) || card.refresh?.response !== 'lost') await agent.ingest([snapshot(card, start, t, pending.next)], [], now);
          }
        }
      }
    }
    for (const card of cards(set)) {
      // A request counts from the first asking, as everything else its card shows does.
      if (!card.refresh || t - this.first < card.refresh.at || this.requested.has(card.id) || card.refresh.legacy || card.refresh.silent) continue;
      this.requested.add(card.id);
      const person = this.stand.people.get(homeOf(set, card))!;
      await person.post(`/api/boards/${person.personalBoard}/sources/${this.stand.sources.get(card.id)}/refresh`);
    }
  }

  /** Every machine tells its list of running agents as of `t`, as agents do every 15 seconds; one asleep says nothing. */
  async report(t: number, now: number) {
    for (const machine of machines(this.stand.set)) await this.reportOne(machine, t, now);
  }

  /** One machine tells its list as of `t`; the hub must file every agent on it. */
  async reportOne(machine: Machine, t: number, now: number) {
    if (!awake(machine, t)) return;
    const sessions = sessionsAt(this.stand.set, machine, this.stand.start, t);
    const {accepted} = await this.stand.agents.get(machine.id)!.sessions(sessions, now);
    if (accepted !== sessions.length) throw new Error(`machine ${machine.id}: the hub filed ${accepted} of its ${sessions.length} running agents`);
  }
}
