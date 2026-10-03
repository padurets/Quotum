import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {timeRangeLabel, type TimeRange} from '../lib/timeRange';
import {setLocale, type Locale} from '../i18n';

test('the actual period label subscribes to displayed words rather than every pan frame', () => {
  const source = readFileSync(new URL('../components/Analytics.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('function PeriodName('), end = source.indexOf('\n/**', start);
  const body = source.slice(start, end) + '\nglobalThis.PeriodName=PeriodName;';
  let preview: TimeRange | null = null, snapshot = () => null as string | null, localeReads = 0;
  const subscribe = (_listener: () => void) => () => {};
  const cache = {current: null as unknown};
  const context = {React: {createElement: (_type: string, props: unknown, children: string) => ({props, children})},
    useLocale: () => {localeReads++; return 'en';},
    useRef: () => cache,
    useSyncExternalStore: (listen: typeof subscribe, read: typeof snapshot, server: typeof snapshot) => {
      assert.equal(listen, subscribe);
      assert.equal(server(), null);
      snapshot = read;
      return read();
    },
    pan: {get: () => preview, subscribe},
    timeRangeLabel, periodOf: () => ({id: '24h'}), periodLabel: () => '24 hours',
    PeriodName: null as unknown as (props: {selected: TimeRange | null; range: string}) => {children: string}};
  runInNewContext(ts.transpileModule(body, {compilerOptions: {jsx: ts.JsxEmit.React}}).outputText, context);
  assert.equal(context.PeriodName({selected: null, range: '24h'}).children, '24 hours');
  assert.equal(snapshot(), null);
  const from = new Date(2026, 8, 1, 12).getTime(), to = new Date(2026, 9, 1, 12).getTime();
  preview = {from, to};
  const caption = snapshot();
  assert.equal(typeof caption, 'string', 'React compares the formatted caption, not a new frame object');
  for (let i = 0; i < 30; i++) {
    preview = {from: from - i * 60_000, to: to - i * 60_000};
    assert.equal(snapshot(), caption, 'movement within the same days does not invalidate the label');
  }
  preview = {from: from - 86_400_000, to: to - 86_400_000};
  assert.notEqual(snapshot(), caption);
  assert.equal(snapshot(), timeRangeLabel(preview));
  preview = {from, to: from + 60 * 60_000};
  const timed = snapshot();
  preview = {from: from + 60_000, to: from + 61 * 60_000};
  assert.notEqual(snapshot(), timed, 'short ranges continue to show the current minute');
  assert.equal(context.PeriodName({selected: null, range: '24h'}).children, timeRangeLabel(preview));
  preview = null;
  const selected = {from, to: from + 15 * 60_000};
  assert.equal(context.PeriodName({selected, range: '24h'}).children, timeRangeLabel(selected));
  assert.equal(localeReads, 3, 'locale changes still subscribe the caption for rendering');
});

test('actual period snapshots format each immutable frame and locale once while preserving exact words', () => {
  const source = readFileSync(new URL('../components/Analytics.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('function PeriodName('), body = source.slice(start, source.indexOf('\n/**', start));
  let frame: TimeRange | null = null, locale: Locale = 'en', formatted = 0, read = () => null as string | null;
  const cache = {current: null as unknown};
  const context = {React: {createElement: (_tag: string, _props: unknown, children: string) => children},
    useLocale: () => locale, useRef: () => cache, pan: {get: () => frame, subscribe: () => () => {}},
    useSyncExternalStore: (_listen: unknown, snapshot: typeof read, server: typeof read) => {assert.equal(server(), null); read = snapshot; return snapshot();},
    timeRangeLabel: (value: TimeRange) => {formatted++; return timeRangeLabel(value);},
    periodOf: () => ({id: '24h'}), periodLabel: () => '24 hours', PeriodName: null as unknown as (props: {selected: TimeRange | null; range: string}) => string,
  };
  runInNewContext(ts.transpileModule(body + '\nglobalThis.PeriodName=PeriodName;', {compilerOptions: {jsx: ts.JsxEmit.React}}).outputText, context);
  const render = () => context.PeriodName({selected: null, range: '24h'}), minute = 60_000, day = 86_400_000;
  const at = new Date(2026, 8, 1, 12).getTime();
  try {
    assert.equal(render(), '24 hours'); assert.equal(formatted, 0);
    for (const language of ['en', 'ru'] as const) {
      locale = language; setLocale(language, false);
      for (const value of [{from: at, to: at + 30 * day}, {from: at, to: at + 60 * minute}, {from: at + minute, to: at + 61 * minute}, {from: at + 11 * 60 * minute, to: at + 13 * 60 * minute}, {from: at - day, to: at + 30 * day}]) {
        frame = value; formatted = 0; const expected = timeRangeLabel(value);
        assert.equal(render(), expected);
        for (let i = 0; i < 100; i++) assert.equal(read(), expected);
        assert.equal(formatted, 1, 'React snapshot checks must reuse the words of the same immutable frame');
      }
      frame = null; assert.equal(read(), null); assert.equal(render(), '24 hours');
    }
    frame = {from: at, to: at + 30 * day}; locale = 'en'; setLocale('en', false); render(); formatted = 0;
    locale = 'ru'; setLocale('ru', false); assert.equal(render(), timeRangeLabel(frame)); assert.equal(formatted, 1, 'the same frame must refresh after locale changes');
    frame = null; assert.equal(read(), null); frame = {from: at, to: at + 30 * day}; formatted = 0;
    assert.equal(read(), timeRangeLabel(frame)); assert.equal(formatted, 1, 'restart cannot reuse a stopped frame owner');
  } finally {setLocale('en', false);}
});
