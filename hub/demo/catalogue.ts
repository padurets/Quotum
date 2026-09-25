import {
  ALWAYS,
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
  weekly,
  type Agent,
  type Answer,
  type DemoSet,
  type Scene,
  type Wave,
} from './model.js';

/**
 * The catalogue of the demo board: every state the dashboard knows today, one entry each.
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
 * and checks each code over its span while time runs, so an entry that stops showing its
 * state fails the test. What only eyes can tell (an ellipsis, a colour, two cards in one
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
 * Exceptions, by name: the last day of the plan (6–6.45 days into the week at `start`)
 * and the stale card (on a machine that never comes back, its five hours already over).
 * What lives by design holds only a short span from `start` and is checked in the first
 * minutes of a run, or by starting it again: the sleeping machine, agents that come and
 * go, a five-hour window ahead of its pace, a new subscription that needs 30 minutes of
 * measurements. A code about a change of agents begins 15 seconds after it at the
 * earliest, when a list that shows it has gone out.
 *
 * A new state gets an entry here with at least one code; the test picks it up.
 */

const WEEK_PLAN_FLAT = [15, 15, 15, 15, 15, 15, 10];

/** Agents working 12 of every 20 minutes, staggered by `shift` minutes. */
const shifts = (shift: number): Wave => ({period: 20 * MIN, on: 12 * MIN, phase: shift * MIN});

/** A five-hour window spending `perHour` points an hour of work, back to back from `offset`. */
const fiveHours = (offset: number, perHour: number, wave: Wave = ALWAYS, label?: string) =>
  rolling({id: label ? `${label.split(' ')[0].toLowerCase()}:session` : 'session', label, offset, wave, use: (_elapsed, busy) => (perHour * busy) / HOUR});

const LONG_PROJECT =
  'platform-monorepo/services/billing-reconciliation-worker/migrations/2026-09-backfill-invoices-with-missing-tax-regions-and-currency-rounding-fixes-for-eu';

const agents = (machine: string, list: [Agent['origin'], string | null, number, Wave?][]): Agent[] =>
  list.map(([origin, project, since, works]) => ({machine, origin, project, since, works}));

// ---------- reset scenes ----------

const codex = (data: object): Answer => ({json: {meta: {api_version: 'v1', generated_at: null}, data: {latest_reset: null, scheduled_reset: null, active_watch: null, ...data}}});
const claude = (claudeEvents: object[], codexEvents: object[] = []): Answer => ({json: {providers: {claude: {events: claudeEvents}, codex: {events: codexEvents}}, meta: {}}});
const quiet = () => claude([]);

export const SCENES: Scene[] = [
  {
    kind: 'scene',
    id: 'announced',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'regular', announced_at: at(-5 * HOUR), scheduled_for: at(26 * HOUR), text: 'Rate limits reset for all Plus and Pro plans tomorrow.'},
        latest_reset: {announced_at: at(-9 * DAY), text: 'Limits were reset for everyone.'},
      }),
    claude: at => claude([{kind: 'reset', date: at(-3 * HOUR), scope: 'Max', note: 'Weekly limits reset for Max plans.'}, {kind: 'policy', date: at(-10 * DAY), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'in'},
      {reset: 'claude', label: 'done', scope: 'Max'},
      {tracker: 'Codex Resets', health: 'ok'},
      {tracker: 'Claude Resets', health: 'ok'},
    ],
    look: ['Codex cards: "Reset in 1d" with the date; Claude cards: "Reset happened · <time> · Max"', 'Both resets for everyone are marked on the 7-day chart'],
  },
  {
    kind: 'scene',
    id: 'banked',
    codex: at => codex({scheduled_reset: {reset_type: 'banked', announced_at: at(-HOUR), scheduled_for: at(20 * HOUR), text: 'Banked resets land tonight.'}}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'bankedIn'},
      {reset: 'claude', label: null},
    ],
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
  },
  {
    kind: 'scene',
    id: 'awaiting',
    codex: at => codex({scheduled_reset: {reset_type: 'regular', announced_at: at(-2 * DAY), scheduled_for: at(-3 * HOUR), text: 'Reset scheduled for this morning.'}}),
    claude: at => claude([{kind: 'reset', date: at(-2 * HOUR), scope: 'all', note: 'Limits reset for everyone.'}]),
    expect: [
      {reset: 'codex', label: 'awaiting'},
      {reset: 'claude', label: 'done', scope: ''},
    ],
    look: ['The Claude notice names no scope: the reset was for everyone'],
  },
  {
    kind: 'scene',
    id: 'possible',
    codex: at =>
      codex({active_watch: {observed_at: at(-2 * HOUR), expires_at: at(20 * HOUR), reset_chance_percent: 40, forecast_window: 'next 24 hours', text: 'Usage dashboards hint at another reset.'}}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'possible', chance: 40},
      {reset: 'claude', label: null},
    ],
  },
  {
    kind: 'scene',
    id: 'reset',
    codex: at => codex({latest_reset: {announced_at: at(-4 * HOUR), text: 'Limits were reset for everyone.'}}),
    claude: at => claude([{kind: 'reset', date: at(-HOUR), scope: 'Pro', note: 'Weekly limits reset for Pro plans.'}]),
    expect: [
      {reset: 'codex', label: 'done', scope: ''},
      {reset: 'claude', label: 'done', scope: 'Pro'},
    ],
  },
  {
    kind: 'scene',
    id: 'policy',
    // Codex Resets is down: Codex falls back on the Codex part of Claude Resets.
    codex: () => ({status: 503}),
    claude: at => claude([{kind: 'policy', date: at(-DAY), note: 'New weekly limits.'}], [{kind: 'policy', date: at(-6 * HOUR), note: 'Five-hour windows changed.'}]),
    expect: [
      {reset: 'codex', label: 'policy'},
      {reset: 'claude', label: 'policy'},
      {tracker: 'Codex Resets', health: 'HTTP 503'},
      {tracker: 'Claude Resets', health: 'ok'},
    ],
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

// ---------- the whole catalogue ----------

const all: DemoSet = {
  id: 'all',
  about: 'every state the dashboard knows',
  scene: 'announced',
  entries: [
    // People and boards. Ana is the first person: her personal board holds almost everything.
    {kind: 'person', id: 'ana', name: 'Ana', agents: true, expect: [{state: 'widgets'}, {weeklySeries: 10}], look: ['The table of agents lists many rows, by machine']},
    {kind: 'person', id: 'ben', name: 'Ben', agents: true, expect: [{state: 'widgets'}, {rows: 1}]},
    {kind: 'person', id: 'cleo', name: 'Cleo', expect: [{state: 'onboarding'}], look: ['Cleo has no machines: her board asks her to connect one']},
    {
      kind: 'board',
      id: 'team',
      name: 'Team',
      owner: 'ana',
      members: ['ben'],
      agents: true,
      expect: [{state: 'widgets'}, {rows: 3}],
      look: ['Cards are named with their owners', 'Ben sees Team as a member: no arranging, no invites'],
    },
    {kind: 'board', id: 'quiet', name: 'Quiet corner', owner: 'ana', members: [], agents: true, expect: [{rows: 'none'}]},
    {kind: 'board', id: 'night', name: 'Night shift', owner: 'ana', members: [], agents: true, expect: [{rows: 'noneShown'}]},
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
    {kind: 'machine', id: 'old-nuc', gone: -3 * HOUR, expect: [{via: 'token'}]},
    {kind: 'machine', id: 'ben-mac', person: 'ben', os: 'macos', failures: [{provider: 'antigravity', error: 'failed'}], expect: [{failure: {provider: 'antigravity', error: 'failed'}}]},

    // Cards. Their order is the board's, and the order in which they come to the hub.
    {
      kind: 'card',
      id: 'claude-max',
      provider: 'claude',
      plan: 'Claude Max',
      machines: ['laptop', 'build-01'],
      history: 14 * DAY,
      windows: [
        fiveHours(20 * MIN, 12, shifts(0)),
        weekly({since: -1.5 * DAY, use: through([0, 0], [0.5, 33.2], [2.5, 56.8])}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -1.5 * DAY, use: through([0, 0], [0.5, 6], [1.5, 12])}),
      ],
      agents: [
        ...agents('laptop', [
          ['terminal', 'api-gateway', -3 * HOUR, shifts(0)],
          ['terminal', 'billing', -70 * MIN, shifts(4)],
          ['terminal', 'infra', -2 * HOUR],
          ['editor', 'mobile-app', -5 * HOUR],
          ['app', null, -40 * MIN],
          ['terminal', LONG_PROJECT, -25 * MIN, shifts(8)],
        ]),
        ...agents('build-01', [
          ['terminal', 'docs-site', -4 * HOUR, shifts(2)],
          ['terminal', 'search-indexer', -90 * MIN, shifts(10)],
          ['terminal', 'nightly-release', -6 * HOUR],
          ['editor', 'design-tokens-and-theme-migration-for-web', -30 * MIN],
        ]),
      ],
      on: {ana: {}, team: {hidden: true}},
      expect: [
        {title: 'Claude'},
        {error: null},
        {stale: false},
        {agents: 10, drawn: true},
        {window: 'weekly', name: 'Weekly', level: 'ok', note: null, reset: 'resetsIn', started: true},
        {window: 'weekly:fable', name: 'Fable · weekly', note: 'behind'},
        {window: 'session', name: '5 hours'},
        {forecast: 'weekly', outlook: 'onPacePlan'},
        {forecast: 'weekly:fable', outlook: 'leftPlan', plan: 'behind'},
      ],
      look: [
        'Shares a row with the Antigravity card: the reset news under this card, none under that one',
        'Ten marks in the tray, in two groups (two machines); the panel names working, waiting and open-window agents',
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
        fiveHours(50 * MIN, 8, ALWAYS, 'Gemini Pro'),
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -3 * DAY, use: through([0, 0], [2, 37], [3, 49])}),
        weekly({id: 'claude:weekly', label: 'Claude', since: -3 * DAY, use: steady(0, 8)}),
        rolling({id: 'flash:window-1440', kind: 'other', label: 'Flash', minutes: 1440, offset: -8 * HOUR, use: elapsed => (1.5 * elapsed) / HOUR}),
        fixed({id: 'credits', label: 'Credits', used: 40}),
      ],
      on: {ana: {plan: 'off'}},
      expect: [
        {title: 'Antigravity'},
        {window: 'gemini:session', name: 'Gemini Pro · 5 hours'},
        {window: 'claude:weekly', name: 'Claude · weekly', note: null},
        {window: 'flash:window-1440', name: 'Flash · 1d'},
        {window: 'credits', name: 'Credits', reset: 'resetUnknown'},
        {forecast: 'gemini:weekly', outlook: 'onPaceReset', plan: 'none'},
        {forecast: 'credits', outlook: 'none', spent: 'unused'},
      ],
      look: ['Its plan is switched off: no pace marks on its meters', 'No reset news under it'],
    },
    {
      kind: 'card',
      id: 'antigravity-2',
      provider: 'antigravity',
      account: {name: 'Work'},
      plan: 'Pro',
      machines: ['mac-mini'],
      history: 14 * DAY,
      windows: [fiveHours(0, 7, ALWAYS, 'Gemini Pro'), weekly({id: 'gemini:weekly', label: 'Gemini', since: -2 * DAY, use: steady(0, 9)})],
      agents: agents('mac-mini', [
        ['terminal', 'ios-app', -30 * MIN, shifts(0)],
        ['editor', 'ios-app', -2 * HOUR],
      ]),
      on: {ana: {}},
      expect: [
        {title: 'Antigravity 2'},
        {stale: false, to: 3 * MIN},
        {stale: true, from: 4 * MIN, to: 16 * MIN},
        {stale: false, from: 18 * MIN, to: 46 * MIN},
        {agents: 2, drawn: true, to: 6 * MIN},
        {agents: 0, drawn: true, from: 7 * MIN, to: 17 * MIN},
        {agents: 2, drawn: true, from: 18 * MIN, to: 46 * MIN},
      ],
      look: ['Its machine sleeps from the 2nd minute to the 17th, and every 45 minutes after: the card goes stale and comes back, a gap stays on the 24-hour chart'],
    },
    {
      kind: 'card',
      id: 'codex-pro',
      provider: 'codex',
      plan: 'Pro',
      machines: ['laptop'],
      history: 14 * DAY,
      windows: [
        fiveHours(40 * MIN, 10, shifts(3)),
        // A free reset used six hours ago: the week before was due in two days.
        weekly({since: -6 * HOUR, early: 2 * DAY, use: steady(0, 20), before: (elapsed, n) => (n === -1 ? steady(10, 18)(elapsed) : steady(5, 12)(elapsed))}),
      ],
      resets: t =>
        t < -30 * HOUR
          ? {available: 0, expiresAt: null}
          : t < -6 * HOUR
            ? {available: 1, expiresAt: 20 * DAY}
            : t < -3 * HOUR
              ? {available: 0, expiresAt: null}
              : {available: 2, expiresAt: 18 * DAY},
      agents: [
        // Within the first quarter of an hour one agent stops, another starts.
        {machine: 'laptop', origin: 'terminal', project: 'checkout', since: -2 * HOUR, until: 10 * MIN, works: shifts(1)},
        {machine: 'laptop', origin: 'terminal', project: 'hotfix-4821', since: 5 * MIN, works: ALWAYS},
        ...agents('laptop', [
          ['terminal', 'ledger', -3 * HOUR, shifts(5)],
          ['terminal', 'payments-api', -50 * MIN, shifts(9)],
          ['terminal', 'fraud-rules', -20 * MIN],
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
      ],
      on: {ana: {}, night: {hidden: true}},
      expect: [
        {title: 'Codex'},
        {agents: 12, drawn: false, to: 5 * MIN},
        {agents: 13, drawn: false, from: 5 * MIN + 15 * SECOND, to: 10 * MIN},
        {agents: 12, drawn: false, from: 10 * MIN + 15 * SECOND},
        {event: 'early_reset'},
        {event: 'resets_granted'},
        {window: 'weekly', level: 'ok', note: null},
      ],
      look: [
        'Two free resets by the settings button, until a date in the tooltip',
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
      windows: [rolling({offset: -60 * MIN, use: elapsed => (0.6 * elapsed) / MIN}), weekly({since: -2.5 * DAY, use: through([0, 0], [1.5, 62.5], [2.5, 77.5])})],
      agents: agents('build-01', [['terminal', 'data-pipeline', -45 * MIN, shifts(7)]]),
      on: {ana: {name: 'Ahead of the plan', span: 4}},
      expect: [
        {title: 'Ahead of the plan'},
        {agents: 1, drawn: true},
        {window: 'weekly', level: 'warn', note: 'ahead', hint: 'weekly'},
        {window: 'session', note: 'ahead', hint: 'reset', to: 20 * MIN},
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit', plan: 'ahead'},
      ],
      look: ['A third of the row wide', 'The five hours are ahead of an even pace for the first minutes: its own tooltip'],
    },
    {
      kind: 'card',
      id: 'codex-behind',
      provider: 'codex',
      plan: 'Pro',
      machines: ['win-desktop'],
      history: 14 * DAY,
      windows: [fiveHours(90 * MIN, 6, shifts(12)), weekly({since: -2 * DAY, use: alongPlan(-15, WEEK_PLAN_FLAT)})],
      on: {ana: {name: 'Codex Pro for the platform team and the on-call rotation', color: '#43aca1', plan: WEEK_PLAN_FLAT}},
      expect: [
        {title: 'Codex Pro for the platform team and the on-call rotation'},
        {window: 'weekly', level: 'ok', note: 'behind'},
        {forecast: 'weekly', outlook: 'leftPlan', plan: 'behind'},
      ],
      look: ['Its long name ends in an ellipsis', 'Teal on the card, the chart and the table', 'Its own plan: 15% a day, 10% the last'],
    },
    {
      kind: 'card',
      id: 'codex-low',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 2 * DAY,
      windows: [fiveHours(10 * MIN, 5, shifts(14)), weekly({since: -4 * DAY, use: through([0, 0], [3, 87.2], [4, 92])})],
      on: {ana: {name: 'Running low'}, quiet: {}},
      expect: [
        {title: 'Running low'},
        {agents: 0, drawn: true},
        {window: 'weekly', level: 'crit', note: null},
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-warn'},
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
        {forecast: 'weekly', outlook: 'usedUp', spent: 'points'},
      ],
    },
    {
      kind: 'card',
      id: 'claude-last-day',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 14 * DAY,
      windows: [fiveHours(30 * MIN, 5, shifts(5)), weekly({since: -6.2 * DAY, use: through([0, 0], [5.2, 67.6], [7, 91])})],
      on: {ana: {name: 'Last day of the week'}},
      expect: [
        {title: 'Last day of the week'},
        {window: 'weekly', level: 'warn', note: null},
        {forecast: 'weekly', outlook: 'leftReset'},
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
      ],
      look: ['The five hours have not started: no pace mark, and it always resets in 5h'],
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
      look: ['Says that all its limits are hidden'],
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
      look: ['Its last values stay, under them why they are old'],
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
      windows: [fiveHours(0, 5), weekly({since: -3 * DAY, use: steady(10, 9)})],
      on: {ana: {name: 'Too slow to answer'}},
      expect: [{title: 'Too slow to answer'}, {error: 'timeout'}, {stale: true}],
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
      on: {ana: {name: 'Quiet machine'}},
      expect: [
        {title: 'Quiet machine'},
        {stale: true},
        {error: null},
        {window: 'session', reset: 'resetPassed'},
        {window: 'weekly', reset: 'resetsIn'},
      ],
      look: ['Not heard from for three hours: its five hours have reset since, waiting for a measurement'],
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
      resets: () => ({available: 1, expiresAt: null}),
      on: {ana: {name: 'CI runners (eco)'}},
      expect: [
        {title: 'CI runners (eco)'},
        {stale: false},
        {fresh: 'grey', from: 6 * MIN, to: 14 * MIN},
      ],
      look: ['Measured every quarter of an hour: its dot fades to grey and pulses again, never a warning', 'One free reset, with no end date'],
    },
    {
      kind: 'card',
      id: 'codex-new',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 10 * MIN,
      windows: [fiveHours(0, 6), weekly({since: -2 * DAY, use: steady(0, 10)})],
      on: {ana: {name: 'New subscription'}},
      expect: [
        {title: 'New subscription'},
        {forecast: 'weekly', outlook: 'needData', to: 19 * MIN},
      ],
      look: ['For its first 20 minutes the table has no forecast for it, with a tooltip why'],
    },
    {
      kind: 'card',
      id: 'team-claude',
      provider: 'claude',
      plan: 'Claude Team',
      machines: ['laptop', 'ben-mac'],
      history: 14 * DAY,
      windows: [fiveHours(2 * HOUR, 9, shifts(6)), weekly({since: -2 * DAY, use: alongPlan(-5)})],
      agents: [
        ...agents('laptop', [
          ['terminal', 'shared-infra', -HOUR, shifts(3)],
          ['terminal', 'shared-docs', -20 * MIN],
        ]),
        ...agents('ben-mac', [['terminal', 'shared-infra', -3 * HOUR, shifts(9)]]),
      ],
      on: {ana: {name: 'Team'}, team: {}},
      expect: [
        {title: 'Team'},
        {agents: 2, drawn: true},
        {board: 'team', title: 'Claude · Ana, Ben'},
        {board: 'team', agents: 3, drawn: true},
        {board: 'ben', title: 'Claude'},
      ],
    },
    {
      kind: 'card',
      id: 'ben-codex',
      provider: 'codex',
      plan: 'Plus',
      machines: ['ben-mac'],
      history: 2 * DAY,
      windows: [fiveHours(HOUR, 5), weekly({since: -4 * DAY, use: steady(0, 14)})],
      on: {team: {}},
      expect: [
        {board: 'team', title: 'Codex · Ben'},
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
      windows: [fiveHours(3 * HOUR, 5), weekly({since: -DAY, use: steady(0, 15)})],
      expect: [{title: 'Claude 2'}],
      look: ['Ben keeps this one off Team'],
    },
  ],
};

// ---------- the README images ----------

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
        fiveHours(20 * MIN, 9, shifts(0)),
        weekly({since: -(3 * DAY + 21 * HOUR), use: through([0, 0], [3, 40], [4, 44])}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -(3 * DAY + 21 * HOUR), use: through([0, 0], [3, 42], [4, 45])}),
      ],
      agents: [
        ...agents('laptop', [
          ['editor', 'mobile-app', -5 * HOUR],
          ['terminal', 'api-gateway', -3 * HOUR, ALWAYS],
          ['terminal', 'billing', -HOUR, ALWAYS],
        ]),
        ...agents('ws-2631-linux', [
          ['terminal', 'infra', -2 * HOUR, ALWAYS],
          ['terminal', 'docs-site', -25 * MIN],
        ]),
      ],
      on: {demo: {name: 'Platform team', span: 8}},
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
        fiveHours(-3 * HOUR - 8 * MIN, 5, ALWAYS, 'Gemini Pro'),
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -(3 * DAY + HOUR), use: through([0, 0], [3, 53], [4, 60])}),
        weekly({id: 'claude:weekly', label: 'Claude', since: -(3 * DAY + HOUR), use: through([0, 0], [3, 62], [4, 70])}),
      ],
      agents: agents('ws-2631-linux', [['terminal', 'eval-harness', -40 * MIN]]),
      on: {demo: {name: 'Research', span: 4, plan: 'off'}},
      expect: [{title: 'Research'}, {agents: 1, drawn: true}],
    },
    {
      kind: 'card',
      id: 'work',
      provider: 'codex',
      plan: 'pro',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [fiveHours(-3 * HOUR - 34 * MIN, 15, ALWAYS), weekly({since: -(DAY + 3 * HOUR), use: steady(0, 31)})],
      resets: t => (t < -6 * HOUR ? {available: 0, expiresAt: null} : {available: 2, expiresAt: 18 * DAY}),
      agents: agents('laptop', [['terminal', 'checkout', -HOUR, ALWAYS]]),
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
      windows: [fiveHours(-2 * HOUR - 14 * MIN, 12, ALWAYS), weekly({since: -(5 * DAY + HOUR), use: through([0, 0], [4, 55], [5, 61])})],
      agents: agents('ws-2631-linux', [
        ['terminal', 'ci-flaky-tests', -2 * HOUR, ALWAYS],
        ['terminal', 'ci-release', -HOUR, ALWAYS],
        ['terminal', 'ci-lint', -30 * MIN, ALWAYS],
      ]),
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
      windows: [fiveHours(-2 * HOUR - 44 * MIN, 4, ALWAYS), weekly({since: -(2 * DAY + HOUR), use: through([0, 0], [1, 12], [2, 20])})],
      agents: agents('ws-2631-linux', [
        ['terminal', 'thesis', -3 * HOUR, ALWAYS],
        ['terminal', 'notes', -HOUR],
      ]),
      on: {demo: {name: 'Anna', span: 5}},
      expect: [{title: 'Anna'}, {agents: 2, drawn: true}],
    },
    {
      kind: 'card',
      id: 'personal',
      provider: 'codex',
      plan: 'plus',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [fiveHours(-4 * HOUR - 14 * MIN, 8, ALWAYS), weekly({since: -(5 * DAY + 15 * HOUR), use: through([0, 0], [4.6, 80], [5.6, 88])})],
      agents: agents('laptop', [['terminal', 'dotfiles', -20 * MIN, ALWAYS]]),
      on: {demo: {name: 'Personal', span: 7}},
      expect: [{title: 'Personal'}, {agents: 1, drawn: true}],
    },
  ],
};

export const SETS: DemoSet[] = [all, showcase];
