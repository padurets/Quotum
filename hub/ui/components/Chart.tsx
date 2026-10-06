import {Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {clock, countdown, countdownChangesAt, num, shortDay, stamp} from '../lib/format';
import {t, useLocale} from '../i18n';
import type {PlotBlock, PlotLine as Line} from '../lib/lines';
import {useClock} from '../lib/clock';
import {gapText, gapTone, readout as readCell, runOutPast, valueAt, type ForecastLine, type PlanLine} from '../lib/readout';
import type {TimeRange} from '../lib/timeRange';
import {cellLabel, niceTicks} from '../lib/periods';
import {coverOf, edgeOf} from '../lib/place';
import {Tooltip, useTip} from './Tooltip';
import {useTimeAxis} from './timeAxis';
import {navigationKey, type AxisNavigation} from '../lib/axisNavigation';
import {PlotLayer, PlotOverlay} from './PlotLayer';
import {covered, type PlotBuffer} from '../lib/historyPlot';
import {observationRunsPrepared,plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {usePrepared, usePreparationBasis} from './prepared';

/**
 * A moment on the time axis: ahead, a known window reset or an announced extra one;
 * behind (`past`), something that happened to a source, such as an early reset.
 */
export type Marker = {key: string; at: number; label: string; color: string; strong?: boolean; past?: boolean; detail?: string; until?: number};

/** The mark of a past event: a small diamond centred at (x, y). */
const diamond = (x: number, y: number, r = 4) => `M${x},${y - r}l${r},${r}l${-r},${r}l${-r},${-r}z`;

/** How wide an announcement's label is taken to be, and how near an edge a value hides under it (percent). */
const LABEL_WIDTH = 220;
const LABEL_BAND = 15;
/** How far apart labels stacked at the right edge stand. */
const LABEL_STEP = 22;

/** Made when first needed: a browser without it (Firefox before 125) still draws the board. */
let segmenter: Intl.Segmenter | null | undefined;
const defaultSegmenter = () =>
  (segmenter ??= typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null);

/**
 * The characters of a text as a reader counts them: a flag, an emoji with its skin tone or
 * a letter with its accent is one. Without a segmenter the common clusters are held
 * together by hand: a pair of regional indicators, and a character with the marks
 * (a variation selector among them), skin tones, tags and joined characters after it.
 */
export function graphemes(text: string, by: Intl.Segmenter | null = defaultSegmenter()) {
  return by ? Array.from(by.segment(text), part => part.segment) : (text.match(CLUSTER) ?? []);
}
const CLUSTER = /\p{Regional_Indicator}{2}|[\s\S](?:[\p{M}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|\u200d[\s\S])*/gu;

/**
 * What never hangs before the ellipsis: spaces, and marks that open, join or separate,
 * including a straight quote after a space. What ends a word stays with it: a closing
 * mark, a percent, a times sign, an emoji.
 */
const HANGING = /(?:[\s\p{Z}\p{Ps}\p{Pi}\p{Pd}\p{Pc},.:;·•/\\|&‚、。\u2212~]|(?<=\s)["'])+$/u;

/** A name shortened to its first `keep` characters and an ellipsis, with no space, separator or opening mark hanging before it. */
export function shortName(name: string, keep: number) {
  const letters = graphemes(name);
  return keep >= letters.length ? name : `${letters.slice(0, Math.max(0, keep)).join('').replace(HANGING, '')}…`;
}

/**
 * How many characters of `name` fit when the text around it takes `rest` and an ellipsis
 * `ellipsis`: the most whose widths (`widths`, one a character) leave the whole within
 * `room`. All of them when the name fits whole.
 */
export function fitting(widths: number[], rest: number, ellipsis: number, room: number) {
  const whole = widths.reduce((sum, width) => sum + width, 0);
  if (rest + whole <= room) return widths.length;
  let used = rest + ellipsis;
  let keep = 0;
  while (keep < widths.length && used + widths[keep] <= room) used += widths[keep++];
  return keep;
}

/**
 * The rows of the labels at the chart's right edge: those past it (`past`), and with them
 * every announcement inside the chart (`inside`), first, so each has a row of its own
 * however wide they are. They go from `from` down the plot, or up it. Without labels past
 * the edge there is no stack, and an announcement stands where it would alone.
 */
export function edgeRows(inside: string[], past: string[], from: number, down: boolean): Map<string, number> {
  const keys = past.length ? [...inside, ...past] : [];
  return new Map(keys.map((key, row) => [key, from + row * (down ? LABEL_STEP : -LABEL_STEP)]));
}

/** The key of the label that says how many more there are past the right edge than it has rows for. */
export const MORE = 'more';

/**
 * The labels past the right edge that the plot has `rows` for, with the announcements inside
 * the chart (`inside`) taking one each first: all of `past`, or as many as fit but one, in
 * their order, and the rest (`more`) said together on the last row.
 */
export function edgeFit<T>(inside: number, past: T[], rows: number): {shown: T[]; more: T[]} {
  if (inside + past.length <= rows) return {shown: past, more: []};
  const room = Math.max(0, rows - inside - 1);
  return {shown: past.slice(0, room), more: past.slice(room)};
}

/**
 * A label on the chart on a backing sized to its text, so no line under it gets in the way.
 * One pointing past the right edge tells its exact time under the pointer or on a tap
 * (`onTip`).
 */
function MarkerLabel({
  x,
  y,
  end,
  color,
  children,
  shorten,
  fonts,
  onTip,
}: {
  x: number;
  y: number;
  end: boolean;
  color?: string;
  children: string;
  /** Wider than `room`, the text is said again with `name` in it shortened to what fits. */
  shorten?: {name: string; say: (name: string) => string; room: number};
  /** Counts the web fonts loaded: what was measured before one came is measured again. */
  fonts: number;
  onTip?: (shown: boolean, tapped: boolean) => void;
}) {
  const text = useRef<SVGTextElement>(null);
  const whole = useRef<SVGTextElement>(null);
  const [box, setBox] = useState<{offset: number; width: number} | null>(null);
  // How many characters of the name it keeps, for the text, room and fonts it was measured
  // with (`input`): a fit found for anything else is not used, and the text shows whole.
  const input = shorten ? `${children}|${shorten.room}|${fonts}` : '';
  const [fit, setFit] = useState<{input: string; keep: number | null} | null>(null);
  const keep = fit?.input === input ? fit.keep : null;
  const shown = shorten && keep !== null ? shorten.say(shortName(shorten.name, keep)) : children;
  // Measured once for each input, on a hidden copy of the whole text with an ellipsis after
  // it: its width, each character of the name as drawn in it, and the ellipsis. Where the
  // copy does not hold the text character for character (the name not in it, spaces drawn
  // as one), or the browser will not measure, the text shows whole: a label a little wide
  // is better than a board that is not drawn.
  useLayoutEffect(() => {
    const element = whole.current;
    if (!shorten || !element) return;
    let found: number | null = null;
    try {
      const start = children.indexOf(shorten.name);
      const length = element.getSubStringLength(0, children.length);
      if (length > shorten.room && start >= 0 && element.getNumberOfChars() === children.length + 1) {
        let at = start;
        const widths = graphemes(shorten.name).map(letter => {
          const width = element.getSubStringLength(at, letter.length);
          at += letter.length;
          return width;
        });
        const name = widths.reduce((sum, width) => sum + width, 0);
        found = fitting(widths, length - name, element.getSubStringLength(children.length, 1), shorten.room);
      }
    } catch {
      found = null;
    }
    setFit(fit => (fit?.input === input && fit.keep === found ? fit : {input, keep: found}));
  }, [input]);
  useLayoutEffect(() => {
    const measured = text.current?.getBBox();
    if (measured) {
      const offset = measured.x - x, width = measured.width;
      setBox(box => box?.offset === offset && box.width === width ? box : {offset, width});
    }
    // The glyph bounds move with their anchor; only their text or font needs measuring.
  }, [end, shown, fonts, !!color]);
  return (
    <g
      className={`marker-label ${onTip ? 'is-pointed' : ''} ${color ? 'is-forecast' : ''}`}
      style={color ? ({'--label-color': color} as CSSProperties) : undefined}
      onPointerEnter={onTip && (event => event.pointerType !== 'touch' && onTip(true, false))}
      onPointerLeave={onTip && (event => event.pointerType !== 'touch' && onTip(false, false))}
      onPointerUp={onTip && (event => event.pointerType === 'touch' && onTip(true, true))}
    >
      {box && <rect x={x + box.offset - 6} y={y - 13} width={box.width + 12} height={19} rx={5} />}
      <text ref={text} x={x} y={y} textAnchor={end ? 'end' : 'start'}>
        {shown}
      </text>
      {shorten && (
        <text ref={whole} x={x} y={y} textAnchor={end ? 'end' : 'start'} visibility="hidden" aria-hidden="true">
          {`${children}…`}
        </text>
      )}
    </g>
  );
}

/**
 * A label past the right edge: what comes there and how soon, by the page's clock. A part of
 * its own, it renders when its countdown reads otherwise, and the chart does not.
 */
const EdgeLabel = memo(function EdgeLabel({
  id,
  name,
  at,
  runsOut,
  color,
  x,
  y,
  room,
  fonts,
  onEdge,
}: {
  id: string;
  name: string;
  at: number;
  /** Where a window runs out, named by its series (shortened to what fits), or an announcement. */
  runsOut: boolean;
  color?: string;
  x: number;
  y: number;
  room: number;
  fonts: number;
  onEdge: (edge: {key: string; tapped: boolean} | null) => void;
}) {
  const now = useClock(now => countdownChangesAt(at, now));
  // Its words are rebuilt when the language changes.
  useLocale();
  const say = (label: string) => t(runsOut ? 'chart.runsOut' : 'chart.ahead', {label, time: countdown(at - now)});
  return (
    <g data-time="countdown">
      <MarkerLabel
        x={x}
        y={y}
        end
        color={color}
        fonts={fonts}
        // It ends at the plot's right edge, and its backing, 6 wider than the text, starts within the plot.
        shorten={runsOut ? {name, say, room} : undefined}
        onTip={(shown, tapped) => onEdge(shown ? {key: id, tapped} : null)}
      >
        {say(name)}
      </MarkerLabel>
    </g>
  );
});

/** How tall the chart draws its plot by itself, in its units: lower on a narrow chart. */
export const plotHeight = (width: number) => (width < 560 ? 220 : 300);

/**
 * Remaining quota over time for every selected window. All series share one time
 * grid, so hovering anywhere snaps to a cell and reads every series for it — no
 * pixel hunting. Lines break only where a whole cell is empty. In a widget its owner
 * made taller, the plot is as tall as `plot` (CSS pixels), never lower than by itself;
 * it tells how tall that is (`onBase`, CSS pixels).
 */
const NO_PLANS: PlanLine[] = [];
const NO_FORECASTS: ForecastLine[] = [];
const NO_MARKERS: Marker[] = [];

export const Chart = memo(function Chart({
  lines: incomingLines,
  plans: incomingPlans = NO_PLANS,
  forecasts: incomingForecasts = NO_FORECASTS,
  markers: incomingMarkers = NO_MARKERS,
  from: desiredFrom,
  now: desiredNow,
  to: desiredTo,
  cellMs,
  empty,
  onSelect,
  plot,
  onBase,
  axis: valueAxis,
  stepped=false,
  strip: incomingStrip = null,
  prepared: incomingReady = true,
  modelContext = '',
  navigation,
  live: desiredLive = true,
  clock: currentClock = desiredNow,
}: {
  lines: Line[];
  plans?: PlanLine[];
  forecasts?: ForecastLine[];
  markers?: Marker[];
  from: number;
  /** Where measurements end; everything right of it is the future. */
  now: number;
  to: number;
  cellMs: number;
  /** Said over an empty chart; none when the legend already says it. */
  empty: string | null;
  /** A time range dragged across the chart, as in Grafana. */
  onSelect?: (range: TimeRange) => void;
  plot?: number;
  onBase?: (height: number) => void;
  axis?:{min:number;max:number;ticks:number[];label:string;formatTick:(value:number)=>string;formatValue:(key:string,value:number,at:number)=>string;rawValue?:(key:string,at:number)=>string|undefined;detail?:(key:string,at:number)=>ReactNode};
  stepped?:boolean;
  strip?: PlotBuffer | null;
  prepared?: boolean;
  modelContext?: string;
  navigation?: AxisNavigation;
  live?: boolean;
  clock?: number;
}) {
  const left = valueAxis?76:40;
  const right = 12;
  const axis = useTimeAxis({from: desiredFrom, to: desiredTo, end: desiredNow, cellMs, left, right, onSelect, ready: incomingReady, navigation,rawPointer:incomingLines.some(line=>line.pointMode==='observation')});
  const {box, svg, width, scale, drag, timeAt, handlers, panning} = axis;
  const base = plotHeight(width);
  const height = plot === undefined ? base : Math.max(base, plot / scale);
  useLayoutEffect(() => onBase?.(base * scale), [base, scale, onBase]);
  const top = 12, bottom = 28;
  const inputs = [incomingLines, incomingPlans, incomingForecasts, incomingMarkers, incomingStrip, width, height, cellMs, modelContext, navigation && navigationKey(navigation), desiredLive, valueAxis, stepped];
  const requested = usePreparationBasis({...axis.basis, end: axis.active && !incomingStrip ? axis.basis.end : desiredNow}, inputs, axis.active, incomingReady);
  const blockPaths = useRef(new WeakMap<PlotBlock, {geometry: string; line: string; last: [number, number] | null}>());
  const prepared = usePrepared(function* () {
    const basis = {from: requested.from, to: requested.to, end: requested.end};
    const span = Math.max(60_000, basis.to - basis.from);
    const x = (at: number) => left + (at - basis.from) / span * (width - left - right);
    const drawFrom = basis.from;
    const drawNow = basis.end;
    const bx = (at: number) => x(Math.min(drawNow, at + cellMs / 2));
    const y = (value: number) => top + (1 - (value-(valueAxis?.min??0)) / ((valueAxis?.max??100)-(valueAxis?.min??0))) * (height - top - bottom);
    const geometry = `${basis.from}:${basis.to}:${drawNow}:${width}:${height}:${cellMs}:${valueAxis?.min??0}:${valueAxis?.max??100}:${stepped}`;
    const paths: {line: string; last: [number, number] | null; parts: {key: string; line: string}[] | null; latest: string | undefined}[] = [];
    for (const line of incomingLines) {
      let latest: string | undefined;
      let lastAt:number|undefined;
      for (const [at, remaining] of line.points) {if (at > drawNow) break; latest = `${at}:${remaining}`; lastAt=at; yield;}
      if(lastAt!==undefined&&valueAxis?.rawValue)latest=`${lastAt}:${valueAxis.rawValue(line.key,lastAt)}`;
      if(line.pointMode==='observation') {
        const observed=yield* observationRunsPrepared(line.points,incomingStrip?.from??drawFrom,incomingStrip?.to??basis.to,drawNow);
        const runs:[number,number][][]=[];
        for(const run of observed.runs){const mapped:[number,number][]=[];for(const [at,value] of run){mapped.push([x(at),y(value)]);yield;}runs.push(mapped);}
        paths.push({line:yield* plotPathPrepared(runs,true),last:observed.last?[x(observed.last[0]),y(observed.last[1])]:null,parts:null,latest});
      } else if (incomingStrip && line.blocks) {
        let last: [number, number] | null = null;
        const parts: {key: string; line: string}[] = [];
        for (const {block, join} of line.blocks) {
          let cached = blockPaths.current.get(block);
          if (!cached || cached.geometry !== geometry) {
            let segment = -1, previousX = -Infinity;
            const runs: [number, number][][] = [];
            let end: [number, number] | null = null;
            for (const [at, remaining, group] of block.points) {
              yield;
              if (at > drawNow) break;
              const px = bx(at), py = y(remaining);
              if (group === segment && px - previousX < .5) continue;
              if (group !== segment) runs.push([]);
              runs.at(-1)!.push([px, py]); segment = group; previousX = px; end = [px, py];
            }
            cached = {geometry, line: yield* plotPathPrepared(runs,stepped), last: end};
            blockPaths.current.set(block, cached);
          }
          const bridge = join && cached.line && last ? `M${last[0].toFixed(1)},${last[1].toFixed(1)}L${cached.line.slice(1)}` : cached.line;
          if (cached.last) last = cached.last;
          parts.push({key: `${block.from}:${block.to}`, line: bridge}); yield;
        }
        paths.push({line: '', last, parts, latest});
      } else {
        const runs: [number, number][][] = [];
        let segment = -1, previousX = -1;
        for (const [at, remaining, group] of line.points) {
          yield;
          if (at + cellMs < (incomingStrip?.from ?? drawFrom)) continue;
          if (at > drawNow) break;
          const px = bx(at), py = y(remaining);
          if (group !== segment) {runs.push([]); segment = group;}
          else if (px - previousX < .5) continue;
          runs.at(-1)!.push([px, py]); previousX = px;
        }
        paths.push({line: yield* plotPathPrepared(runs,stepped), last: runs.at(-1)?.at(-1) ?? null, parts: null, latest});
      }
    }
    const forecasts = desiredLive ? incomingForecasts : NO_FORECASTS;
    const markers: Marker[] = [];
    for (const marker of incomingMarkers) {if (desiredLive || marker.past) markers.push(marker); yield;}
    const planPaths: string[] = [], forecastPaths: string[] = [];
    const futureFrom = incomingStrip?.from ?? basis.from - span / 2;
    const futureTo = incomingStrip ? incomingStrip.to + Math.max(0, desiredTo - desiredNow) : basis.to + span / 2;
    for (const plan of incomingPlans) {
      let path = '';
      for (const raw of plan.runs) {
        const run = yield* clipPrepared(raw, futureFrom, futureTo);
        for (let i = 0; i < run.length; i++) {const [at, value] = run[i]; path += `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`; yield;}
      }
      planPaths.push(path);
    }
    for (const forecast of forecasts) {
      let path = '';
      const points = yield* clipPrepared(forecast.points, futureFrom, futureTo);
      for (let i = 0; i < points.length; i++) {const [at, value] = points[i]; path += `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`; yield;}
      forecastPaths.push(path);
    }
    return {basis, valueAxis, lines: incomingLines, plans: incomingPlans, forecasts, markers, strip: incomingStrip, from: basis.from, now: drawNow, to: basis.to, paths, planPaths, forecastPaths};
  }, [...inputs, requested.from, requested.to, requested.end], `${modelContext}:${width}:${height}:${cellMs}`, incomingReady);
  const model = prepared.value;
  const shownAxis=model?.valueAxis??valueAxis;
  const basis = model?.basis ?? axis.basis;
  const lines = model?.lines ?? [];
  const planRows = (model?.plans ?? []).map((plan, index) => ({plan, path: model!.planPaths[index]})).filter(row => currentClock < (row.plan.until ?? Infinity));
  const forecastRows = (desiredLive ? model?.forecasts ?? [] : []).map((forecast, index) => ({forecast, path: model!.forecastPaths[index]})).filter(row => currentClock < (row.forecast.until ?? Infinity));
  const plans = planRows.map(row => row.plan), forecasts = forecastRows.map(row => row.forecast);
  const markers = (model?.markers ?? []).filter(marker => currentClock < (marker.until ?? Infinity));
  const strip = model?.strip ?? null, from = desiredFrom, now = desiredNow, to = desiredTo;
  const paths = model?.paths ?? [], planPaths = planRows.map(row => row.path), forecastPaths = forecastRows.map(row => row.path);
  const span = Math.max(60_000, basis.to - basis.from);
  const x = (at: number) => left + (at - basis.from) / span * (width - left - right);
  const y = (value: number) => top + (1 - (value-(shownAxis?.min??0)) / ((shownAxis?.max??100)-(shownAxis?.min??0))) * (height - top - bottom);
  const bx = (at: number) => axis.screenX(Math.min(now, at + cellMs / 2));
  const hover = incomingReady && prepared.ready && axis.hover !== null && (!strip || axis.hover > now || covered(strip.coverage, axis.hover, axis.hover + cellMs)) ? axis.hover : null;
  const tickFrom = strip?.from ?? from, tickTo = strip?.to ?? to;
  const {ticks, daily} = niceTicks(tickFrom, tickTo, (width < 560 ? 4 : 7) * (tickTo - tickFrom) / span);
  useLayoutEffect(() => {axis.commitDrawing(basis, incomingReady && prepared.ready);});

  const none = {left: false, plan: false, gap: false, forecast: false};
  const {rows, columns} = hover === null ? {rows: [], columns: none} : readCell(lines, plans, hover, cellMs, now, to, forecasts, strip?.coverage,axis.rawHover??hover);
  const columnCount = Object.values(columns).filter(Boolean).length;
  // A cell ahead of now where no line reads anything says only what happens in it.
  const grid = rows.length > 0 && columnCount > 0;
  const markerReadout = hover === null ? [] : markers.filter(m => m.at >= hover && m.at < hover + cellMs);
  // Labels are measured: a web font that arrives later makes them as wide as they are drawn.
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    const loaded = () => setFonts(count => count + 1);
    document.fonts?.addEventListener('loadingdone', loaded);
    return () => document.fonts?.removeEventListener('loadingdone', loaded);
  }, []);
  // Past the right edge: an announcement, then where windows run out, the soonest first, each
  // said there (`EdgeLabel`), how soon by the page's clock as the table says it.
  const beyond = [
    ...markers.filter(m => desiredLive && m.strong && !m.past && m.at > desiredTo).map(m => ({key: m.key, label: m.label, at: m.at, time: stamp(m.at), color: undefined, runsOut: false})),
    // Spaces drawn as one: a name typed with two in a row reads, and measures, as SVG draws it.
    ...runOutPast(forecasts, desiredTo)
      .sort((a, b) => a.at - b.at)
      .map(f => ({key: `forecast-${f.key}`, label: f.name.replace(/\s+/g, ' '), at: f.at, time: t('forecast.runsOutAt', {time: stamp(f.at)}), color: f.color, runsOut: true})),
  ];
  // With the announcements inside the chart, as many as the plot has rows for, from the first
  // row by one edge of the plot to the last by the other; the rest are said together.
  const announced = markers.filter(m => desiredLive && m.strong && !m.past && m.at <= desiredTo);
  const {shown: past, more} = edgeFit(announced.length, beyond, Math.floor((height - top - bottom - 26) / LABEL_STEP) + 1);
  /** A label past the right edge pointed at or tapped: the tooltip tells its time instead of the cell's values, or theirs. */
  const [edge, setEdge] = useState<{key: string; tapped: boolean} | null>(null);
  const edgeMarkers = panning || !edge ? [] : edge.key === MORE ? more : past.filter(m => m.key === edge.key);
  const edgeKey = edgeMarkers.length ? edge!.key : null;
  // A label taken away under the pointer (a step to a range, which has no future) says nothing
  // of it: what it told is forgotten, so the tooltip reads the cells again.
  useEffect(() => {
    if (edge && (!edgeKey || panning)) setEdge(null);
  }, [edge, edgeKey, panning]);
  useEffect(() => {
    if (!edge?.tapped) return;
    const hide = () => setEdge(null);
    const timer = setTimeout(hide, 4000);
    document.addEventListener('pointerdown', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', hide);
    };
  }, [edge]);

  // A label hides what runs under it: it stands at the bottom of the plot, or at the top
  // when more of the lines run near the bottom there (a limit about to run out).
  const labelY = (anchor: number, end: boolean) => {
    const [a, b] = (end ? [anchor - LABEL_WIDTH, anchor] : [anchor, anchor + LABEL_WIDTH]).map(timeAt);
    let low = 0;
    let high = 0;
    for (const line of lines) {
      for (const [at, value] of line.points) {
        if (at < a || at > b) continue;
        if (value < LABEL_BAND) low++;
        else if (value > 100 - LABEL_BAND) high++;
      }
    }
    return low > high ? top + 18 : height - bottom - 8;
  };
  // With labels past the right edge, an announcement inside the chart takes the first
  // place in their stack: a row of its own, so none lies over it, however wide they are.
  const stacked = beyond.length ? announced.length + past.length + (more.length ? 1 : 0) : 0;
  // The stack stands at the top or the bottom of the plot, where it hides less of what
  // runs under it by the edge: the lines measured, planned and foreseen.
  const stackTop = (() => {
    if (!stacked) return false;
    const band = ((stacked * LABEL_STEP + 6) / (height - top - bottom)) * 100;
    const [a, b] = [width - right - LABEL_WIDTH, width - right].map(timeAt);
    let low = 0;
    let high = 0;
    const count = (value: number | undefined) => {
      if (value === undefined) return;
      if (value < band) low++;
      else if (value > 100 - band) high++;
    };
    for (const line of lines) for (const [at, value] of line.points) if (at >= a && at <= b) count(value);
    const across = [0, 0.25, 0.5, 0.75, 1].map(share => a + (b - a) * share);
    for (const forecast of forecasts) for (const at of across) count(valueAt([forecast.points], at));
    for (const plan of plans) for (const at of across) count(valueAt(plan.runs, at));
    return high < low;
  })();
  // Stacked from the first one away from the edge of the plot it stands by.
  const stackRows = edgeRows(
    announced.map(m => m.key),
    [...past.map(label => label.key), ...(more.length ? [MORE] : [])],
    stackTop ? top + 18 : height - bottom - 8,
    stackTop,
  );
  // A cell ahead of now is read at its middle; the one holding now, at now.
  const observationHover=lines.some(l=>l.pointMode==='observation');
  const rowTime=(line:Line)=>line.pointMode==='observation'?axis.rawHover??hover!:hover!;
  const hoverX = hover === null ? 0 : hover > now ? axis.screenX(Math.min(to, hover + cellMs / 2)) : observationHover?axis.screenX(axis.rawHover??hover):bx(hover);
  // On a narrow chart it spans the chart's width under the plot; a marker's time stands over its label and does not rise.
  const narrow = width < 560;
  const {tip, style: tipStyle} = useTip(svg, {width, at: hoverX, narrow, rises: !edgeKey, bottom: height * scale});
  // A marker's time stands over its label, or under it where the bars that stick at the top
  // would cover it, and a long list of them over the label where neither leaves it whole in the
  // window (`edgeOf`): found from where the label is and how tall the tooltip is uncut, never
  // from where and as it was drawn, after every render and as the page scrolls under a pointer
  // that stays.
  const edgeRow = edgeKey ? stackRows.get(edgeKey)! : 0;
  const [edgePlace, setEdgePlace] = useState<ReturnType<typeof edgeOf>>({below: false, by: 0, cut: null});
  const placeEdge = useRef(() => {});
  placeEdge.current = () => {
    const element = tip.current;
    if (!edgeKey || !element || !svg.current) return;
    const cut = element.style.maxHeight;
    element.style.maxHeight = '';
    const tall = element.offsetHeight;
    element.style.maxHeight = cut;
    const chart = svg.current.getBoundingClientRect();
    const found = edgeOf(chart.top + (edgeRow - 18) * scale, chart.top + (edgeRow + 11) * scale, tall, innerHeight, coverOf(chart.bottom));
    setEdgePlace(same => (same.below === found.below && same.by === found.by && same.cut === found.cut ? same : found));
  };
  useLayoutEffect(() => placeEdge.current());
  const edgeShown = !!edgeKey;
  useEffect(() => {
    if (!edgeShown) return;
    const scrolled = () => placeEdge.current();
    addEventListener('scroll', scrolled, {passive: true});
    return () => removeEventListener('scroll', scrolled);
  }, [edgeShown]);
  const bandWidth = Math.max(1, axis.screenX(Math.min(to, (hover ?? 0) + cellMs)) - axis.screenX(hover ?? 0));

  return (
    <div className="chart" ref={box} {...handlers}>
      {to > now && (
        <PlotLayer width={width} height={height} scale={scale} left={left} right={right} under>
          <g className="future">
            <rect x={x(now)} width={x(to) - x(now)} y={top} height={height - top - bottom} className="future-zone" />
            <line x1={x(now)} x2={x(now)} y1={top} y2={height - bottom} className="now-line" />
          </g>
        </PlotLayer>
      )}
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        // A width the board does not give it (a gesture's, the window's) is heard only after it shows, and the board measures what shows:
        // until then the chart keeps the height it is drawn at, and what is drawn stretches to the box, neither side leaving the box's.
        style={{height: `${height * scale}px`}}
        preserveAspectRatio="none"
        role="img"
        aria-label={shownAxis?.label??t('chart.label')}
        className={onSelect ? 'is-selectable' : undefined}
      >
        <desc>{t('chart.panHint')}</desc>

        {!shownAxis&&<><line x1={left} x2={width - right} y1={y(30)} y2={y(30)} className="threshold warn" />
        <line x1={left} x2={width - right} y1={y(10)} y2={y(10)} className="threshold crit" /></>}
        {(shownAxis?.ticks??[0, 25, 50, 75, 100]).map(value => (
          <g key={value}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'axis-line' : 'grid'} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className="tick">
              {shownAxis?shownAxis.formatTick(value):`${value}%`}
            </text>
          </g>
        ))}
      </svg>
      <PlotLayer width={width} height={height} scale={scale} left={left} right={right} main>
        {ticks.map(tick => (
          <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
            {daily ? shortDay(tick) : clock(tick)}
          </text>
        ))}
        {plans.map((plan, i) => (
          <path
            key={plan.key}
            className="plan-line"
            stroke={plan.color}
            d={planPaths[i]}
          />
        ))}
        {forecasts.map((forecast, i) => (
          <path
            key={forecast.key}
            className="forecast-line"
            stroke={forecast.color}
            strokeDasharray={forecast.dash || undefined}
            d={forecastPaths[i]}
          />
        ))}
        {markers.map(marker => {
          if (!desiredLive && !marker.past || marker.at > (marker.past ? strip?.to ?? desiredTo : desiredTo)) return null;
          const mx = x(marker.at);
          if (marker.past) {
            return (
              <g key={marker.key} className="marker is-event">
                <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.color} />
                <path d={diamond(mx, top)} fill={marker.color} />
                <title>{[`${marker.label} · ${cellLabel(marker.at, 0)}`, marker.detail].filter(Boolean).join('\n')}</title>
              </g>
            );
          }
          return (
            <g key={marker.key} className={`marker ${marker.strong ? 'is-strong' : ''}`}>
              <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.strong ? undefined : marker.color} />
              {!marker.strong && <circle cx={mx} cy={y(100)} r={3} fill={marker.color} />}
              <title>{`${marker.label} · ${cellLabel(marker.at, 0)}`}</title>
            </g>
          );
        })}
        {lines.map((line, i) => (
          <g key={line.key} data-series={`${line.sourceId} ${line.windowId}`} data-last={paths[i]?.latest} stroke={line.color} strokeDasharray={line.dash || undefined}>
            {paths[i].parts?.map(part => <path key={part.key} d={part.line} className="series" />) ?? <path d={paths[i].line} className="series" />}
          </g>
        ))}
        {/* Announcements are read over the lines, each on its own backing. */}
        {announced.map(marker => {
          const mx = x(marker.at);
          const nearRight = mx > width - right - 150;
          const lx = nearRight ? mx - 6 : mx + 6;
          return (
            <MarkerLabel key={marker.key} x={lx} y={stackRows.get(marker.key) ?? labelY(lx, nearRight)} end={nearRight} fonts={fonts}>
              {marker.label}
            </MarkerLabel>
          );
        })}
        {hover === null && lines.map((line, i) => paths[i].last ? (
          <g key={`${line.key}-end`} className="line-end">
            <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={7} fill={line.color} opacity={0.18} />
            <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={3} fill={line.color} />
          </g>
        ) : null)}
      </PlotLayer>
      <PlotOverlay width={width} height={height}>
        <g>
            {/* Beyond the visible future: at the right edge, with the distance, one under another. */}
            {past.map(label => (
              <EdgeLabel
                key={label.key}
                id={label.key}
                name={label.label}
                at={label.at}
                runsOut={label.runsOut}
                color={label.color}
                x={width - right}
                y={stackRows.get(label.key)!}
                room={width - left - right - 6}
                fonts={fonts}
                onEdge={panning ? () => {} : setEdge}
              />
            ))}
            {more.length > 0 && (
              <MarkerLabel
                x={width - right}
                y={stackRows.get(MORE)!}
                end
                fonts={fonts}
                onTip={(shown, tapped) => !panning && setEdge(shown ? {key: MORE, tapped} : null)}
              >
                {t('chart.more', {count: more.length})}
              </MarkerLabel>
            )}
        </g>
        {drag && (
          <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />
        )}
        {hover !== null && (
          <g className="crosshair">
            <rect x={axis.screenX(hover)} width={bandWidth} y={top} height={height - top - bottom} className="hover-band" />
            <line x1={hoverX} x2={hoverX} y1={top} y2={height - bottom} />
            {rows.map(row => row.value !== null && <circle key={row.line.key} cx={row.line.pointMode==='observation'?hoverX:bx(hover!)} cy={y(row.value)} r={4} fill={row.line.color} />)}
          </g>
        )}
      </PlotOverlay>

      {edgeKey && !panning ? (
        <Tooltip tip={tip} className="is-edge" style={edgePlace.below ? {right: 0, top: `${(edgeRow + 11) * scale - edgePlace.by}px`, maxHeight: edgePlace.cut ?? undefined} : {right: 0, bottom: `calc(100% - ${(edgeRow - 18) * scale}px)`}}>
          {edgeMarkers.map(marker => (
            <Fragment key={marker.key}>
              <div className={`tooltip-marker ${marker.color ? '' : 'is-strong'}`} style={marker.color ? {color: marker.color} : undefined}>
                {marker.label}
              </div>
              <div className="tooltip-time">{marker.time}</div>
            </Fragment>
          ))}
        </Tooltip>
      ) : (
        hover !== null &&
        !drag &&
        (rows.some(row => row.left !== null || row.plan !== null || row.forecast !== null) || markerReadout.length > 0) && (
          <Tooltip tip={tip} className={narrow ? 'is-below' : ''} style={tipStyle}>
            <div className="tooltip-time">{cellLabel(hover, cellMs)}</div>
            {grid && (
              <div className="tooltip-grid" style={{gridTemplateColumns: `14px minmax(0, 1fr) repeat(${columnCount}, auto)`}}>
                <span />
                <span />
                {columns.left && <span className="tooltip-head">{shownAxis?.label??t('chart.left')}</span>}
                {columns.plan && <span className="tooltip-head">{t('chart.plan')}</span>}
                {columns.gap && <span className="tooltip-head">{t('chart.gap')}</span>}
                {columns.forecast && <span className="tooltip-head">{t('chart.forecast')}</span>}
                {rows.map(row => (
                  <div className="tooltip-row" key={row.line.key}>
                    <svg width="14" height="4" aria-hidden="true">
                      <line x1="0" x2="14" y1="2" y2="2" stroke={row.line.color} strokeWidth="2" strokeDasharray={row.line.dash || undefined} />
                    </svg>
                    <span className="tooltip-name">{row.line.name}</span>
                    {columns.left && <strong>{row.left !== null && (shownAxis?shownAxis.formatValue(row.line.key,row.left,rowTime(row.line)):`${num(row.left)}%`)}</strong>}
                    {columns.plan && <span className="tooltip-plan">{row.plan !== null && `${num(row.plan)}%`}</span>}
                    {columns.gap && <span className={`tooltip-gap ${row.gap !== null ? gapTone(row.gap) : ''}`}>{row.gap !== null && gapText(row.gap)}</span>}
                    {columns.forecast && <span className="tooltip-forecast">{row.forecast !== null && `${num(row.forecast)}%`}</span>}
                  </div>
                ))}
              </div>
            )}
            {shownAxis?.detail&&rows.map(row=><div className="tooltip-mark" key={'money:'+row.line.key}>{shownAxis.detail!(row.line.key,rowTime(row.line))}</div>)}
            {grid && markerReadout.length > 0 && <div className="tooltip-sep" />}
            {markerReadout.map(marker => (
              <div className={`tooltip-mark ${marker.strong ? 'is-strong' : ''}`} key={marker.key}>
                <svg width="14" height="10" aria-hidden="true">
                  {marker.past ? (
                    <path d={diamond(7, 5)} fill={marker.color} />
                  ) : (
                    <line x1="7" x2="7" y1="0" y2="10" stroke={marker.strong ? 'var(--accent)' : marker.color} strokeWidth="2" />
                  )}
                </svg>
                <strong>{clock(marker.at)}</strong>
                <span>{marker.label}</span>
                {marker.detail && <small className="tooltip-detail">{marker.detail}</small>}
              </div>
            ))}
          </Tooltip>
        )
      )}
      {!lines.length && empty && <div className="chart-empty">{empty}</div>}
    </div>
  );
});
