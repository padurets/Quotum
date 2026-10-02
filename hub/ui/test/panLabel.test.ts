import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {timeRangeLabel, type TimeRange} from '../lib/timeRange';

test('the actual period label paints pan frames without scheduling React renders', () => {
  const source = readFileSync(new URL('../components/Analytics.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('function PeriodName('), end = source.indexOf('\n/**', start);
  const body = source.slice(start, end) + '\nglobalThis.PeriodName=PeriodName;';
  let preview: TimeRange | null = null, subscribed = () => {}, renderRefs = 0, writes = 0;
  let content = '';
  const element = {firstChild: {get nodeValue() {return content;}, set nodeValue(value: string) {content = value; writes++;}},
    set textContent(_value: string) {throw new Error('the caption must retain its React-owned text node');}};
  const text = {current: element}, update = {current: () => {}};
  const commits: (() => void)[] = [];
  const context = {React: {createElement: (_type: string, props: unknown, children: string) => ({props, children})},
    useLocale: () => 'en', useRef: () => renderRefs++ % 2 === 0 ? text : update,
    useLayoutEffect: (commit: () => void) => commits.push(commit),
    useSyncExternalStore: () => {throw new Error('a raw pan frame cannot schedule a React label render');},
    pan: {get: () => preview, subscribe: (listener: () => void) => {subscribed = listener; return () => {}; }},
    timeRangeLabel, periodOf: () => ({id: '24h'}), periodLabel: () => '24 hours', PeriodName: null as unknown as (props: {selected: TimeRange | null; range: string}) => unknown};
  runInNewContext(ts.transpileModule(body, {compilerOptions: {jsx: ts.JsxEmit.React}}).outputText, context);
  context.PeriodName({selected: null, range: '24h'});
  commits.shift()!(); commits.shift()!();
  assert.equal(content, '24 hours');
  for (let i = 0; i < 30; i++) {
    preview = {from: 1_790_000_000_000 - i * 60_000, to: 1_790_086_400_000 - i * 60_000};
    subscribed(); assert.equal(content, timeRangeLabel(preview));
  }
  assert.equal(renderRefs, 2, 'frames update the displayed label without another component render');
  const before = writes; subscribed();
  assert.equal(writes, before, 'an unchanged caption makes no DOM mutation');
  preview = null; subscribed();
  assert.equal(content, '24 hours');
  const selected = {from: 1_790_000_000_000, to: 1_790_010_000_000};
  context.PeriodName({selected, range: '24h'});
  assert.equal(content, '24 hours', 'preparing a new label cannot publish it before the DOM commit');
  commits.shift()!();
  assert.equal(content, timeRangeLabel(selected));
});
