import {MEASURE_INTERVAL} from '../server/domain/frequency.js';
import {
  agentsWork,
  ALWAYS,
  busyIn,
  DAY,
  fixed,
  HOUR,
  idle,
  alongPlan,
  MIN,
  rolling,
  SECOND,
  steady,
  through,
  noReset,
  noLength,
  asleepAt,
  rhythmic,
  unbegun,
  waveWork,
  weekly,
  WEEK,
  type Agent,
  type Answer,
  type DemoSet,
  type Scene,
  type Wave,
  type Work,
} from './model.js';
/** Durable app settings, in `npm run demo:keys`; checking and reset busy are transient and tested. */
export {KEY_STORAGE} from './key-storage.js';

/**
 * The catalogue of the demo board: every state the dashboard knows today, one entry each,
 * but two that never last on a working hub (see the end).
 *
 * An entry is one object: a card (a subscription with its windows over time, the machines
 * that measure it, its agents and failures, and how it looks on each board), a scene of
 * the reset trackers, a board, a person or a machine with something of its own. People
 * and machines are made by the names entries refer to them by; a machine needs an entry
 * only for what sets it apart (its system, sleep, a code, a name given on the hub,
 * failures).
 *
 * Every entry says in `expect` what it shows, in codes the dashboard's own rules
 * (hub/ui/lib) compute from what the hub answers: `npm test` brings the set up on a hub
 * and checks each code over its span while time runs (the showcase, at `start`), so an
 * entry that stops showing its state fails the test. What only eyes can tell (an ellipsis, a colour, two cards in one
 * row) is `look`, checked by hand on the running board, in both languages.
 *
 * Time. Everything is in milliseconds from `start`, when the demo started, rounded down to
 * a minute; the data is the same for every start. A code holds by default over the
 * first twelve hours, [start, start + 12 h], so:
 * - a card's claimed state lives on weekly windows that reset after `start + 12 h 10 min`,
 *   within day 6 of the plan meanwhile;
 * - ahead of and behind the plan is 12–15 points either way, and levels keep a margin to
 *   their thresholds; five-hour windows of such cards are left out of `expect`, or stay
 *   `ok` with no note;
 * - a scene holds for twelve hours, its times from `start` too.
 *
 * Where a weekly window leads (its outlook, tone, unit of the countdown, burst mark, cold
 * forecast and why it has none) holds an hour by default (`FORESEEN`): the hub works it
 * out again every hour from how the subscription spends, by the hours of the day and the
 * days of the week in UTC, so every start sees it a little otherwise. Each such code keeps
 * more than an hour's margin to what would change it, and a test checks the codes at
 * other starts too.
 *
 * Exceptions, by name: the last day of the plan (6–6.45 days into the week at `start`)
 * and the stale card (on a machine that never comes back, its five hours already over).
 * What lives by design holds only a short span from `start` and is checked in the first
 * minutes of a run, or by starting it again: the sleeping machine, agents that come and
 * go, a five-hour window ahead of its pace or foreseen between two of its resets, a
 * series with under an hour of history, a free reset used half an hour before `start`
 * and a week begun ten minutes before it, a new subscription whose week begins an hour
 * in. A code about a change of agents begins 15 seconds after it at the earliest, when a
 * list that shows it has gone out. The cards
 * measured at the hub's pace (`paced`) say what their dot tells of the next measurement
 * for minutes from `start`, one resetting ten minutes in: a test of their own asks every
 * 15 seconds as their machine does, while the long one measures them on its rhythm and
 * leaves those codes out. The live demo measures every card at the hub's pace, so what
 * comes and goes in its first hours (a card's dot going stale while its machine sleeps or
 * grey between seldom measurements, where a young series' week leads) is checked at that
 * pace too, by tests of their own. How agents worked before `start` is written into the hub (as it
 * would have credited it, from ten days back: the part before is unknown) and read at
 * `start` alone: the codes of the activity widget and of the table's work are at that
 * fixed point, over a period ending there or a range before it.
 *
 * In-flight frequency changes and fixed handover are held by server/test/frequency.test.ts;
 * permission loss and late replies are checked on the live menu.
 * Continuous panning, partial loading and future folding are short-lived transitions:
 * ui/test/pan.test.ts, history.test.ts and historyPlot.test.ts hold their input,
 * cancellation, coverage and whole-cell accounting; bench/panning.ts exercises native
 * wheel and Shift-drag with delayed history on both charts. Cooperative preparation
 * and the held final pose are checked by ui/test/prepare.test.ts, history.test.ts and
 * timeAxisMotion.test.ts; they add no lasting demo state.
 *
 * Two states of a weekly window's forecast never last on a working hub, and have no entry:
 * `renewing`, the moment between a measurement and the hub's forecast of it (the hub works
 * a series out again as it reads it), and `unavailable`, a forecast that failed on the
 * hub. «a weekly window says what the card tells at once, then what the hub foresees»
 * (ui/test/forecast.test.ts) and «a series that fails is none and failed, alone, until the
 * next hour, and keeps nothing» (server/test/forecasts.test.ts) hold them.
 *
 * A new state gets an entry here with at least one code; the test picks it up. One a
 * working hub never holds for long is named above instead, with the tests that hold it.
 */

const WEEK_PLAN_FLAT = [15, 15, 15, 15, 15, 15, 10];

/** Agents working 12 of every 20 minutes, staggered by `shift` minutes. */
const shifts = (shift: number): Wave => ({period: 20 * MIN, on: 12 * MIN, phase: shift * MIN});

/** Work on and off, 12 of every 20 minutes, for a subscription without agents of its own. */
const onAndOff = (shift: number): Work => waveWork(shifts(shift));

/** Two hours a day, twelve hours apart: some agent work, and spending away from it. */
const MORNINGS: Wave = {period: DAY, on: 2 * HOUR, phase: 6 * HOUR};
const EVENINGS: Wave = {period: DAY, on: 2 * HOUR, phase: 18 * HOUR};

/**
 * A five-hour window spending `perHour` points an hour of full work, back to back from
 * `offset`. Where a card has agents, its work is theirs once they start: the window goes while they work.
 */
const fiveHours = (offset: number, perHour: number, work: Work = waveWork(ALWAYS), label?: string) =>
  rolling({id: label ? `${label.split(' ')[0].toLowerCase()}:session` : 'session', label, offset, work, use: (_elapsed, busy) => (perHour * busy) / HOUR});

const LONG_PROJECT =
  'platform-monorepo/services/billing-reconciliation-worker/migrations/2026-09-backfill-invoices-with-missing-tax-regions-and-currency-rounding-fixes-for-eu';

const agents = (machine: string, list: [Agent['origin'], string | null, number, Wave?, string?][]): Agent[] =>
  list.map(([origin, project, since, works, folder]) => ({machine, origin, project, folder, since, works}));

// ---------- reset scenes ----------

const codex = (data: object): Answer => ({json: {meta: {api_version: 'v1', generated_at: null}, data: {latest_reset: null, scheduled_reset: null, active_watch: null, ...data}}});
const claude = (claudeEvents: object[], codexEvents: object[] = []): Answer => ({json: {providers: {claude: {events: claudeEvents}, codex: {events: codexEvents}}, meta: {}}});
const quiet = () => claude([]);

/**
 * Most scenes say two things at once, as the trackers do: what a card shows is the most
 * pressing of them (an announced reset, then a possible one, then one that just happened,
 * then a change of limits).
 */
export const SCENES: Scene[] = [
  {
    kind: 'scene',
    id: 'announced',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'regular', announced_at: at(-5 * HOUR), scheduled_for: at(26 * HOUR), text: 'Rate limits reset for all Plus and Pro plans tomorrow.'},
        latest_reset: {announced_at: at(-4 * HOUR), text: 'Limits were reset for everyone.'},
      }),
    claude: at => claude([{kind: 'reset', date: at(-3 * HOUR), scope: 'Max', note: 'Weekly limits reset for Max plans.'}, {kind: 'policy', date: at(-DAY), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'in'},
      {reset: 'claude', label: 'done', scope: 'Max'},
      {tracker: 'Codex Resets', health: 'ok'},
      {tracker: 'Claude Resets', health: 'ok'},
      {marked: 'codex', resets: 1},
      {marked: 'claude', resets: 1},
    ],
    look: [
      'Codex cards: an accent mark "in 25h" on the left of the tray (the time is rounded down), not the reset of four hours ago; its panel heads with "Reset in 25h" and the date and time under it, then why it matters, the tracker\'s text and "Data from Codex Resets"',
      'Claude cards: a quiet mark, an arrow round a tick, not the change of limits of yesterday; its panel heads with "Reset happened", a "Max" tag beside it and the time under it',
      'Both resets for everyone are marked on the charts',
      'On 24 hours with the plan or the forecast shown, the Codex reset is pointed at from the right edge ("… in 25h →"): pointing at it or tapping it tells its date and time',
    ],
  },
  {
    kind: 'scene',
    id: 'banked',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'banked', announced_at: at(-HOUR), scheduled_for: at(20 * HOUR), text: 'Banked resets land tonight.'},
        active_watch: {observed_at: at(-2 * HOUR), expires_at: at(22 * HOUR), reset_chance_percent: 30, forecast_window: 'today', text: 'More resets may follow.'},
      }),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'bankedIn'},
      {reset: 'claude', label: null},
    ],
    look: ['Codex: "in 19h" on the mark, "Banked reset in 19h" in its panel; no mark on Claude cards'],
  },
  {
    kind: 'scene',
    id: 'unscheduled',
    codex: at => codex({scheduled_reset: {reset_type: 'regular', announced_at: at(-2 * HOUR), scheduled_for: null, text: 'Another reset is coming, time to be announced.'}}),
    claude: at => claude([{kind: 'policy', date: at(-DAY), note: 'Five-hour windows changed.'}]),
    expect: [
      {reset: 'codex', label: 'announced'},
      {reset: 'claude', label: 'policy'},
    ],
    look: ['Codex: an accent mark with no text, "Reset announced" in its panel', 'Claude: a quiet gauge, "Limits changed" with the time under it'],
  },
  {
    kind: 'scene',
    id: 'awaiting',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'regular', announced_at: at(-2 * DAY), scheduled_for: at(-3 * HOUR), text: 'Reset scheduled for this morning.'},
        latest_reset: {announced_at: at(-10 * HOUR), text: 'Limits were reset for everyone.'},
      }),
    claude: at => claude([{kind: 'reset', date: at(-2 * HOUR), scope: 'all', note: 'Limits reset for everyone.'}]),
    expect: [
      {reset: 'codex', label: 'awaiting'},
      {reset: 'claude', label: 'done', scope: ''},
      {marked: 'codex', resets: 1},
    ],
    look: ['Codex: an accent mark with no text, "Reset: awaiting confirmation" with the announced time under it', 'The Claude mark\'s panel names no scope: the reset was for everyone'],
  },
  {
    kind: 'scene',
    id: 'possible',
    codex: at =>
      codex({
        active_watch: {observed_at: at(-2 * HOUR), expires_at: at(20 * HOUR), reset_chance_percent: 40, forecast_window: 'next 24 hours', text: 'Usage dashboards hint at another reset.'},
        latest_reset: {announced_at: at(-2 * HOUR), text: 'Limits were reset for some accounts.'},
      }),
    claude: at => claude([{kind: 'policy', date: at(-2 * DAY), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'possible', chance: 40},
      {reset: 'claude', label: 'policy'},
    ],
    look: ['Codex: a quiet dashed mark "40%"; its panel heads with "Possible reset", a "40%" tag beside it and "by <time>" under it'],
  },
  {
    kind: 'scene',
    id: 'possible-no-chance',
    codex: at => codex({active_watch: {observed_at: at(-HOUR), expires_at: null, reset_chance_percent: null, forecast_window: 'this week', text: 'People report resets on some accounts.'}}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'possible', chance: null},
      {reset: 'claude', label: null},
    ],
    look: ['Codex: a quiet dashed mark with no text; its panel says "Possible reset" with no chance after it, and no time'],
  },
  {
    kind: 'scene',
    id: 'reset',
    codex: at => codex({latest_reset: {announced_at: at(-4 * HOUR), text: 'Limits were reset for everyone.'}}),
    claude: at => claude([{kind: 'reset', date: at(-HOUR), scope: 'Pro', note: 'Weekly limits reset for Pro plans.'}, {kind: 'policy', date: at(-2 * HOUR), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'done', scope: ''},
      {reset: 'claude', label: 'done', scope: 'Pro'},
      {marked: 'codex', resets: 1},
      {marked: 'claude', resets: 1},
    ],
  },
  {
    kind: 'scene',
    id: 'policy',
    // Codex Resets is down: Codex falls back on the Codex part of Claude Resets. Its resets
    // are older than a day, so the change of limits is the news.
    codex: () => ({status: 503}),
    claude: at =>
      claude(
        [{kind: 'policy', date: at(-DAY), note: 'New weekly limits.'}, {kind: 'reset', date: at(-80 * HOUR), scope: 'Max', note: 'Weekly limits reset for Max plans.'}],
        [{kind: 'policy', date: at(-6 * HOUR), note: 'Five-hour windows changed.'}, {kind: 'reset', date: at(-80 * HOUR), note: 'Limits were reset for everyone.'}],
      ),
    expect: [
      {reset: 'codex', label: 'policy'},
      {reset: 'claude', label: 'policy'},
      {tracker: 'Codex Resets', health: 'HTTP 503'},
      {tracker: 'Claude Resets', health: 'ok'},
      // Older than a day, the reset is off the 24-hour chart and on the week's.
      {marked: 'codex', resets: 0},
      {marked: 'codex', resets: 1, range: '7d'},
    ],
    look: ['The Codex mark\'s panel links its source, claude-resets.com, apart from the credit to Codex Resets'],
  },
  {
    kind: 'scene',
    id: 'quiet',
    codex: () => codex({}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: null},
      {reset: 'claude', label: null},
      {tracker: 'Codex Resets', health: 'ok'},
    ],
  },
  {
    kind: 'scene',
    id: 'blocked',
    codex: () => 'challenge',
    claude: () => ({status: 429}),
    expect: [
      {tracker: 'Codex Resets', health: 'challenge'},
      {tracker: 'Claude Resets', health: 'HTTP 429'},
      {reset: 'codex', label: null},
    ],
    look: ['Account → reset trackers: both in trouble, named'],
  },
  {
    kind: 'scene',
    id: 'broken',
    codex: () => 'format',
    claude: () => 'network',
    expect: [
      {tracker: 'Codex Resets', health: 'format'},
      {tracker: 'Claude Resets', health: 'network'},
    ],
  },
  {
    kind: 'scene',
    id: 'timeout',
    codex: () => 'timeout',
    claude: () => 'timeout',
    expect: [
      {tracker: 'Codex Resets', health: 'timeout'},
      {tracker: 'Claude Resets', health: 'timeout'},
    ],
    look: ['The trackers show "checking" for the first 10 seconds, then "timeout"'],
  },
  {
    kind: 'scene',
    id: 'showcase',
    codex: at => codex({scheduled_reset: {reset_type: 'regular', announced_at: at(-5 * HOUR), scheduled_for: at(2 * DAY + 3 * HOUR), text: 'Rate limits reset for all plans on Friday.'}}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'in'},
      {reset: 'claude', label: null},
    ],
  },
];

// ---------- agents, and the work they do on their cards ----------

// Ana's quotum, as the agent tells it: on the laptop in its main folder, a worktree and a
// folder inside it; on the build server a clone under another name.
const MAX_AGENTS: Agent[] = [
  ...agents('laptop', [
    ['terminal', 'quotum', -3 * HOUR, shifts(0)],
    ['terminal', 'quotum', -70 * MIN, shifts(4), 'quotum.feat-18-desktop-app'],
    ['terminal', 'infra', -2 * HOUR],
    ['editor', 'mobile-app', -5 * HOUR],
    ['app', null, -40 * MIN],
    ['terminal', LONG_PROJECT, -25 * MIN, shifts(8)],
  ]),
  ...agents('build-01', [
    ['terminal', 'docs-site', -4 * HOUR, shifts(2)],
    ['terminal', 'Quotum', -90 * MIN, shifts(10)],
    ['terminal', 'nightly-release', -6 * HOUR],
    ['editor', 'design-tokens-and-theme-migration-for-web', -30 * MIN],
  ]),
];

/** Eleven, one more than a tray draws; within the first quarter of an hour one more starts and one stops. */
const PRO_AGENTS: Agent[] = [
  {machine: 'laptop', origin: 'terminal', project: 'checkout', since: -2 * HOUR, until: 10 * MIN, works: shifts(1)},
  {machine: 'laptop', origin: 'terminal', project: 'hotfix-4821', since: 5 * MIN, works: ALWAYS},
  ...agents('laptop', [
    ['terminal', null, -3 * HOUR, shifts(5)],
    ['terminal', 'quotum', -50 * MIN, shifts(9), 'hub'],
    ['editor', 'admin-console', -4 * HOUR],
    ['app', 'support-bot', -1 * HOUR],
    ['terminal', 'notifications', -15 * MIN, {period: 4 * MIN, on: 2 * MIN, phase: 0}],
  ]),
  ...agents('win-desktop', [
    ['terminal', 'desktop-client', -5 * HOUR, shifts(6)],
    ['terminal', 'installer', -80 * MIN, shifts(11)],
    ['editor', 'telemetry-dashboard', -2 * HOUR],
    ['terminal', 'localization', -35 * MIN],
    ['app', null, -10 * MIN],
  ]),
];

/** One long job, at work all the time: the five hours run ahead of an even pace. */
const AHEAD_AGENTS: Agent[] = agents('build-01', [['terminal', 'billing', -90 * MIN, ALWAYS]]);

const IOS_AGENTS: Agent[] = agents('mac-mini', [
  ['terminal', 'ios-app', -30 * MIN, shifts(0)],
  ['editor', 'ios-app', -2 * HOUR],
]);

/** A narrow card with a full tray: reset news, free resets and ten agents on two machines. */
const ON_CALL_AGENTS: Agent[] = [
  ...agents('win-desktop', [
    ['terminal', 'on-call', -3 * HOUR, shifts(1)],
    ['terminal', 'incident-4412', -40 * MIN],
    ['terminal', 'runbooks', -2 * HOUR, shifts(7)],
    ['editor', 'alerts', -5 * HOUR],
    ['terminal', 'terraform', -90 * MIN, shifts(13)],
  ]),
  ...agents('build-01', [
    ['terminal', 'deploys', -4 * HOUR, shifts(3)],
    ['terminal', 'canary', -25 * MIN],
    ['terminal', 'status-page', -70 * MIN, shifts(9)],
    ['app', null, -2 * HOUR],
    ['terminal', 'postmortems', -6 * HOUR, shifts(15)],
  ]),
];

const TEAM_AGENTS: Agent[] = [
  ...agents('laptop', [
    ['terminal', 'shared-infra', -HOUR, shifts(3)],
    ['terminal', 'shared-docs', -20 * MIN],
  ]),
  ...agents('ben-mac', [['terminal', 'shared-infra', -3 * HOUR, shifts(9)]]),
];

/**
 * The example of the analytics' agent work: Dan's week on Claude Max, his agents on two
 * projects on two machines, most of it on days −5 and −4 (by `start`, never the calendar),
 * several at once for hours, spending the week while they worked.
 */
const daily = (from: number, hours: number): Wave => ({period: DAY, on: hours * HOUR, phase: from});
const WEEK_AGENTS: Agent[] = [
  {machine: 'dan-laptop', origin: 'terminal', project: 'atlas', since: -5 * DAY, until: -3.5 * DAY, works: daily(-5 * DAY, 8)},
  {machine: 'dan-laptop', origin: 'terminal', project: 'atlas', folder: 'atlas.feat-invoices', since: -5 * DAY + HOUR, until: -3.5 * DAY, works: daily(-5 * DAY + HOUR, 6)},
  {machine: 'dan-desk', origin: 'terminal', project: 'harbor', since: -5 * DAY + 2 * HOUR, until: -3.5 * DAY, works: daily(-5 * DAY + 2 * HOUR, 4)},
  {machine: 'dan-desk', origin: 'editor', project: 'harbor', since: -4 * DAY, until: -3.5 * DAY, works: daily(-4 * DAY + 3 * HOUR, 3)},
];

/** Dan measures Ben's Codex too, and worked on it: never on Team, where Dan is not. */
const DAN_ON_BEN: Agent[] = [{machine: 'dan-desk', origin: 'terminal', project: 'harbor', since: -3 * DAY, until: -2.5 * DAY, works: daily(-3 * DAY, 5)}];

// ---------- rhythms of spending ----------

/** Of `t`, how far into its day, days beginning at `start` and every 24 hours from it. */
const timeOfDay = (t: number) => ((t % DAY) + DAY) % DAY;

/** An office day: `busy` points an hour for nine hours from the ninth into each day, a tenth of that the rest of it. */
const office = (busy: number) => (t: number) => (timeOfDay(t) >= 9 * HOUR && timeOfDay(t) < 18 * HOUR ? busy : busy / 10);

/**
 * A day of nothing, then a burst three hours before `start` that goes on three hours after
 * it, at 9 points an hour: over 7 times the most the office rhythm spends in any hour.
 */
const BURST: (t: number) => number = t => (t >= -3 * HOUR && t < 3 * HOUR ? 9 : t >= -27 * HOUR && t < -3 * HOUR ? 0 : office(1.2)(t));

/**
 * Five days of work, 15.2 points each over the nine hours before the next day begins, then
 * two of none, from a week that began five days before `start`: its weekend begins at
 * `start`, with 24 points left, and a pace as the last day's would spend 30 by the reset.
 */
const WEEKDAYS: (t: number) => number = t => {
  const day = (((Math.floor((t + 5 * DAY) / DAY) % 7) + 7) % 7);
  return day < 5 && timeOfDay(t) >= 15 * HOUR ? 15.2 / 9 : 0;
};

/** The last night of the travel laptop ends ten minutes before `start`. */
const TRAVEL_WAKES = 10 * MIN;

// ---------- the whole catalogue ----------

const all: DemoSet = {
  id: 'all',
  about: 'every state the dashboard knows that lasts on a working hub',
  // /compact uses these same levels, empty/error states, long names and agent counts.
  scene: 'announced',
  entries: [
    // People and boards. Ana is the first person: her personal board holds almost everything.
    {
      kind: 'person',
      id: 'ana',
      name: 'Ana',
      agents: true,
      // Heights she chose, which the benchmark renders too: the list after all her cards however many, 32 rows tall, so most of its
      // agents show with their work totals and a few are left to the dialog; the analytics taller than drawn by themselves.
      agentsPlace: {x: 0, y: 99, w: 6, h: 32},
      places: {activity: {x: 0, y: 0, w: 6, h: 12}, history: {x: 0, y: 1, w: 6, h: 16}, forecast: {x: 0, y: 2, w: 6, h: 30}},
      projects: {'docs-site': 'docs'},
      // Each group has a working agent that works within the first twenty minutes.
      expect: [
        {state: 'widgets'},
        {weeklySeries: 11},
        {project: 'quotum', machines: ['laptop'], reported: [], from: 20 * MIN},
        {project: 'hub', absent: true, from: 20 * MIN},
        {project: 'quotum.feat-18-desktop-app', absent: true, from: 20 * MIN},
        {project: 'Quotum', machines: ['Build server'], from: 20 * MIN},
        {project: 'billing', machines: ['Build server'], from: 20 * MIN},
        {project: 'docs', machines: ['Build server'], reported: ['docs-site'], from: 20 * MIN},
        {project: null, from: 20 * MIN},
        // The table of agents: the project, and under it the folder where that is another,
        // the corrected name too (docs-site is where docs works).
        {agentsOf: 'quotum', folders: [null, 'hub', 'quotum.feat-18-desktop-app']},
        {agentsOf: 'docs', folders: ['docs-site']},
        // The list gathers them by project: quotum's three agents on two subscriptions are one row, with work
        // the hub credited them; infra has never worked.
        {agentGroup: 'quotum', agents: 3, worked: true},
        {agentGroup: 'infra', agents: 1, worked: false},
        // Agent activity counts docs-site under the name Ana gave it.
        {activityOf: 'docs', by: 'project', range: '24h', hours: 2.4, from: 0, to: 0},
        {activityOf: 'docs-site', by: 'project', range: '24h', hours: null, from: 0, to: 0},
        // Past the palette's seven a project is grey, but a group of its own, however small.
        {activityOf: 'notifications', by: 'project', range: '24h', hours: 0.1, from: 0, to: 0},
        // A range dragged on the chart before the hub knew how agents worked.
        {activityEmpty: 'knownFrom', range: {from: -13 * DAY, to: -11 * DAY}, from: 0, to: 0},
      ],
      look: [
        'The list of agents gathers them by project, by activity: quotum is one row of three agents, its marks in the colours of Max and Pro, with their agent-hours and last activity (a date and time, or now while one works); a click opens its three agents, each with its folder, where it runs, machine, subscription, the time it worked and last activity',
        'infra has no known activity time: its last activity is a dash, explained on hover',
        'The list\'s settings, for every viewer, group it by machine or subscription, or put each agent on a row of its own; the owner also picks its columns, how long each agent has run among them, off at first',
        'The table of agents in a dialog has a way back to all the groups when it was opened from them, and none when opened from a row',
        'The agent details dialog has no repeated working-count or work-total summary above its rows; the toolbar appears only for Back or compact-list sorting',
        'At the wide dialog width, default agent details form a table whose rows highlight from edge to edge; on a narrow screen they form an inset list',
        'Each agent\'s directory appears below its project in the details table, without a separate column; long worktree names wrap and stay readable',
        'The card tray\'s agents panel labels its right column Agent-hours and shows each session\'s credited work rather than its running duration; infra has zero work although its client is open',
        'The list of agents is 32 rows tall: the first projects that fit whole, then "N more projects", which opens them all in a dialog, in the same order and columns, sorted there as in the widget',
        'Agent activity and the chart are taller than they draw themselves: the room goes to the plot, the totals, heads and legends stay whole',
        'The table is 30 rows tall: room under it on a wide screen; on a narrow one, where it is a list, it is as tall as its rows',
        'The chart\'s tooltip has a row for every line in the legend\'s order, with what is left, the plan and the gap in columns up to now, and after it the plan and where each forecast leads; on a phone it stays whole on the screen',
        'The chart\'s settings switch the plan and the forecast on and off, under "On the chart"',
        'On a narrow window the labels past the chart\'s right edge stay within the plot, the soonest first: those with no room are said together as "and N more →", which tells each of them and its time when pointed at or tapped',
        'My machines → Projects: quotum once, on the laptop, though three agents work in three folders (the tray and quotum\'s agents in the list\'s dialog show it three times, with hub and quotum.feat-18-desktop-app under two of them)',
        'Renamed or merged in My machines, a project is shown under its new name in the tray and the list of agents too, merged ones as one group',
        'Merge Quotum into quotum: one row, with both machines and "from: Quotum"; give Quotum back its name: as it was',
        'docs gathers docs-site, and gives it back',
        'Escape in the merge menu closes only the menu',
        'The merge menu with many selected, at the bottom of the dialog: its glass is whole',
        'My machines → Projects shows no agent time',
        'Agent activity by project: seven projects in colour, the rest grey, each its own row in the legend and the tooltip, switched off and on alone',
        'The long project name wraps inside its activity legend bubble, including on a phone; opening it never widens the page',
      ],
    },
    {
      kind: 'person', id: 'ben', name: 'Ben', agents: true, agentsPlace: {x: 0, y: 99, w: 6, h: 2}, expect: [{state: 'widgets'}, {rows: 1}],
      look: ['His one agent shows whole in a list chosen two rows tall'],
    },
    {kind: 'person', id: 'cleo', name: 'Cleo', expect: [{state: 'onboarding'}], look: ['Cleo has no machines: her board asks her to connect one', 'Her /compact page says there are no visible limits, with Open Quotum still reachable']},
    {
      kind: 'person',
      id: 'dan',
      name: 'Dan',
      // The week before `start`, at a fixed point: the agents of the example are gone by then.
      expect: [
        {state: 'widgets'},
        {activity: 'project', range: '7d', groups: {atlas: 28, harbor: 16}, from: 0, to: 0},
        {activity: 'device', range: '7d', groups: {'dan-laptop': 28, Desk: 16}, from: 0, to: 0},
        {activity: 'source', range: '7d', groups: {'claude-week': 39, 'ben-codex': 5}, from: 0, to: 0},
        {activityTotals: {agentHours: 44, active: 21, agents: 5}, range: '7d', from: 0, to: 0},
        {activityOf: 'atlas', by: 'project', range: '7d', hours: 28, active: 16, from: 0, to: 0},
        {activityKnownFrom: -10 * DAY, range: '30d', from: 0, to: 0},
      ],
      look: [
        'Agent activity over 7 days by project: atlas and harbor on days −5 and −4, harbor again on day −3',
        'Its hour bars stack agent-hours and can stand above an hour; over 30 days the bars are two hours',
        'The legend adds up to 44 agent-hours; atlas has 28 agent-hours and 16 active hours',
        'The atlas legend bubble shows 28 agent-hours, 16 active hours, 1.8 at once and two agents: hover, Tab or tap; Escape dismisses it even when focus is elsewhere, a tap also switches the group',
        'Switch harbor off: stacks and scale shrink, 28h shown appears in the totals and Shown in the bar tooltip; active time, agents and at once keep their values',
        'Over 30 days the first twenty are hatched: not known before',
        'The table, for the weekly window: active time, spent per active hour, the forecast by work and, turned on, the share of spending while active',
      ],
    },
    {
      kind: 'board',
      id: 'team',
      name: 'Team',
      owner: 'ana',
      members: ['ben'],
      // Ben joined an hour before `start`, when his agent had worked on Team's Claude for two hours.
      joined: {ben: -HOUR},
      agents: true,
      agentsPlace: {x: 0, y: 99, w: 6, h: 5},
      expect: [
        {state: 'widgets'},
        {rows: 3},
        // The work of its members on what it shows, Ben's only since he joined; none of the hidden
        // Claude Max, and none of Dan's on Ben's Codex, Dan not being on Team.
        {activity: 'device', range: '24h', groups: {laptop: 0.6, 'ben-mac': 0.6}, from: 0, to: 0},
        {activity: 'source', range: '7d', groups: {'team-claude': 1.2}, from: 0, to: 0},
      ],
      look: [
        'Cards are named with their owners',
        'Ben sees Team as a member: no arranging, no invites; the list of agents, chosen five rows tall, gathers its three into two projects, shared-infra with two of them, and he opens their agents too',
        'Agent activity by machine: the laptop and ben-mac, nothing of Dan; Ben\'s from an hour before the start',
      ],
    },
    {
      kind: 'board',
      id: 'with-dan',
      name: 'With Dan',
      owner: 'ana',
      members: ['dan'],
      forecastWidth: 2,
      tableColumns: ['during', 'agenthours'],
      expect: [{state: 'widgets'}, {tableLayout: 'list'}],
      look: ['The Agent-hours column is enabled and every window shows it with its heading in the list', 'The table, a third of the board wide, is a list: each window its name and what is left, then the rest with their headings; nothing scrolls sideways'],
    },
    {
      kind: 'board',
      id: 'quiet',
      name: 'Quiet corner',
      owner: 'ana',
      members: [],
      agents: true,
      agentsPlace: {x: 0, y: 99, w: 6, h: 2},
      // No agent on it: over a month, only from when work was known.
      look: ['The empty list of agents, chosen two rows tall, says so whole'],
      expect: [{rows: 'none'}, {activityEmpty: 'none', range: '24h', from: 0, to: 0}, {activityEmpty: 'noneSince', range: '30d', from: 0, to: 0}],
    },
    {
      kind: 'board', id: 'grid', name: 'Grid', owner: 'ana', members: [], agents: true,
      agentsPlace: {x: 0, y: 0, w: 3, h: 16}, expect: [{state: 'widgets'}],
      look: [
        'The agents stand on the left half, 16 rows tall: the first projects that fit whole, then "N more projects"; Claude, Codex and Antigravity stack on the right, their trays at the bottom of their rows',
        'Claude is as tall as its content; Codex is taller, with room over its tray; Antigravity was made 8 rows tall but shows its five windows whole',
        'Hiding three of Antigravity\'s windows brings it to its 8 rows, showing them again makes it as tall as they are',
      ],
    },
    {kind: 'board', id: 'night', name: 'Night shift', owner: 'ana', members: [], agents: true, expect: [{rows: 'noneShown'}, {activityEmpty: 'noSources', range: '24h', from: 0, to: 0}]},
    {kind: 'board', id: 'empty', name: 'Empty board', owner: 'ana', members: ['cleo'], expect: [{state: 'onboarding'}]},

    // Machines with something of their own; the rest are Ana's, on Linux, with her machine token.
    {kind: 'machine', id: 'laptop', expect: [{os: 'linux'}, {via: 'token'}]},
    {kind: 'machine', id: 'build-01', renamed: 'Build server', expect: [{name: 'Build server'}]},
    {kind: 'machine', id: 'mac-mini', os: 'macos', sleeps: true, expect: [{os: 'macos'}], look: ['Asleep at night in the history: gaps on the 7-day chart']},
    {kind: 'machine', id: 'win-desktop', os: 'windows', byCode: true, expect: [{via: 'code'}, {os: 'windows'}]},
    {
      kind: 'machine',
      id: 'ci-runner',
      failures: [
        {provider: 'claude', error: 'not_installed'},
        {provider: 'antigravity', error: 'invalid_output'},
      ],
      expect: [{failure: {provider: 'claude', error: 'not_installed'}}, {failure: {provider: 'antigravity', error: 'invalid_output'}}],
    },
    {
      kind: 'machine',
      id: 'old-nuc',
      gone: -3 * HOUR,
      expect: [{via: 'token'}],
      look: ['«My machines» shows it seen when the demo started, not three hours ago: the hub dates every contact by its own clock'],
    },
    {kind: 'machine', id: 'ben-mac', person: 'ben', os: 'macos', failures: [{provider: 'antigravity', error: 'failed'}], expect: [{failure: {provider: 'antigravity', error: 'failed'}}]},
    {kind: 'machine', id: 'dan-laptop', person: 'dan', expect: [{via: 'token'}]},
    {kind: 'machine', id: 'dan-desk', person: 'dan', renamed: 'Desk', expect: [{name: 'Desk'}]},
    {
      kind: 'machine',
      id: 'travel',
      wakes: TRAVEL_WAKES,
      expect: [{via: 'token'}],
      look: ['Asleep eight hours every night, the last night ending ten minutes before the demo started: gaps on the 7-day chart'],
    },

    // Cards. Their order is the board's, and the order in which they come to the hub.
    {
      kind: 'card',
      id: 'claude-max',
      provider: 'claude',
      plan: 'Claude Max',
      machines: ['laptop', 'build-01'],
      // The longest history of the demo: 30 days are full, and ‹ goes back half a month more.
      history: 45 * DAY,
      windows: [
        fiveHours(20 * MIN, 25, agentsWork(MAX_AGENTS, shifts(0))),
        // Begun 34 hours ago: it runs out some 51 hours on, well past the two days a countdown says in hours.
        weekly({since: -1.4 * DAY, use: alongPlan(0)}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -1.4 * DAY, use: through([0, 0], [0.5, 6], [1.5, 12])}),
      ],
      agents: MAX_AGENTS,
      on: {ana: {}, team: {hidden: true}, grid: {place: {x: 3, y: 0, w: 3}}},
      expect: [
        {title: 'Claude'},
        {error: null},
        {stale: false},
        {agents: 10, drawn: true},
        {window: 'weekly', name: 'Weekly', level: 'ok', note: null, reset: 'resetsIn', started: true},
        {window: 'weekly:fable', name: 'Fable · weekly', note: 'behind'},
        {window: 'session', name: '5 hours', note: null},
        // Ten agents round the clock spend its week along the plan's first days, faster than it lasts: it runs out days before the reset.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit', unit: 'd'},
        {forecast: 'weekly:fable', outlook: 'left'},
        {forecast: 'weekly:fable', plan: 'behind'},
        {reachesBack: 45},
      ],
      look: [
        'Its reset news is a mark on the left of the tray; the Antigravity card in its row has none',
        'Its weekly forecast line goes down from the dotted plan to zero in two days; the Fable line stays above the plan to the reset',
        'On 30 days the chart is full; ‹ goes back twice, the second time to where history starts, and is off there',
        'Ten marks in the tray, in two groups (two machines); the panel names working, waiting and open-window agents',
        'At 1280×720 with the page at its top, the agents\' panel opens above the tray, cut to the room above it with only its list scrolling, and the page neither scrolls nor grows',
        'The long project name ends in an ellipsis; the agent without a project says so',
      ],
    },
    {
      kind: 'card',
      id: 'antigravity',
      provider: 'antigravity',
      plan: 'Ultra',
      machines: ['laptop'],
      history: 14 * DAY,
      windows: [
        fiveHours(50 * MIN, 8, onAndOff(15), 'Gemini Pro'),
        // A seventh of the week a day: on pace to spend it all by the reset.
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -3 * DAY, use: steady(0, 100 / 7)}),
        // A client that does not say when this one resets.
        noReset(weekly({id: 'claude:weekly', label: 'Claude', since: -3 * DAY, use: steady(0, 8)})),
        rolling({id: 'flash:window-1440', kind: 'other', label: 'Flash', minutes: 1440, offset: -8 * HOUR, use: elapsed => (1.5 * elapsed) / HOUR}),
        fixed({id: 'credits', label: 'Credits', used: 40}),
      ],
      on: {ana: {plan: 'off'}, grid: {plan: 'off', place: {x: 3, y: 2, w: 3, h: 8}}},
      expect: [
        {title: 'Antigravity'},
        {window: 'gemini:session', name: 'Gemini Pro · 5 hours'},
        {window: 'claude:weekly', name: 'Claude · weekly', note: null, reset: 'resetUnknown'},
        {window: 'flash:window-1440', name: 'Flash · 1d'},
        {work: 'gemini:weekly', range: {from: -13 * DAY, to: -11 * DAY}, none: 'unknown', from: 0, to: 0},
        {window: 'credits', name: 'Credits', reset: 'resetUnknown'},
        {forecast: 'gemini:weekly', outlook: 'pace'},
        {forecast: 'gemini:weekly', plan: 'none'},
        {forecast: 'claude:weekly', outlook: 'none'},
      ],
      look: ['Its plan is switched off: no pace marks on its meters', 'No reset news in its tray'],
    },
    {
      kind: 'card',
      id: 'antigravity-2',
      provider: 'antigravity',
      account: {name: 'Work'},
      plan: 'Pro',
      machines: ['mac-mini'],
      history: 14 * DAY,
      windows: [
        fiveHours(0, 7, agentsWork(IOS_AGENTS, ALWAYS), 'Gemini Pro'),
        // A third of the week the first day, most of it by the second: at the pace of the last day it runs out in a day and a half, well within half the time to the reset.
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -2 * DAY, use: through([0, 0], [1, 33], [2, 60.5], [3, 77])}),
      ],
      agents: IOS_AGENTS,
      on: {ana: {}},
      expect: [
        {work: 'gemini:weekly', range: '24h', paceWhy: 'short', leftWhy: 'short', from: 0, to: 0},
        {title: 'Antigravity 2'},
        {stale: false, to: 3 * MIN},
        // Stale while it sleeps, as the live demo, measured at the hub's pace, shows it too,
        // whenever in its first minute its loop starts.
        {stale: true, from: 8 * MIN, to: 13 * MIN},
        {stale: false, from: 15 * MIN, to: 46 * MIN},
        {agents: 2, drawn: true, to: 6 * MIN},
        {agents: 0, drawn: true, from: 7 * MIN, to: 14 * MIN},
        {agents: 2, drawn: true, from: 15 * MIN, to: 46 * MIN},
        {stale: true, from: 53 * MIN, to: 58 * MIN},
        {agents: 0, drawn: true, from: 52 * MIN, to: 59 * MIN},
        // Asleep or not, the forecast stays: at the last day's pace, in a day and a half, well before the reset.
        {forecast: 'gemini:weekly', outlook: 'runsOut', tone: 'v-crit', unit: 'h'},
      ],
      look: [
        'Its machine sleeps from the 2nd minute to the 14th, and so every 45 minutes: the card goes stale (its dot, no line under the limits) and comes back, its agents go and come back, a gap stays on the 24-hour chart',
        'Its Gemini week runs out past the chart\'s right edge: "Antigravity 2 · Gemini: runs out in ~33h →" stands there, in its colour, stacked with the other labels and never over the Codex reset\'s; pointing at it tells the date and time',
        'On a phone 320 px wide in Russian the label shortens the name to what fits, "Antigravity 2…", with nothing hanging before the ellipsis and the time whole',
      ],
    },
    {
      kind: 'card',
      id: 'codex-pro',
      provider: 'codex',
      plan: 'Pro',
      machines: ['laptop'],
      history: 14 * DAY,
      windows: [
        fiveHours(40 * MIN, 10, agentsWork(PRO_AGENTS, shifts(3))),
        // A free reset used six hours ago: the week before was due in two days.
        weekly({since: -6 * HOUR, early: 2 * DAY, use: steady(0, 20), before: (elapsed, n) => (n === -1 ? steady(10, 18)(elapsed) : steady(5, 12)(elapsed))}),
      ],
      resets: t =>
        t < -30 * HOUR
          ? {available: 0}
          : t < -6 * HOUR
            ? {available: 1, expiring: [{count: 1, expiresAt: 20 * DAY}]}
            : t < -3 * HOUR
              ? {available: 0, expiring: []}
              : // Granted at different times, they expire at different times; one the client gives no time for.
                {
                  available: 3,
                  expiring: [
                    {count: 1, expiresAt: 8 * DAY},
                    {count: 1, expiresAt: 18 * DAY},
                    {count: 1, expiresAt: null},
                  ],
                },
      agents: PRO_AGENTS,
      on: {grid: {place: {x: 3, y: 1, w: 3, h: 9}}, ana: {}, night: {hidden: true}},
      expect: [
        {work: 'session', range: '24h', left: 'untilReset', from: 0, to: 0},
        {title: 'Codex'},
        {agents: 11, drawn: false, to: 5 * MIN},
        {agents: 12, drawn: false, from: 5 * MIN + 15 * SECOND, to: 10 * MIN},
        {agents: 11, drawn: false, from: 10 * MIN + 15 * SECOND},
        {event: 'early_reset'},
        {event: 'resets_granted'},
        {window: 'weekly', level: 'ok', note: null},
      ],
      look: [
        'Three free resets: a ticket "3" in the tray, before the agents; its name and panel say when each expires: one in 8 days, one in 18, one with no end date',
        'Shares a row with Antigravity 2, the same two windows: with reset news or without (Account → this browser → announcements), the two are as tall',
        'The chart marks the early reset six hours ago and the free resets granted',
        'Within 15 minutes: an agent starts (5th minute), one stops (10th), "notifications" switches working every 2 minutes',
      ],
    },
    {
      kind: 'card',
      id: 'claude-ahead',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 2 * DAY,
      windows: [fiveHours(-60 * MIN, 36, agentsWork(AHEAD_AGENTS, shifts(9))), weekly({since: -2.5 * DAY, use: through([0, 0], [1.5, 62.5], [2.5, 77.5])})],
      agents: AHEAD_AGENTS,
      on: {ana: {name: 'Ahead of the plan', width: 2}},
      expect: [
        {title: 'Ahead of the plan'},
        {agents: 1, drawn: true},
        {window: 'weekly', level: 'warn', note: 'ahead', hint: 'weekly'},
        {window: 'session', note: 'ahead', hint: 'reset', to: 20 * MIN},
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit'},
        {forecast: 'weekly', plan: 'ahead'},
        {forecast: 'session', outlook: 'runsOut', tone: 'v-crit', to: 90 * MIN},
      ],
      look: [
        'A third of the row wide, with the next two cards',
        'The five hours are ahead of an even pace for the first minutes: its own tooltip',
        'Its week runs out past the right edge of the 24-hour chart: a label there says in how many hours',
      ],
    },
    {
      kind: 'card',
      id: 'codex-behind',
      provider: 'codex',
      plan: 'Pro',
      machines: ['win-desktop'],
      history: 14 * DAY,
      windows: [fiveHours(90 * MIN, 6, agentsWork(ON_CALL_AGENTS, shifts(12))), weekly({since: -2 * DAY, use: alongPlan(-15, WEEK_PLAN_FLAT)})],
      resets: () => ({available: 3, expiring: [{count: 3, expiresAt: 25 * DAY}]}),
      agents: ON_CALL_AGENTS,
      on: {ana: {name: 'Codex Pro for the platform team and the on-call rotation', color: '#43aca1', plan: WEEK_PLAN_FLAT, width: 2}},
      expect: [
        {title: 'Codex Pro for the platform team and the on-call rotation'},
        {agents: 10, drawn: true},
        {window: 'weekly', level: 'ok', note: 'behind'},
        // Behind its plan, but spending as it did the last day, it lasts about to the reset.
        {forecast: 'weekly', outlook: 'pace'},
        {forecast: 'weekly', plan: 'behind'},
        // Its five hours over a range: a point and a half an hour of work, and what is left outlasts five hours.
        {work: 'session', range: {from: -3 * HOUR, to: -HOUR}, left: 'outlasts', from: 0, to: 0},
      ],
      look: [
        'Its long name ends in an ellipsis',
        'Teal on the card, the chart and the table',
        'Its own plan: 15% a day, 10% the last',
        'A third of the row wide, its tray full: the reset news on the left, three free resets and ten agent marks in two groups on the right, whole at a window 1260 px wide or more; narrower, the marks go all at once and the count stays',
        'Its three free resets expire together: one row in the panel\'s table',
      ],
    },
    {
      kind: 'card',
      id: 'codex-low',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 2 * DAY,
      // A fast start, then 5.5 points a day over the two days it was measured: at that, it runs out some 30 hours on.
      windows: [fiveHours(10 * MIN, 5, onAndOff(14)), weekly({since: -4 * DAY, use: through([0, 0], [2, 82], [4, 93])})],
      on: {ana: {name: 'Running low', width: 2}, quiet: {}},
      expect: [
        {title: 'Running low'},
        {agents: 0, drawn: true},
        {window: 'weekly', level: 'crit', note: null},
        // It runs out in a day, two hours after the reset announced for everyone: which may come first, so not red.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-warn'},
        // Its five hours reset ten minutes in: a forecast from 40 minutes on.
        {forecast: 'session', outlook: 'left', from: 45 * MIN, to: 5 * HOUR},
      ],
      look: [
        'The weekly forecast line reaches zero a day ahead, where the table says it runs out, in yellow; its tooltip names the reset for everyone that comes before it',
      ],
    },
    {
      kind: 'card',
      id: 'codex-used-up',
      provider: 'codex',
      plan: 'Plus',
      machines: ['win-desktop'],
      history: 14 * DAY,
      windows: [fiveHours(0, 4), weekly({since: -(5 * DAY + 21 * HOUR), use: through([0, 0], [5.79, 100])})],
      on: {ana: {name: 'Used up'}},
      expect: [
        {title: 'Used up'},
        {window: 'weekly', level: 'crit', note: null},
        {forecast: 'weekly', outlook: 'usedUp'},
        {forecast: 'weekly', spent: 'points'},
        {work: 'weekly', range: '24h', left: 'usedUp', from: 0, to: 0},
      ],
    },
    {
      kind: 'card',
      id: 'claude-last-day',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 14 * DAY,
      windows: [fiveHours(30 * MIN, 5, onAndOff(5)), weekly({since: -6.2 * DAY, use: through([0, 0], [5.2, 67.6], [7, 91])})],
      on: {ana: {name: 'Last day of the week'}},
      expect: [
        {title: 'Last day of the week'},
        {window: 'weekly', level: 'warn', note: null},
        {forecast: 'weekly', outlook: 'left'},
      ],
      look: ['The plan has ended: no pace mark on the weekly meter'],
    },
    {
      kind: 'card',
      id: 'claude-idle',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['laptop'],
      history: 2 * DAY,
      windows: [idle(), weekly({since: -3 * DAY, use: steady(0, 5)})],
      on: {ana: {name: 'Idle five hours'}},
      expect: [
        {title: 'Idle five hours'},
        {window: 'session', started: false, note: null, reset: 'resetsIn'},
        {forecast: 'session', outlook: 'idle'},
      ],
      look: ['The five hours have not started: no pace mark, and it always resets in 5h', 'On the five-hour chart and table: no forecast for them, the tooltip says they start when first used'],
    },
    {
      kind: 'card',
      id: 'claude-hidden-windows',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 2 * DAY,
      windows: [fiveHours(70 * MIN, 5), weekly({since: -2 * DAY, use: steady(0, 12)})],
      on: {ana: {name: 'Every limit hidden', windows: ['session', 'weekly']}},
      expect: [
        {title: 'Every limit hidden'},
        {window: 'session', hidden: true},
        {window: 'weekly', hidden: true},
      ],
      look: ['In the middle of the card: an eye struck through, "All limits are hidden", that measurements go on, and "Show limits", which brings them back (put them away again in its settings)'],
    },
    {
      kind: 'card',
      id: 'claude-signed-out',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['win-desktop'],
      history: 3 * DAY,
      until: -2 * DAY,
      failure: {error: 'not_logged_in', from: -2 * DAY + 10 * MIN},
      windows: [fiveHours(0, 6), weekly({since: -3.5 * DAY, use: steady(5, 10)})],
      on: {ana: {name: 'Signed out'}},
      expect: [{title: 'Signed out'}, {error: 'not_logged_in'}, {stale: true}],
      look: ['Its last values stay, with no line under them: its dot is in trouble, and its tooltip says why they are old'],
    },
    {
      kind: 'card',
      id: 'codex-timeout',
      provider: 'codex',
      plan: 'Pro',
      machines: ['build-01'],
      history: 2 * DAY,
      until: -6 * HOUR,
      failure: {error: 'timeout', from: -6 * HOUR + 5 * MIN},
      // Almost used up when it was last measured, and going fast.
      windows: [fiveHours(0, 5), weekly({since: -3 * DAY, use: through([0, 0], [2.75, 97])})],
      on: {ana: {name: 'Too slow to answer'}},
      expect: [{title: 'Too slow to answer'}, {error: 'timeout'}, {stale: true}, {forecast: 'weekly', outlook: 'pastZero'}],
      look: ['No forecast for its week: the tooltip says around when, hours ago, it should have run out, and waits for a new measurement'],
    },
    {
      kind: 'card',
      id: 'antigravity-unsupported',
      provider: 'antigravity',
      account: {name: 'Home'},
      plan: 'Pro',
      machines: ['win-desktop'],
      history: 3 * DAY,
      until: -DAY,
      failure: {error: 'unsupported', from: -DAY + 5 * MIN},
      windows: [weekly({id: 'gemini:weekly', label: 'Gemini', since: -2 * DAY, use: steady(5, 8)})],
      on: {ana: {name: 'Antigravity at home'}},
      expect: [{title: 'Antigravity at home'}, {error: 'unsupported'}],
    },
    {
      kind: 'card',
      id: 'codex-stale',
      provider: 'codex',
      plan: 'Plus',
      machines: ['old-nuc'],
      history: 2 * DAY,
      windows: [fiveHours(-6 * HOUR, 8), weekly({since: -2 * DAY, use: steady(0, 11)})],
      // An agent worked on it until the machine went quiet.
      agents: [{machine: 'old-nuc', origin: 'terminal', project: 'nightly', since: -6 * HOUR, until: -3 * HOUR, works: ALWAYS}],
      on: {ana: {name: 'Quiet machine'}},
      expect: [
        {title: 'Quiet machine'},
        {stale: true},
        {error: null},
        {window: 'session', reset: 'resetPassed'},
        {window: 'weekly', reset: 'resetsIn'},
        // Nothing new since it went quiet: the forecast of its last measurement stands.
        {forecast: 'weekly', outlook: 'pace'},
        // Its five hours reset unmeasured: neither forecast knows what is left until the next measurement.
        {forecast: 'session', outlook: 'awaiting'},
        {work: 'session', range: '24h', leftWhy: 'awaiting', from: 0, to: 0},
      ],
      look: [
        'Not heard from for three hours: its five hours have reset since, waiting for a measurement',
        'On the five-hour table: both forecasts a dash, "Waiting for a new measurement"',
      ],
    },
    {
      kind: 'card',
      id: 'codex-eco',
      provider: 'codex',
      plan: 'Team',
      machines: ['ci-runner'],
      eco: true,
      history: 2 * DAY,
      windows: [idle(), weekly({since: -3 * DAY, use: steady(12, 0)})],
      // Its client gives how many, not when they expire.
      resets: () => ({available: 1}),
      on: {ana: {name: 'CI runners (eco)'}},
      expect: [
        {title: 'CI runners (eco)'},
        {stale: false},
        // Grey from a minute later in the live demo, measured at the hub's pace, whenever in its first minute its loop starts.
        {fresh: 'grey', from: 7 * MIN, to: 14 * MIN},
        {forecast: 'weekly', spent: 'unused'},
      ],
      look: ['Measured every quarter of an hour: its dot fades to grey and pulses again, never a warning', 'One free reset: a ticket "1" in the tray, and its panel gives no end date'],
    },
    {
      kind: 'card',
      id: 'codex-new',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 10 * MIN,
      // Its week began an hour before the demo.
      windows: [fiveHours(0, 6), weekly({since: -HOUR, use: steady(0, 10)})],
      on: {ana: {name: 'New subscription'}},
      expect: [
        {title: 'New subscription'},
        // Under an hour of history, counting the part of each ten minutes it measured: no forecast yet.
        {forecast: 'weekly', outlook: 'needData', why: 'hour', to: 30 * MIN},
      ],
      look: [
        'For its first half hour the table has no forecast for it, its tooltip saying one comes when there is an hour of history, and the chart no forecast line; then "just enough", by its first hour',
      ],
    },
    {
      kind: 'card',
      id: 'team-claude',
      provider: 'claude',
      plan: 'Claude Team',
      machines: ['laptop', 'ben-mac'],
      history: 14 * DAY,
      windows: [fiveHours(2 * HOUR, 9, agentsWork(TEAM_AGENTS, shifts(6))), weekly({since: -2 * DAY, use: alongPlan(-5)})],
      agents: TEAM_AGENTS,
      on: {ana: {name: 'Team'}, team: {}},
      expect: [
        {title: 'Team'},
        {agents: 2, drawn: true},
        // Five points behind the plan: marked in the table, not worth a word on the card.
        {window: 'weekly', note: null},
        {forecast: 'weekly', plan: 'behind'},
        {board: 'team', title: 'Claude · Ana, Ben'},
        {board: 'team', agents: 3, drawn: true},
        {board: 'ben', title: 'Claude'},
        // Its week spends along the plan whether its agents work or not: little of it while they do, which the pace's tooltip says.
        {work: 'weekly', board: 'team', range: '7d', lowShare: 1, from: 0, to: 0},
      ],
    },
    {
      kind: 'card',
      id: 'ben-codex',
      provider: 'codex',
      plan: 'Plus',
      machines: ['ben-mac', 'dan-desk'],
      history: 2 * DAY,
      windows: [fiveHours(HOUR, 5), weekly({since: -4 * DAY, use: alongPlan(1)})],
      agents: DAN_ON_BEN,
      on: {team: {}, 'with-dan': {}},
      expect: [
        {forecast: 'weekly', plan: 'even'},
        // It runs out within a day, before the reset announced for everyone, and has no free resets: red.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit'},
        {board: 'team', title: 'Codex · Ben'},
        // Dan's hours on it show on his board, where its measurements while he worked were too few for a pace;
        // Team does not show him, and says so of the agents it shows: over a month, since work is known.
        {work: 'weekly', board: 'dan', range: '7d', hours: 5, paceWhy: 'short', leftWhy: 'short', from: 0, to: 0},
        {work: 'weekly', board: 'team', range: '7d', none: 'none', from: 0, to: 0},
        {work: 'weekly', board: 'team', range: '30d', none: 'noneSince', since: -10 * DAY, from: 0, to: 0},
        // Nor a share of the spending while active, on With Dan, where it is on; over a day, when none worked, none at all.
        {work: 'weekly', board: 'with-dan', range: '7d', duringWhy: 'short', from: 0, to: 0},
        {work: 'weekly', board: 'with-dan', range: '24h', duringWhy: 'none', from: 0, to: 0},
        {title: 'Codex'},
      ],
    },
    {
      kind: 'card',
      id: 'ben-claude',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['ben-mac'],
      history: 2 * DAY,
      windows: [fiveHours(3 * HOUR, 5), weekly({since: -DAY, use: steady(0, 20)})],
      expect: [
        {title: 'Claude 2'},
        // It runs out a day before the reset, but past half of the time to it: yellow, not red.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-warn', unit: 'd'},
      ],
      look: ['Ben keeps this one off Team'],
    },
    {
      kind: 'card',
      id: 'claude-week',
      provider: 'claude',
      plan: 'Claude Max',
      machines: ['dan-laptop'],
      history: 8 * DAY,
      // Its week spends six points an hour its agents work, averaged over them.
      windows: [weekly({since: -6.4 * DAY, use: (_elapsed, busy) => (6 * busy) / HOUR, work: agentsWork(WEEK_AGENTS, daily(0, 0))})],
      agents: WEEK_AGENTS,
      // Without a plan: the example is about agent work.
      on: {dan: {plan: 'off'}, 'with-dan': {plan: 'off'}},
      // The share during work is off on Dan's board, on With Dan.
      expect: [
        {title: 'Claude'},
        {work: 'weekly', range: '7d', hours: 16, agentHours: 'hidden', perHour: 4.1, left: 10.1, during: 'hidden', from: 0, to: 0},
        {board: 'with-dan', work: 'weekly', range: '7d', agentHours: 39, during: 89, from: 0, to: 0},
        {work: 'weekly', range: '30d', since: -10 * DAY, from: 0, to: 0},
      ],
    },
    {
      kind: 'card',
      id: 'slow-spender',
      provider: 'codex',
      plan: 'pro',
      machines: ['laptop'],
      // Measured for a day and a half: a new subscription, with more than a day of history.
      history: 1.5 * DAY,
      // Under a point over a day of work: too little an hour of it to tell, yet what is left lasts to the reset.
      windows: [
        weekly({since: -2 * DAY, use: steady(20, 0.9)}),
        // As slow, but nearly used up: what is left lasts some sixty hours, short of the reset, and that is worth its number.
        weekly({id: 'weekly:ledger', label: 'Ledger', since: -2 * DAY, use: steady(96, 0.9)}),
        // As slow, from a client that does not tell its length: over a range, with no reset ahead, only a week bounds the hours, and what is left lasts over it.
        noLength(weekly({id: 'weekly:pool', label: 'Pool', since: -2 * DAY, use: steady(50, 0.9)})),
      ],
      agents: [{machine: 'laptop', origin: 'terminal', project: 'ledger', since: -DAY, works: ALWAYS}],
      expect: [
        {work: 'weekly', range: '24h', perHour: 0, left: 'untilReset', from: 0, to: 0},
        {work: 'weekly:ledger', range: '24h', perHour: 0, left: 58.7, from: 0, to: 0},
        // By time, as slow as the last day: its few points last about to the reset, whatever the week spent at once when it began; a day and a half of history is past a first day.
        {forecast: 'weekly:ledger', outlook: 'pace', cold: false},
        {work: 'weekly:pool', range: '24h', perHour: 0, left: 'untilReset', from: 0, to: 0},
        // Over the last hour but one, a tenth of a point: what is left would outlast the week, so it lasts to the reset.
        {work: 'weekly', range: {from: -2 * HOUR, to: -HOUR}, perHour: 0.1, left: 'outlasts', from: 0, to: 0},
        // Over the day before it, as slow as up to now: past the week, too, with no hours named.
        {work: 'weekly', range: {from: -DAY, to: -HOUR}, perHour: 0, left: 'outlasts', from: 0, to: 0},
        {work: 'weekly:pool', range: {from: -DAY, to: -HOUR}, perHour: 0, leftWhy: 'slow', from: 0, to: 0},
      ],
      look: [
        'In the table, spent per active hour is "≈ 0%/h" and the forecast by work "lasts to the reset", its tooltip naming no hours',
        'Its Ledger window, nearly used up at the same pace: the forecast by work some sixty active hours, its tooltip telling the pace as under 0.05% an hour',
        'Beside them, its forecast by time says "just enough": it goes by how the subscription spent over the last day, not by the 96 points its week spent at once when it began',
        'Over a range of the day before the last hour: the forecast by work "lasts to the reset", its tooltip that it lasts longer than the window, naming no hours',
        'Over it, its Pool window, of no known length: the forecast by work a dash, its tooltip that what is left lasts over a week of activity, at under 0.05% an hour',
      ],
    },
    {
      kind: 'card',
      id: 'spent-elsewhere',
      provider: 'codex',
      plan: 'pro',
      machines: ['laptop'],
      history: DAY,
      // Its week spends in the evening, outside its agent (a browser, a phone); the agent works in the morning and spends none of it.
      windows: [weekly({since: -2 * DAY, use: elapsed => 10 + (3 * busyIn(EVENINGS, -2 * DAY, -2 * DAY + elapsed)) / HOUR})],
      agents: [{machine: 'laptop', origin: 'terminal', project: 'ledger', since: -DAY, works: MORNINGS}],
      expect: [{work: 'weekly', range: '24h', lowShare: 0, from: 0, to: 0}],
      look: ['In the table, the tooltips of spent per active hour and the forecast by work say nothing was spent while agents worked'],
    },

    // Where a weekly window leads, one case each: the hub's forecast from how its subscription spends.
    {
      kind: 'card',
      id: 'codex-reset-used',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 10 * DAY,
      // Five points an hour round the clock: a week runs out in 20 hours. The last one ran out
      // six hours before a free reset used half an hour ago, and the new one began at once.
      windows: [weekly({since: -30 * MIN, early: WEEK - 26.5 * HOUR, use: steady(0, 120), before: steady(0, 120)})],
      resets: t => (t < -30 * MIN ? {available: 2, expiring: [{count: 2, expiresAt: 12 * DAY}]} : {available: 1, expiring: [{count: 1, expiresAt: 12 * DAY}]}),
      on: {ana: {name: 'Reset after running out'}},
      expect: [
        {title: 'Reset after running out'},
        // At the pace before the reset, not waiting for a new history; a free reset left keeps it yellow.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-warn', unit: 'h'},
      ],
      look: ['Its forecast line starts from the reset and reaches zero within a day, straight: the pace it had before'],
    },
    {
      kind: 'card',
      id: 'codex-reset-late',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 10 * DAY,
      // As above, only its week, a rolling one, began 20 minutes after the reset, when it was first used.
      windows: [unbegun(weekly({since: -10 * MIN, early: WEEK - 26.5 * HOUR, use: steady(0, 120), before: steady(0, 120)}), -30 * MIN, -10 * MIN)],
      resets: t => (t < -30 * MIN ? {available: 1, expiring: [{count: 1, expiresAt: 12 * DAY}]} : {available: 0, expiring: []}),
      on: {ana: {name: 'Reset, then a pause'}},
      expect: [
        {title: 'Reset, then a pause'},
        // Its zero comes before the reset announced for everyone, and no free reset is left: nothing makes it yellow.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit', unit: 'h'},
      ],
    },
    {
      kind: 'card',
      id: 'claude-burst',
      provider: 'claude',
      plan: 'Claude Max',
      machines: ['build-01'],
      history: 14 * DAY,
      windows: [rhythmic({since: -2 * DAY, rate: BURST})],
      on: {ana: {name: 'A burst after a quiet day'}},
      expect: [
        {title: 'A burst after a quiet day'},
        {forecast: 'weekly', burst: true},
      ],
      look: [
        'A muted arrow up beside the words of its forecast, "faster than usual" to a screen reader; the tooltip says how many times faster than usual the last 6 hours went, and around when it runs out at that pace',
        'The row is as tall as the others',
      ],
    },
    {
      kind: 'card',
      id: 'claude-weekdays',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['laptop'],
      // Three weeks and more: the forecast knows the days of the week apart.
      history: 22 * DAY,
      windows: [rhythmic({since: -5 * DAY, rate: WEEKDAYS})],
      on: {ana: {name: 'Weekdays only'}},
      expect: [
        {title: 'Weekdays only'},
        // Its weekend spends nothing: what is left lasts to the reset, though the last day alone would not.
        {forecast: 'weekly', outlook: 'left'},
      ],
      look: ['Its forecast line lies flat over the two days to the reset'],
    },
    {
      kind: 'card',
      id: 'claude-new',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['laptop'],
      // Measured for six hours: its week began two days before.
      history: 6 * HOUR,
      windows: [weekly({since: -2 * DAY, use: steady(0, 30)})],
      on: {ana: {name: 'Six hours of history'}},
      expect: [
        {title: 'Six hours of history'},
        // It runs out in half the time to the reset, but under a day of history a forecast is never red, nor says what is left.
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-warn', cold: true},
      ],
      look: ['The tooltip says the forecast goes by its first 6 hours'],
    },
    {
      kind: 'card',
      id: 'codex-first-use',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: HOUR,
      // Its rolling week, unused since Quotum began to measure it, begins an hour in and spends two points an hour.
      windows: [unbegun(weekly({since: HOUR, use: steady(0, 48)}), -Infinity, HOUR)],
      on: {ana: {name: 'Begins with Quotum'}},
      expect: [
        {title: 'Begins with Quotum'},
        {forecast: 'weekly', outlook: 'idle', to: 55 * MIN},
        // Its history begins with its week: no forecast for the first three quarters of an hour of it, then a cautious one.
        // At the hub's pace, which measures it every quarter of an hour while unused, the live demo sees its week begun up to 20 minutes late.
        {forecast: 'weekly', outlook: 'needData', why: 'hour', from: 85 * MIN, to: 95 * MIN},
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-warn', cold: true, from: 2 * HOUR, to: 3 * HOUR},
      ],
    },
    {
      kind: 'card',
      id: 'claude-asleep',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['travel'],
      history: 14 * DAY,
      // Thirteen points a day, spent only while its laptop is awake.
      windows: [rhythmic({since: -3 * DAY, rate: t => (asleepAt(TRAVEL_WAKES, t) ? 0 : 13 / 16)})],
      on: {ana: {name: 'Asleep at night'}},
      expect: [
        {title: 'Asleep at night'},
        // By the hours it is awake alone it would run out; the nights it sleeps it spends nothing.
        {forecast: 'weekly', outlook: 'pace'},
      ],
      look: ['Its forecast line has a shelf every night, and starts from the measurement after it woke'],
    },
    {
      kind: 'card',
      id: 'claude-at-zero',
      provider: 'claude',
      plan: 'Claude Max',
      machines: ['laptop'],
      // Measured for twenty minutes: its week is used up, and so is one model's window.
      history: 20 * MIN,
      windows: [
        weekly({since: -4 * DAY, use: () => 100}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -4 * DAY, use: () => 30}),
        weekly({id: 'weekly:opus', label: 'Opus', since: -4 * DAY, use: () => 99.7}),
      ],
      on: {ana: {name: 'Limits at zero'}},
      expect: [
        {title: 'Limits at zero'},
        {forecast: 'weekly', outlook: 'usedUp'},
        // Nothing spent at zero tells a pace: no forecast until the reset, and the tooltip says which limit is at zero.
        {forecast: 'weekly:fable', outlook: 'needData', why: 'weeklyAtZero'},
        {forecast: 'weekly:opus', outlook: 'needData', why: 'atZero'},
      ],
    },
    ...([MEASURE_INTERVAL.one, MEASURE_INTERVAL.two, MEASURE_INTERVAL.five, MEASURE_INTERVAL.fifteen]).map(interval => {
      const minutes = interval / MIN;
      return {
        kind: 'card' as const, id: `frequency-${minutes}`, provider: 'codex' as const, plan: 'pro',
        machines: [`frequency-${minutes}`], history: DAY, paced: true,
        measureIntervalMs: interval,
        windows: [weekly({since: -3 * DAY, use: () => minutes === 15 ? 95 : 40})],
        agents: minutes === 15 ? [{machine: 'frequency-15', origin: 'terminal' as const, project: 'Fixed pace', since: -HOUR, works: ALWAYS}] : [],
        on: {ana: {name: `Every ${minutes} minutes`}},
        expect: [
          {measureIntervalMs: interval},
          {from: 15 * SECOND, to: 15 * SECOND, cadence: 'nextIn' as const, why: 'fixed' as const},
          ...(minutes === 15 ? [{from: 3 * MIN, to: 8 * MIN, cadence: 'nextIn' as const, why: 'fixed' as const, stale: true}] : []),
        ],
        look: ['Frequency is shared across boards; low limits and working agents do not speed up the fixed 15-minute plan. Stale data still explain the next measurement. Check the compact Auto / 1 / 2 / 5 / 15 segments, native radio keys, aligned menu headings and the Auto explanation in both languages'],
      };
    }),
    {
      kind: 'card', id: 'frequency-floor', provider: 'codex', plan: 'pro',
      machines: ['frequency-floor'], history: DAY, paced: true, measureIntervalMs: MEASURE_INTERVAL.one, minimum: 5 * MIN,
      windows: [weekly({since: -3 * DAY, use: () => 40})],
      on: {ana: {name: 'Every minute, device minimum 5'}},
      expect: [{measureIntervalMs: MEASURE_INTERVAL.one}, {from: 2 * MIN, to: 3 * MIN, cadence: 'nextIn', why: 'fixed'}],
      look: ['The menu keeps the one-minute selection while the tooltip gives the real five-minute device plan'],
    },
    // Real requests through the board API, with stand-in devices and controlled answers. Times
    // count from the machines' first asking, 15 seconds apart from then on in the demo's own
    // steps: a step happens up to 15 seconds after the time it is due.
    ...[
      {id: 'refresh-updated', refresh: {at: 15 * SECOND}, expect: [{refresh: 'queued', from: 30 * SECOND, to: 55 * SECOND}, {refresh: 'updated', from: 75 * SECOND, to: 115 * SECOND}]},
      {id: 'refresh-queued', refresh: {at: 15 * SECOND, minimum: 5 * MIN}, expect: [{refresh: 'queued', from: 30 * SECOND, to: 4 * MIN}]},
      {id: 'refresh-waiting', refresh: {at: 15 * SECOND, delay: 150 * SECOND}, expect: [{refresh: 'waiting', from: 75 * SECOND, to: 3 * MIN}]},
      {id: 'refresh-failed', refresh: {at: 15 * SECOND, response: 'failed' as const}, expect: [{refresh: 'failed', unavailable: 'paused', from: 75 * SECOND, to: 115 * SECOND}]},
      {id: 'refresh-no-result', refresh: {at: 15 * SECOND, response: 'lost' as const}, expect: [{refresh: 'no_result', from: 6 * MIN + 15 * SECOND, to: 6 * MIN + 45 * SECOND}]},
      {id: 'refresh-legacy', refresh: {at: 0, legacy: true}, expect: [{unavailable: 'unsupported', from: 0, to: 4 * MIN}]},
      {id: 'refresh-silent', refresh: {at: 0, silent: true}, expect: [{unavailable: 'silent', from: 135 * SECOND, to: 4 * MIN}]},
    ].map(({id, refresh, expect}) => ({
      kind: 'card' as const, id, provider: 'codex' as const, plan: 'pro', machines: [id], history: DAY, paced: true,
      refresh, windows: [weekly({since: -3 * DAY, use: () => 35})],
      on: {ana: {name: id.replaceAll('-', ' ')}}, expect: expect as import('./model.js').CardCheck[],
      look: ['Refresh is an action in the existing card menu; acceptance closes it, with request state in the logo dot. Check keyboard, touch, viewers, narrow cards and both languages'],
    })),

    // Measured at the hub's pace, one reason each, all by one machine asking every 15 seconds.
    {
      kind: 'card',
      id: 'paced-low',
      provider: 'codex',
      plan: 'pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -5 * DAY, use: steady(84, 2)})],
      expect: [
        {window: 'weekly', level: 'crit'},
        {from: 15 * SECOND, to: 15 * SECOND, cadence: 'nextIn', why: 'low'},
        {from: 45 * SECOND, to: 45 * SECOND, cadence: 'nextSoon', why: 'low'},
      ],
      look: [
        'The tooltip of the dot says when it was measured, when the next measurement comes (in so long, then the time) and why, a line each, in both languages',
        'It opens below the logo, whole on a card in the top row and on a narrow screen',
      ],
    },
    {
      kind: 'card',
      id: 'paced-in-use',
      provider: 'codex',
      plan: 'pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -3 * DAY, use: () => 60})],
      agents: [{machine: 'pacer', origin: 'terminal', project: 'paced', since: -HOUR, works: ALWAYS}],
      expect: [
        {error: null},
        {from: 15 * SECOND, to: 75 * SECOND, cadence: 'nextIn', why: 'inUse'},
        {work: 'weekly', range: '24h', perHour: 0, leftWhy: 'nospend', from: 0, to: 0},
        // Over a month, what it spent before work was known is in the period's: nothing since then.
        {work: 'weekly', range: '30d', leftWhy: 'nospendSince', since: -10 * DAY, from: 0, to: 0},
      ],
    },
    {
      kind: 'card',
      id: 'paced-changed',
      provider: 'codex',
      plan: 'pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -2 * HOUR, use: steady(5, 150)})],
      expect: [{error: null}, {from: 15 * SECOND, to: 75 * SECOND, cadence: 'nextIn', why: 'changed'}],
    },
    {
      kind: 'card',
      id: 'paced-idle',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -3 * DAY, use: () => 35})],
      expect: [
        {error: null},
        {from: 15 * SECOND, to: 14 * MIN + 15 * SECOND, cadence: 'nextIn', why: 'idle'},
        {from: 14 * MIN + 45 * SECOND, to: 14 * MIN + 45 * SECOND, cadence: 'nextSoon', why: 'idle'},
      ],
    },
    {
      kind: 'card',
      id: 'paced-reset',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: 10 * MIN - 7 * DAY, use: () => 50})],
      expect: [
        {error: null},
        {from: 15 * SECOND, to: 9 * MIN + 45 * SECOND, cadence: 'nextIn', why: 'reset'},
        {from: 10 * MIN + 15 * SECOND, to: 10 * MIN + 15 * SECOND, cadence: 'nextSoon', why: 'reset'},
      ],
      look: [
        'Its week resets ten minutes in: the forecast says about half is left before, a dash while its new week has under an hour of history, then "just enough", by its first hour',
      ],
    },
  ],
};

// ---------- the README images ----------

const PLATFORM_AGENTS: Agent[] = [
  ...agents('laptop', [
    ['editor', 'mobile-app', -5 * HOUR],
    ['terminal', 'api-gateway', -3 * HOUR, ALWAYS],
    ['terminal', 'billing', -HOUR, ALWAYS],
  ]),
  ...agents('ws-2631-linux', [
    ['terminal', 'infra', -2 * HOUR, ALWAYS],
    ['terminal', 'docs-site', -25 * MIN],
  ]),
];
const RESEARCH_AGENTS = agents('ws-2631-linux', [['terminal', 'eval-harness', -40 * MIN]]);
const WORK_AGENTS = agents('laptop', [['terminal', 'checkout', -3 * HOUR, ALWAYS]]);
const CI_AGENTS = agents('ws-2631-linux', [
  ['terminal', 'ci-flaky-tests', -3 * HOUR, ALWAYS],
  ['terminal', 'ci-release', -2 * HOUR, ALWAYS],
  ['terminal', 'ci-lint', -2 * HOUR, ALWAYS],
]);
const ANNA_AGENTS = agents('ws-2631-linux', [
  ['terminal', 'thesis', -3 * HOUR, ALWAYS],
  ['terminal', 'notes', -HOUR],
]);
const PERSONAL_AGENTS = agents('laptop', [['terminal', 'dotfiles', -5 * HOUR, ALWAYS]]);

const showcase: DemoSet = {
  id: 'showcase',
  about: 'a clean board for the README images',
  scene: 'showcase',
  entries: [
    {kind: 'person', id: 'demo', name: 'Demo', expect: [{state: 'widgets'}]},
    {kind: 'machine', id: 'laptop', expect: [{via: 'token'}]},
    {kind: 'machine', id: 'ws-2631-linux', expect: [{os: 'linux'}]},
    {
      kind: 'card',
      id: 'platform',
      provider: 'claude',
      plan: 'max',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [
        fiveHours(-3 * HOUR - 54 * MIN, 20, agentsWork(PLATFORM_AGENTS, shifts(0))),
        weekly({since: -(3 * DAY + 21 * HOUR), use: through([0, 0], [3, 40], [4, 44])}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -(3 * DAY + 21 * HOUR), use: through([0, 0], [3, 42], [4, 45])}),
      ],
      agents: PLATFORM_AGENTS,
      on: {demo: {name: 'Platform team', width: 4}},
      expect: [{title: 'Platform team'}, {agents: 5, drawn: true}, {error: null}],
    },
    {
      kind: 'card',
      id: 'research',
      provider: 'antigravity',
      plan: 'ultra',
      machines: ['ws-2631-linux'],
      history: 7 * DAY,
      windows: [
        fiveHours(-3 * HOUR - 8 * MIN, 5, agentsWork(RESEARCH_AGENTS, shifts(7)), 'Gemini Pro'),
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -(3 * DAY + HOUR), use: through([0, 0], [3, 53], [4, 60])}),
        weekly({id: 'claude:weekly', label: 'Claude', since: -(3 * DAY + HOUR), use: through([0, 0], [3, 62], [4, 70])}),
      ],
      agents: RESEARCH_AGENTS,
      on: {demo: {name: 'Research', width: 2, plan: 'off'}},
      expect: [{title: 'Research'}, {agents: 1, drawn: true}],
    },
    {
      kind: 'card',
      id: 'work',
      provider: 'codex',
      plan: 'pro',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [fiveHours(-3 * HOUR - 34 * MIN, 15, agentsWork(WORK_AGENTS, ALWAYS)), weekly({since: -(DAY + 3 * HOUR), use: steady(0, 31)})],
      resets: t =>
        t < -6 * HOUR
          ? {available: 0, expiring: []}
          : {
              available: 2,
              expiring: [
                {count: 1, expiresAt: 11 * DAY},
                {count: 1, expiresAt: 18 * DAY},
              ],
            },
      agents: WORK_AGENTS,
      on: {demo: {name: 'Work'}},
      expect: [{title: 'Work'}, {agents: 1, drawn: true}],
    },
    {
      kind: 'card',
      id: 'ci',
      provider: 'codex',
      plan: 'team',
      machines: ['ws-2631-linux'],
      history: 7 * DAY,
      windows: [fiveHours(-2 * HOUR - 14 * MIN, 12, agentsWork(CI_AGENTS, ALWAYS)), weekly({since: -(5 * DAY + HOUR), use: through([0, 0], [4, 55], [5, 61])})],
      agents: CI_AGENTS,
      on: {demo: {name: 'CI runners'}},
      expect: [{title: 'CI runners'}, {agents: 3, drawn: true}],
    },
    {
      kind: 'card',
      id: 'anna',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['ws-2631-linux'],
      history: 7 * DAY,
      windows: [fiveHours(-2 * HOUR - 44 * MIN, 8, agentsWork(ANNA_AGENTS, ALWAYS)), weekly({since: -(2 * DAY + HOUR), use: through([0, 0], [1, 12], [2, 20])})],
      agents: ANNA_AGENTS,
      on: {demo: {name: 'Anna', width: 3}},
      expect: [{title: 'Anna'}, {agents: 2, drawn: true}],
    },
    {
      kind: 'card',
      id: 'personal',
      provider: 'codex',
      plan: 'plus',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [fiveHours(-4 * HOUR - 14 * MIN, 8, agentsWork(PERSONAL_AGENTS, ALWAYS)), weekly({since: -(5 * DAY + 15 * HOUR), use: through([0, 0], [4.6, 80], [5.6, 88])})],
      agents: PERSONAL_AGENTS,
      on: {demo: {name: 'Personal', width: 4}},
      expect: [{title: 'Personal'}, {agents: 1, drawn: true}],
    },
  ],
};

/** The issue's example: recent work rises above a newer idle session, across three machines. */
const SORT_AGENTS: Agent[] = [
  ...agents('workstation', [
    ['terminal', 'api', -3 * HOUR, {period: DAY, on: HOUR, phase: MIN}],
    ['editor', 'web', -2 * HOUR, {period: DAY, on: HOUR, phase: MIN}],
    ['app', null, -10 * MIN],
    ['terminal', 'new-session', -MIN],
  ]),
  ...agents('laptop', Array.from({length: 4}, (_, i) => ['terminal', `recent-${i + 1}`, -HOUR - i * MIN, {period: DAY, on: MIN, phase: -(i + 2) * MIN}] as const)),
  ...agents('server', Array.from({length: 4}, (_, i) => ['terminal', `morning-${i + 1}`, -8 * HOUR - i * MIN, {period: DAY, on: MIN, phase: -(i + 4) * HOUR}] as const)),
];
const activity: DemoSet = {
  id: 'activity',
  about: 'twelve agents ordered by activity, as a table and a narrow list',
  scene: 'quiet',
  entries: [
    {kind: 'person', id: 'ana', name: 'Ana', agents: true, expect: [{rows: 12}, {firstMachines: ['workstation', 'workstation', 'laptop', 'laptop'], from: 2 * MIN, to: 10 * MIN}], look: ['At full width, sortable headers; a project a row, an agent in each; those of two agents on workstation rise to the top after a minute']},
    {
      kind: 'board', id: 'compact', name: 'Compact agents', owner: 'ana', members: [], agents: true, agentsPlace: {x: 3, y: 1, w: 2, h: 8}, expect: [{rows: 12}],
      look: ['At a third of the grid the widget is a compact list, with a sort menu, eight rows tall: the first projects and "N more projects"; the dialog shows them all as a table'],
    },
    {
      kind: 'card', id: 'activity', provider: 'codex', plan: 'pro', machines: ['workstation', 'laptop', 'server'], history: DAY,
      windows: [weekly({since: -2 * DAY, use: steady(0, 10)})], agents: SORT_AGENTS,
      on: {ana: {name: 'Sorted agents'}, compact: {name: 'Sorted agents'}}, expect: [{title: 'Sorted agents'}, {agents: 12, drawn: false}],
    },
  ],
};

export const SETS: DemoSet[] = [all, showcase, activity];
