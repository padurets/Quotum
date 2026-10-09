import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  app,
  appLocale,
  asksToTakeOver,
  failedTitle,
  followApp,
  intervalChoices,
  intervalMenu,
  onboardingText,
  settingsSections,
  takeOverQuestion,
  takeOverText,
  takeOverTitle,
  type AgentState,
  type AppState,
} from '../lib/app';
import {setLocale} from '../i18n';

test('compact locale sync preserves the legacy choice for main-window migration', async t => {
  let saved = 'ru';
  const location = {pathname: '/compact'};
  for (const [name, value] of Object.entries({location, localStorage: {getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; }}})) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  setLocale('ru', false);
  appLocale({seq: 1, locale: null, effectiveLocale: 'en'} as AppState);
  assert.equal(saved, 'ru');
  const requested: unknown[] = [];
  inWindow(t, '__QUOTUM__', {invoke: async (_command: string, args: unknown) => {
    requested.push(args);
    return {seq: 2, locale: 'ru', effectiveLocale: 'ru'};
  }});
  location.pathname = '/';
  appLocale({seq: 1, locale: null, effectiveLocale: 'en'} as AppState);
  await flush();
  assert.deepEqual(requested, [{patch: {locale: 'ru'}}]);
});

test('panel heights serialize and coalesce while close stays responsive', async t => {
  const invoked: number[] = [];
  const replies: (() => void)[] = [];
  let closes = 0;
  inWindow(t, '__TAURI__', {core: {invoke: (command: string, args: {heightCssPx: number}) => {
    if (command === 'close_panel') { closes++; return Promise.resolve(); }
    invoked.push(args.heightCssPx);
    return new Promise<void>(resolve => replies.push(resolve));
  }}});
  const first = app.reportPanelHeight(180);
  const intermediate = app.reportPanelHeight(300);
  const last = app.reportPanelHeight(420);
  assert.deepEqual(invoked, [180]);
  await app.closePanel();
  assert.equal(closes, 1);
  replies[0]();
  await flush();
  assert.deepEqual(invoked, [180, 420]);
  replies[1]();
  await Promise.all([first, intermediate, last]);
});

test('mutations invoke and acknowledge in action order across all app controls', async t => {
  const events: string[] = [];
  const responses = new Map<string, (value: unknown) => void>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__QUOTUM__');
  Object.defineProperty(globalThis, '__QUOTUM__', {configurable: true, value: {
    invoke(command: string) {
      events.push(`invoke ${command}`);
      return new Promise(resolve => responses.set(command, resolve));
    },
  }});
  t.after(() => previous ? Object.defineProperty(globalThis, '__QUOTUM__', previous) : Reflect.deleteProperty(globalThis, '__QUOTUM__'));
  const saved = app.saveSettings({sessions: true}).then(() => events.push('accepted settings'));
  const autostart = app.setAutostart(true).then(() => events.push('accepted autostart'));
  const takeover = app.takeOver().then(() => events.push('accepted takeover'));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.deepEqual(events, ['invoke save_settings']);
  responses.get('save_settings')!({sessions: true});
  await saved;
  await flush();
  assert.deepEqual(events, ['invoke save_settings', 'accepted settings', 'invoke set_autostart']);
  responses.get('set_autostart')!({sessions: true, autostart: true});
  await autostart;
  await flush();
  assert.deepEqual(events, ['invoke save_settings', 'accepted settings', 'invoke set_autostart', 'accepted autostart', 'invoke take_over']);
  responses.get('take_over')!({agent: {state: 'measuring'}});
  await takeover;
  assert.equal(events.at(-1), 'accepted takeover');
});

test('a failed mutation releases the queue while quit and reenter bypass a pending takeover', async t => {
  const invoked: string[] = [];
  let rejectTakeover!: (error: unknown) => void;
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__QUOTUM__');
  Object.defineProperty(globalThis, '__QUOTUM__', {configurable: true, value: {
    invoke(command: string) {
      invoked.push(command);
      return command === 'take_over' ? new Promise((_resolve, reject) => { rejectTakeover = reject; }) : Promise.resolve({sessions: true});
    },
  }});
  t.after(() => previous ? Object.defineProperty(globalThis, '__QUOTUM__', previous) : Reflect.deleteProperty(globalThis, '__QUOTUM__'));
  const rejected = assert.rejects(app.takeOver(), /synthetic takeover failure/);
  const saved = app.saveSettings({sessions: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(invoked, ['take_over']);
  await Promise.all([app.quit(), app.reenter()]);
  assert.deepEqual(invoked, ['take_over', 'quit', 'reenter']);
  rejectTakeover('synthetic takeover failure');
  await rejected;
  assert.equal((await saved).sessions, true);
  assert.deepEqual(invoked, ['take_over', 'quit', 'reenter', 'save_settings']);
});

/** Puts a stand-in for the app's window on the page for one test. */
function inWindow(t: {after: (run: () => void) => void}, name: '__QUOTUM__' | '__TAURI__', value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {configurable: true, value});
  t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const state = (seq: number) => ({seq}) as AppState;

/** Tauri's API as the page sees it: `invoke` and `Channel`, noting in which order they are used. */
function tauri(order: string[], watching: (channel: {onmessage: (state: AppState) => void}) => Promise<unknown>) {
  class Channel {
    onmessage: (state: AppState) => void = () => {};
  }
  return {
    core: {
      Channel,
      invoke(command: string, args?: {channel?: Channel}) {
        order.push(command);
        return command === 'watch_state' ? watching(args!.channel!) : Promise.resolve(state(1));
      },
    },
  };
}

test("on Windows the board asks for the app's state only after the app's first message reached it", async t => {
  const order: string[] = [];
  let channel!: {onmessage: (state: AppState) => void};
  inWindow(t, '__TAURI__', tauri(order, watched => ((channel = watched), Promise.resolve())));
  const got: number[] = [];
  followApp(next => got.push(next.seq));
  await flush();
  assert.deepEqual(order, ['watch_state'], 'watching first, and nothing asked before a message');
  channel.onmessage(state(3));
  await flush();
  assert.deepEqual(order, ['watch_state', 'app_state']);
  channel.onmessage(state(4));
  await flush();
  assert.deepEqual(order, ['watch_state', 'app_state'], 'asked once');
  assert.deepEqual(got, [3, 1, 4], 'everything goes to the page; which is newest, `seq` tells');
});

test('an app that cannot send its state says so and is asked for it at once', async t => {
  const order: string[] = [];
  inWindow(t, '__TAURI__', tauri(order, () => Promise.reject(new Error('not allowed'))));
  const errors: unknown[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  t.after(() => (console.error = error));
  const got: number[] = [];
  followApp(next => got.push(next.seq));
  await flush();
  await flush();
  assert.deepEqual(order, ['watch_state', 'app_state']);
  assert.equal(errors.length, 1);
  assert.deepEqual(got, [1]);
});

test("on Linux the board watches, then asks at once: the app sends only what changes", async t => {
  const order: string[] = [];
  let send!: (state: AppState) => void;
  inWindow(t, '__QUOTUM__', {
    watch(onState: (state: AppState) => void) {
      order.push('watch');
      send = onState;
      return () => order.push('stop');
    },
    invoke(command: string) {
      order.push(command);
      return Promise.resolve(state(1));
    },
  });
  const got: number[] = [];
  const stop = followApp(next => got.push(next.seq));
  assert.deepEqual(order, ['watch', 'app_state']);
  await flush();
  send(state(2));
  stop();
  assert.deepEqual(got, [1, 2]);
  assert.equal(order.at(-1), 'stop');
});

test('in a browser there is no app to follow', () => {
  const stop = followApp(() => assert.fail('no state'));
  stop();
});

test('a provider is measured every 1 to 60 minutes; a value set by hand in the file is kept among them', () => {
  assert.deepEqual(intervalChoices(120), [1, 2, 5, 10, 15, 30, 60]);
  assert.deepEqual(intervalChoices(180), [1, 2, 3, 5, 10, 15, 30, 60]);
  assert.deepEqual(intervalChoices(7200), [1, 2, 5, 10, 15, 30, 60, 120]);
  assert.deepEqual(intervalChoices(null), [1, 2, 5, 10, 15, 30, 60]);
});

test('how often a provider is measured: as the hub needs, as for all clients, or at most so often', () => {
  const none = {intervalS: null, intervalFrom: null, inheritedS: null, inheritedFrom: null} as const;
  // Nothing set: the hub measures as often as needed.
  const auto = intervalMenu(none);
  assert.deepEqual([auto.first, auto.firstAvailable, auto.selected, auto.hint?.key], ['auto', true, 'first', 'measure.autoHint']);
  // Its own, and none for all: Auto takes it out.
  const own = intervalMenu({...none, intervalS: 300, intervalFrom: 'provider'});
  assert.deepEqual([own.first, own.firstAvailable, own.selected], ['auto', true, 5]);
  // Its own, and one for all: taking it out leaves the one for all.
  const both = intervalMenu({intervalS: 300, intervalFrom: 'provider', inheritedS: 600, inheritedFrom: 'file'});
  assert.deepEqual([both.first, both.firstAvailable, both.selected, both.hint], ['inherited', true, 5, null]);
  // Only the one for all: the app does not change it, and says where it is set.
  const file = intervalMenu({intervalS: 600, intervalFrom: 'file', inheritedS: 600, inheritedFrom: 'file'});
  assert.deepEqual([file.firstAvailable, file.selected, file.hint], [false, 10, {key: 'measure.setInFile', vars: {file: 'config.toml'}}]);
  const env = intervalMenu({intervalS: 180, intervalFrom: 'env', inheritedS: 180, inheritedFrom: 'env'});
  assert.deepEqual([env.firstAvailable, env.selected, env.hint], [false, 3, {key: 'measure.setByEnv', vars: {key: 'QUOTUM_INTERVAL'}}]);
  assert.ok(env.choices.includes(3), 'a value set by hand is among the choices');
});

test('the question about taking over names who measures, where it delivers and what becomes of it', () => {
  // A `quotum` that makes way wrote run.info: it names its hub, or says it has none.
  assert.deepEqual(takeOverText({pid: 42, hub: 'https://q.example', yields: true}), {who: 'takeover.holderPid', hub: 'takeover.hubKnown', after: 'takeover.yields'});
  assert.deepEqual(takeOverText({pid: 42, yields: true}), {who: 'takeover.holderPid', hub: null, after: 'takeover.yields'});
  // An older one: its hub is known only from the settings, and it may have been given another.
  assert.deepEqual(takeOverText({pid: 42, hub: 'https://q.example', yields: false}), {who: 'takeover.holderPid', hub: 'takeover.hubMaybe', after: 'takeover.stops'});
  assert.deepEqual(takeOverText({yields: false}), {who: 'takeover.holder', hub: 'takeover.hubUnknown', after: 'takeover.stops'});
});

test('the question stays while quotum holds the machine, and says so when taking over failed', () => {
  const held: AgentState = {state: 'held', holder: {yields: true}};
  assert.ok(asksToTakeOver(held));
  assert.equal(takeOverTitle(held), 'takeover.title');
  assert.equal(takeOverTitle({...held, error: '`quotum` (pid 42) still measures this machine'}), 'takeover.failedTitle');
  for (const state of ['starting', 'taking_over', 'measuring', 'idle'] as const) assert.ok(!asksToTakeOver({state}), state);
  assert.ok(!asksToTakeOver(undefined), 'in a browser');
});

test('the question answered stays while the app takes over, and goes once it is done', () => {
  const held = {state: 'held', holder: {yields: true}} as const;
  assert.equal(takeOverQuestion(held, null), held);
  assert.deepEqual(takeOverQuestion({state: 'taking_over'}, held), held, 'the app says it takes over at once: the question stays, saying so');
  assert.equal(takeOverQuestion({state: 'taking_over'}, null), null, 'not answered here');
  assert.equal(takeOverQuestion({state: 'measuring'}, held), null, 'taken over');
  const failed = {...held, error: '`quotum` (pid 42) still measures this machine'};
  assert.equal(takeOverQuestion(failed, held), failed, 'failed: asked again, with why');
  const again = takeOverQuestion({state: 'taking_over'}, failed)!;
  assert.deepEqual([again, takeOverTitle(again)], [held, 'takeover.title'], 'answered again: it takes over, not why it failed before');
});

test('an empty board promises numbers only while the agent measures', () => {
  assert.equal(onboardingText(undefined), 'local.onboardingMeasuring', 'in a browser: the app measures');
  assert.equal(onboardingText({state: 'starting'}), 'local.onboardingMeasuring');
  assert.equal(onboardingText({state: 'measuring'}), 'local.onboardingMeasuring');
  assert.equal(onboardingText({state: 'tracking'}), 'local.onboardingTracking');
  assert.equal(onboardingText({state: 'idle'}), 'local.onboardingIdle');
  assert.equal(onboardingText({state: 'held', holder: {yields: false}}), 'local.onboardingWaiting');
  assert.equal(onboardingText({state: 'failed', cause: 'panic', error: 'x'}), 'local.onboardingWaiting');
});

test('the trouble of the agent is titled by its cause', () => {
  assert.deepEqual((['config', 'lock', 'panic'] as const).map(failedTitle), ['failed.config', 'failed.lock', 'failed.panic']);
});

test('the settings of the app are only in its window, an account only on a server', () => {
  assert.deepEqual(settingsSections(false, false), ['account', 'browser']);
  assert.deepEqual(settingsSections(false, true), ['account', 'browser'], 'a server shown in the app’s window stays a server');
  assert.deepEqual(settingsSections(true, true), ['measuring', 'app', 'browser']);
  assert.deepEqual(settingsSections(true, false), ['browser'], 'the app’s hub in a browser: nothing of the app');
});
