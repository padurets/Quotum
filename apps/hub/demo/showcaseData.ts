import type {Place} from '../server/domain/layout.js';
import {
  agentsWork,
  busyIn,
  DAY,
  HOUR,
  isOn,
  MIN,
  rhythmic,
  rolling,
  WEEK,
  type Agent,
  type Card,
  type DemoSet,
  type Machine,
  type Person,
  type Wave,
} from './model.js';

const HISTORY = 10 * DAY;
const MONDAY = -(4 * DAY + 17.5 * HOUR); // The board opens on Friday at 17:30.

// A focus day, a day with reviews and a release evening have visibly different
// work intervals. A half-day leaves room for meetings or work outside the clients.
const focus = [
  [9.5, 12.5],
  [14.5, 18.5],
];
const reviews = [
  [9, 10.5],
  [11.5, 13],
  [14.5, 16],
  [17, 18],
];
const release = [
  [10, 12],
  [14, 16.5],
  [17, 19],
  [20, 21.5],
];
const morning = [
  [9.5, 11],
  [11.5, 13],
];
const afternoon = [
  [14, 16],
  [16.5, 18.5],
];
const handoff = [
  [9, 12],
  [16, 18],
];
const short = [
  [10, 11.5],
  [15, 16.5],
];
const weekDays = [
  [focus, morning, reviews, release, reviews],
  [afternoon, release, morning, focus, handoff],
  [reviews, focus, afternoon, release, focus],
  [focus, short, morning, reviews, afternoon],
  [morning, afternoon, short, focus, reviews],
  [release, reviews, short, release, reviews],
];

/** Shifts are offsets from the opening, shared by retained sessions, live reports and quota history. */
function workingWeek(person: number): Wave[] {
  const shifts: Wave[] = [];
  const shift = (day: number, begin: number, end: number) =>
    shifts.push({period: WEEK, phase: MONDAY + day * DAY + begin * HOUR, on: (end - begin) * HOUR});
  for (const [day, blocks] of weekDays[person].entries())
    for (const [begin, end] of blocks) shift(day, begin, end);
  if (person % 3 === 0) shift(5, 10 + person / 3, 11.5 + person / 3);
  if (person === 2) shift(6, 15, 16);
  return shifts;
}

type Profile = {
  id: string;
  name: string;
  provider: Card['provider'];
  plan: string;
  devices: string[];
  projects: string[];
  week: number;
  used: number;
  shift: number;
  place: Place;
  color?: string;
};

const team = {
  alex: {
    id: 'alex-claude',
    name: 'Alex · Claude',
    provider: 'claude',
    plan: 'max',
    devices: ['macbook-pro', 'dev-linux'],
    projects: ['api', 'web-app', 'infra'],
    week: -4 * DAY - 7 * HOUR,
    used: 53,
    shift: 0,
    place: {x: 0, y: 0, w: 4, h: 9},
  },
  maya: {
    id: 'maya-codex',
    name: 'Maya · Codex',
    provider: 'codex',
    plan: 'pro',
    devices: ['maya-laptop'],
    projects: ['billing'],
    week: -2 * DAY - 3 * HOUR,
    used: 62,
    shift: 1,
    place: {x: 4, y: 1, w: 2, h: 9},
  },
  daniel: {
    id: 'daniel-antigravity',
    name: 'Daniel · Antigravity',
    provider: 'antigravity',
    plan: 'ultra',
    devices: ['daniel-workstation'],
    projects: ['search'],
    week: -3 * DAY - HOUR,
    used: 48,
    shift: 2,
    place: {x: 0, y: 2, w: 3, h: 9},
  },
  elena: {
    id: 'elena-claude',
    name: 'Elena · Claude',
    provider: 'claude',
    plan: 'pro',
    devices: ['elena-air'],
    projects: ['docs'],
    week: -5 * DAY - 2 * HOUR,
    used: 28,
    shift: 3,
    place: {x: 3, y: 3, w: 3, h: 9},
    color: '#43aca1',
  },
  sam: {
    id: 'sam-codex',
    name: 'Sam · Codex',
    provider: 'codex',
    plan: 'plus',
    devices: ['sam-thinkpad'],
    projects: ['mobile'],
    week: -DAY - 8 * HOUR,
    used: 24,
    shift: 4,
    place: {x: 0, y: 4, w: 3, h: 7},
    color: '#a2a6b8',
  },
  ci: {
    id: 'team-codex',
    name: 'Team · Codex',
    provider: 'codex',
    plan: 'team',
    devices: ['build-01', 'dev-linux'],
    projects: ['ci-review', 'release'],
    week: -3 * DAY - 8 * HOUR,
    used: 86,
    shift: 5,
    place: {x: 3, y: 5, w: 3, h: 7},
    color: '#88b1ff',
  },
} satisfies Record<string, Profile>;

function subscription(profile: Profile, board: string): Card {
  const {id, name, provider, plan, devices, projects, week, used, shift, place, color} = profile;
  const schedule = workingWeek(shift);
  const live: Agent[] = projects.map((project, i) => ({
    machine: devices[Math.min(i, devices.length - 1)],
    origin: i === 1 ? 'editor' : 'terminal',
    project,
    since: -(200 - i * 50 - shift * 10) * MIN,
    works: schedule,
  }));
  // Keep the old terminal and its successor distinct. No historical work predates its session.
  const archived = {
    ...live[0],
    folder: projects[0] + '-maintenance',
    since: -HISTORY,
    until: live[0].since,
  };
  const sessionWork = agentsWork(live, {period: HOUR, on: 40 * MIN, phase: shift * MIN});
  const gemini = provider === 'antigravity';
  const session = rolling({
    id: gemini ? 'gemini:session' : 'session',
    label: gemini ? 'Gemini Pro' : undefined,
    offset: -(4 * HOUR - shift * 13 * MIN),
    work: sessionWork,
    use: (_elapsed, busy) => (busy / HOUR) * (14 - shift),
  });
  const busyHours = busyIn(schedule, week, 0) / HOUR;
  const weeklyHours = busyIn(schedule, -WEEK, 0) / HOUR;
  const weeklyWindow = (spent: number, id = 'weekly', label?: string) => {
    const pace = spent / busyHours;
    // A busy current cycle can run out early. Previous cycles still had headroom
    // throughout their recorded work, including on the day before a reset.
    const previousPace = Math.min(pace, 90 / weeklyHours);
    return rhythmic({
      id,
      label,
      since: week,
      rate: t => {
        if (!isOn(schedule, t)) return 0;
        return t < week ? previousPace : pace;
      },
    });
  };
  const windows = [
    session,
    gemini ? weeklyWindow(used, 'gemini:weekly', 'Gemini') : weeklyWindow(used),
  ];
  if (gemini) windows.push(weeklyWindow(used * 0.76, 'claude:weekly', 'Claude'));
  if (provider === 'claude' && plan === 'max')
    windows.push(weeklyWindow(used * 0.65, 'weekly:sonnet', 'Sonnet'));
  return {
    kind: 'card',
    id,
    provider,
    plan,
    machines: devices,
    history: HISTORY,
    windows,
    agents: [archived, ...live],
    resets:
      provider === 'codex' && plan === 'pro'
        ? () => ({available: 1, expiring: [{count: 1, expiresAt: 11 * DAY}]})
        : undefined,
    on: {[board]: {name, place, color}},
    expect: [
      {board, title: name},
      {board, agents: live.length, drawn: true},
      {board, error: null},
    ],
  };
}

const person = (name: string): Person => ({
  kind: 'person',
  id: name.toLowerCase(),
  name,
  expect: [{state: 'widgets'}],
});
const machine = (id: string, owner: string, os: Machine['os'] = 'linux'): Machine => ({
  kind: 'machine',
  id,
  person: owner,
  os,
  expect: [{os}],
});

export const SHOWCASE: DemoSet = {
  id: 'showcase',
  about: 'Core team: six subscriptions and ten days of work across seven machines',
  scene: 'showcase',
  entries: [
    ...['Alex', 'Maya', 'Daniel', 'Elena', 'Sam'].map(person),
    {
      kind: 'board',
      id: 'core',
      name: 'Core team',
      owner: 'alex',
      members: ['maya', 'daniel', 'elena', 'sam'],
      analytics: ['activity', 'agent-hours-heatmap', 'quota-history', 'quota-table'],
      expect: [{state: 'widgets'}, {admittedRoster: true}],
    },
    machine('macbook-pro', 'alex', 'macos'),
    machine('dev-linux', 'alex'),
    machine('maya-laptop', 'maya', 'macos'),
    machine('daniel-workstation', 'daniel'),
    machine('elena-air', 'elena', 'macos'),
    machine('sam-thinkpad', 'sam'),
    machine('build-01', 'sam'),
    ...Object.values(team).map(profile => subscription(profile, 'core')),
  ],
};

function desktopSubscription(profile: Profile, name: string, projects: string[], x: number) {
  return subscription(
    {
      ...profile,
      id: 'local-' + profile.provider,
      name,
      devices: ['workstation'],
      projects,
      place: {x, y: x / 2, w: 2, h: 9},
    },
    'alex',
  );
}

export const SHOWCASE_DESKTOP: DemoSet = {
  id: 'showcase-desktop',
  about: 'Three coding subscriptions on one local workstation',
  scene: 'quiet',
  entries: [
    {
      ...person('Alex'),
      analytics: ['quota-history'],
      places: {'quota-history': {x: 0, y: 0, w: 6, h: 7}},
    },
    machine('workstation', 'alex'),
    desktopSubscription(team.alex, 'Claude Code', ['api', 'infra'], 0),
    desktopSubscription(team.maya, 'Codex', ['web-app'], 2),
    desktopSubscription(team.daniel, 'Antigravity', ['search'], 4),
  ],
};

export const SHOWCASE_OPENROUTER: DemoSet = {
  id: 'showcase-openrouter',
  about: 'A Claude subscription beside an OpenRouter wallet with three scoped keys',
  scene: 'quiet',
  entries: [
    {...person('Alex'), analytics: []},
    machine('workstation', 'alex'),
    subscription(
      {
        ...team.alex,
        id: 'wallet-claude',
        name: 'Claude',
        devices: ['workstation'],
        projects: ['api'],
        place: {x: 0, y: 0, w: 3},
      },
      'alex',
    ),
  ],
};
