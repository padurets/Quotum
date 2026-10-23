import {Fragment, memo, useEffect, useId, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {clock, countdown, countdownChangesAt, num, stamp} from '../lib/format';
import {t, useLocale} from '../i18n';
import {pointIndex, preciseReadout, type PlotBlock, type PlotLine as Line} from '../lib/lines';
import {useClock} from '../lib/clock';
import {gapText, gapTone, readout as readCell, runOutPast, valueAt, type ForecastLine, type PlanLine} from '../lib/readout';
import type {TimeRange} from '../lib/timeRange';
import {cellLabel, niceTicks, timeTickWords} from '../lib/periods';
import {coverOf, edgeOf} from '../lib/place';
import {Tooltip, useTip} from './Tooltip';
import {useTimeAxis} from './timeAxis';
import {navigationKey, type AxisNavigation} from '../lib/axisNavigation';
import {PlotLayer, PlotOverlay} from './PlotLayer';
import {covered, type PlotBuffer} from '../lib/historyPlot';
import {observationRunsPrepared,plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {usePrepared, usePreparationBasis} from './prepared';
import {seriesFocusStyle} from './seriesFocus';

/**
 * A moment on the time axis: ahead, a known window reset or an announced extra one;
 * behind (`past`), something that happened to a source, such as an early reset.
 */
export type Marker = {key: string; at: number; label: string; name?:string;color: string; strong?: boolean; past?: boolean; detail?: string; until?: number};
export type ValueAxis={min:number;max:number;ticks:number[];label:string;formatTick:(value:number)=>string;formatValue:(key:string,value:number,at:number)=>string;rawValue?:(key:string,at:number)=>string|undefined;observation?:(key:string,at:number)=>{at:number;value:string}|undefined;detail?:(key:string,at:number)=>ReactNode};

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

type LabelBox = {offset: number; width: number};
/** Repeated captions reuse native bounds and shortening measurements across mounts. */
class LabelBoxes {
  private fonts = -1;
  private scale = NaN;
  private readonly saved = new Map<string, LabelBox>();
  private readonly fits = new Map<string, number | null>();
  private readonly fontKeys = new Map<boolean, string>();
  clearFonts() {this.fontKeys.clear();}
  private loaded(fonts: number, scale: number) {
    if (this.fonts !== fonts || this.scale !== scale) {this.fonts = fonts; this.scale = scale; this.saved.clear(); this.fits.clear(); this.clearFonts();}
  }
  font(forecast: boolean, fonts: number, scale: number, read: () => string): string {
    this.loaded(fonts, scale);
    const known = this.fontKeys.get(forecast);
    if (known !== undefined) return known;
    const value = read();
    this.fontKeys.set(forecast, value);
    return value;
  }
  fit(text: string, name: string, room: number, forecast: boolean, fonts: number, scale: number, read: () => number | null | undefined): number | null | undefined {
    this.loaded(fonts, scale);
    const key = JSON.stringify([text, name, room, forecast]);
    if (this.fits.has(key)) return this.fits.get(key);
    const value = read();
    if (value !== undefined) {
      if (this.fits.size >= 256) this.fits.delete(this.fits.keys().next().value!);
      this.fits.set(key, value);
    }
    return value;
  }
  measure(text: string, end: boolean, forecast: boolean, fonts: number, scale: number, read: () => LabelBox | null): LabelBox | null {
    this.loaded(fonts, scale);
    const key = JSON.stringify([text, end, forecast]);
    const known = this.saved.get(key);
    if (known) return known;
    const value = read();
    if (value) {
      if (this.saved.size >= 256) this.saved.delete(this.saved.keys().next().value!);
      this.saved.set(key, value);
    }
    return value;
  }
}

/**
 * A label on the chart on a backing sized to its text, so no line under it gets in the way.
 * One pointing past the right edge tells its exact time under the pointer or on a tap
 * (`onTip`).
 */
function MarkerLabel({x,y,end,color,children,shorten,detailFrom,fonts,scale,boxes,onTip}: {
  x:number;y:number;end:boolean;color?:string;children:string;detailFrom?:number;
  shorten?:{name:string;say:(name:string)=>string;room:number;bounded?:boolean};
  fonts:number;scale:number;boxes:LabelBoxes;onTip?:(shown:boolean,tapped:boolean)=>void;
}) {
  const text=useRef<SVGTextElement>(null),whole=useRef<SVGTextElement>(null),rest=useRef<SVGTextElement>(null);
  const cache=useRef<{identity:string;widths:number[];ellipsis:number;full:number}|null>(null);
  const suffixCache=useRef<{identity:string;width:number}|null>(null);
  const [box,setBox]=useState<{offset:number;width:number}|null>(null);
  const input=shorten?JSON.stringify([children,shorten.name,shorten.room,fonts,scale,!!color,!!shorten.bounded]):'';
  const [fit,setFit]=useState<{input:string;keep:number|null;degraded:boolean}|null>(null);
  const valid=fit?.input===input;
  const degraded=!!shorten?.bounded&&(!valid||!!fit?.degraded);
  const shown=degraded?shorten!.say('…'):shorten&&valid&&fit.keep!==null?shorten.say(shortName(shorten.name,fit.keep)):children;
  const shownName=detailFrom===undefined?undefined:degraded?'…':shorten&&valid&&fit.keep!==null?shortName(shorten.name,fit.keep):shorten?.name;
  const detail=detailFrom!==undefined&&shownName&&shownName.length>detailFrom&&shown.startsWith(shownName)?{from:detailFrom,to:shownName.length}:null;
  const room=Math.max(1,shorten?.room??1);
  const fontOf=(element:SVGTextElement)=>boxes.font(!!color,fonts,scale,()=>{
    const style=getComputedStyle(element);
    return JSON.stringify([fonts,scale,style.fontFamily,style.fontSize,style.fontWeight,style.fontStyle,style.letterSpacing,style.fontStretch]);
  });
  // Every participating label clears before any layout effects read the shared styles.
  useInsertionEffect(()=>{boxes.clearFonts();});
  useLayoutEffect(()=>{
    if(!shorten||!whole.current||!rest.current)return;
    let keep:number|null=null,failed=false;
    try {
      const element=whole.current,suffixElement=rest.current,font=fontOf(element);
      const read=()=>{
      const identity=JSON.stringify([shorten.name,font]);
      if(cache.current?.identity!==identity){
        if(element.getNumberOfChars()!==shorten.name.length+1)throw new Error('unavailable SVG character mapping');
        let at=0,previous=0;
        const widths=graphemes(shorten.name).map(letter=>{
          at+=letter.length;const prefix=element.getSubStringLength(0,at),width=prefix-previous;previous=prefix;
          if(!Number.isFinite(width)||width<0)throw new Error('unavailable SVG prefix');return width;
        });
        const ellipsis=element.getSubStringLength(shorten.name.length,1);
        if(!(previous>0)||!(ellipsis>0))throw new Error('unavailable SVG font');
        cache.current={identity,widths,ellipsis,full:previous};
      }
      const suffix=shorten.say(''),suffixIdentity=JSON.stringify([suffix,font]);
      if(suffixCache.current?.identity!==suffixIdentity){
        const width=suffixElement.getComputedTextLength();
        if(!Number.isFinite(width)||width<0||suffix.length>0&&width===0)throw new Error('unavailable SVG suffix');
        suffixCache.current={identity:suffixIdentity,width};
      }
      const measured=cache.current;
      return fitting(measured.widths,suffixCache.current.width,measured.ellipsis,shorten.room);
      };
      // Bounded labels must verify the shaping of their own mounted text.
      keep=shorten.bounded?read():boxes.fit(JSON.stringify([children,font]),shorten.name,shorten.room,!!color,fonts,scale,read)??null;
    }catch{failed=true;}
    setFit(previous=>previous?.input===input&&previous.keep===keep&&previous.degraded===failed?previous:{input,keep,degraded:failed});
  },[input]);
  useLayoutEffect(()=>{
    if(degraded)return;
    try {
      const element=text.current;if(!element)throw new Error('unavailable SVG text');
      const read=()=>{
        const measured=element.getBBox();
        if(!Number.isFinite(measured.width)||measured.width<=0)throw new Error('unavailable SVG bounds');
        if(shorten?.bounded&&measured.width>shorten.room+.01)throw new Error('SVG shaping exceeds room');
        return {offset:measured.x-x,width:measured.width};
      };
      const measured=shorten?.bounded?read():boxes.measure(JSON.stringify([shown,fontOf(element)]),end,!!color,fonts,scale,read);
      if(measured)setBox(previous=>previous?.offset===measured.offset&&previous.width===measured.width?previous:measured);
    }catch{
      if(shorten?.bounded)setFit(previous=>previous?.input===input&&previous.degraded?previous:{input,keep:null,degraded:true});
    }
    // Position only applies the cached local bounds; it never measures text.
  },[end,shown,fonts,scale,!!color,degraded,shorten?.bounded,shorten?.room]);
  const local=degraded?{offset:end?-room:0,width:room}:box;
  return <g className={`marker-label ${onTip?'is-pointed':''} ${color?'is-forecast':''}`} style={color?({'--label-color':color} as CSSProperties):undefined}
    onPointerEnter={onTip&&(event=>event.pointerType!=='touch'&&onTip(true,false))}
    onPointerLeave={onTip&&(event=>event.pointerType!=='touch'&&onTip(false,false))}
    onPointerUp={onTip&&(event=>event.pointerType==='touch'&&onTip(true,true))}>
    {local&&<rect x={x+local.offset-6} y={y-13} width={local.width+12} height={19} rx={5}/>}
    <text ref={text} x={x} y={y} textAnchor={end?'end':'start'} textLength={degraded?room:undefined} lengthAdjust={degraded?'spacingAndGlyphs':undefined}>{detail?<>{shown.slice(0,detail.from)}<tspan fill="var(--text-3)">{shown.slice(detail.from,detail.to)}</tspan>{shown.slice(detail.to)}</>:shown}</text>
    {shorten&&<>
      <text ref={whole} visibility="hidden" aria-hidden="true" xmlSpace="preserve">{`${shorten.name}…`}</text>
      <text ref={rest} visibility="hidden" aria-hidden="true" xmlSpace="preserve">{shorten.say('')}</text>
    </>}
  </g>;
}

/**
 * A label past the right edge: what comes there and how soon, by the page's clock. A part of
 * its own, it renders when its countdown reads otherwise, and the chart does not.
 */
const EdgeLabel = memo(function EdgeLabel({
  id,
  name,
  detailFrom,
  at,
  runsOut,
  color,
  x,
  y,
  room,
  compact,
  fonts,
  scale,
  boxes,
  onEdge,
}: {
  id: string;
  name: string;
  detailFrom?: number;
  at: number;
  /** Where a window runs out, named by its series (shortened to what fits), or an announcement. */
  runsOut: boolean;
  color?: string;
  x: number;
  y: number;
  room: number;
  compact?:boolean;
  fonts: number;
  /** Native glyph metrics also follow the SVG viewport scale. */
  scale: number;
  boxes: LabelBoxes;
  onEdge: (edge: {key: string; tapped: boolean} | null) => void;
}) {
  const now = useClock(now => countdownChangesAt(at, now));
  // Its words are rebuilt when the language changes.
  useLocale();
  const say = (label: string) => t(compact?'chart.compactAhead':runsOut ? 'chart.runsOut' : 'chart.ahead', {label, time: countdown(at - now)});
  return (
    <g data-time="countdown">
      <MarkerLabel
        x={x}
        y={y}
        end
        color={color}
        fonts={fonts} scale={scale} boxes={boxes}
        detailFrom={detailFrom}
        // It ends at the plot's right edge, and its backing, 6 wider than the text, starts within the plot.
        shorten={runsOut||compact ? {name, say, room,bounded:compact} : undefined}
        onTip={(shown, tapped) => onEdge(shown ? {key: id, tapped} : null)}
      >
        {say(name)}
      </MarkerLabel>
    </g>
  );
});

function InsideLabel({marker,x,y,end,room,fonts,scale,boxes,compact,onEdge}:{marker:Marker;x:number;y:number;end:boolean;room:number;fonts:number;scale:number;boxes:LabelBoxes;compact:boolean;onEdge:(edge:{key:string;tapped:boolean}|null)=>void}) {
  const now=useClock(now=>compact?countdownChangesAt(marker.at,now):null);
  useLocale();
  const name=marker.name??marker.label,say=(label:string)=>t('chart.compact',{label,time:countdown(marker.at-now)});
  return <g data-time={compact?'countdown':undefined}><MarkerLabel x={x} y={y} end={end} fonts={fonts} scale={scale} boxes={boxes} shorten={compact?{name,say,room,bounded:true}:undefined} onTip={(shown,tapped)=>onEdge(shown?{key:marker.key,tapped}:null)}>{compact?say(name):marker.label}</MarkerLabel></g>;
}

function MarkerTime({at,time}:{at:number;time:string}) {
  const now=useClock(now=>at>now?countdownChangesAt(at,now):null);
  useLocale();
  return <div className="tooltip-time"><div data-time="countdown">{at>now?t('chart.markerIn',{time:countdown(at-now)}):null}</div><div>{time}</div></div>;
}

/** Narrow labels include their backing in this budget; their text leaves room for its padding. */
export const labelRoom=(usable:number)=>Math.max(1,Math.min(180,usable*.6)-12);
export function announcementLayout(at:number,left:number,right:number,compact:boolean) {
  const end=compact?right-at<at-left:at>right-150;
  const x=at+(end?-6:6);
  const room=Math.min(labelRoom(right-left),Math.max(1,(end?x-left:right-x)-6));
  return {end,x,room};
}

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
// Moving captions keep a stable callback so their memo can skip unchanged props.
const ignoreEdge = () => {};

export const Chart = memo(function Chart({
  lines: incomingLines,
  plans: incomingPlans = NO_PLANS,
  forecasts: incomingForecasts = NO_FORECASTS,
  markers: incomingMarkers = NO_MARKERS,
  from: desiredFrom,
  now: desiredNow,
  to: desiredTo,
  cellMs: incomingCellMs,
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
  onDrawing,
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
  axis?:ValueAxis;
  onDrawing?:(axis:ValueAxis|undefined)=>void;
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
  const axis = useTimeAxis({from: desiredFrom, to: desiredTo, end: desiredNow, cellMs: incomingCellMs, left, right, onSelect, ready: incomingReady, precise: incomingLines.some(preciseReadout), navigation});
  const {box, svg, width, scale, drag, timeAt, handlers, panning} = axis;
  const base = plotHeight(width);
  const height = plot === undefined ? base : Math.max(base, plot / scale);
  useLayoutEffect(() => onBase?.(base * scale), [base, scale, onBase]);
  const top = 12, bottom = 28;
  const inputs = [incomingLines, incomingPlans, incomingForecasts, incomingMarkers, incomingStrip, width, height, incomingCellMs, modelContext, navigation && navigationKey(navigation), desiredLive, valueAxis, stepped];
  const requested = usePreparationBasis({...axis.basis, end: axis.active && !incomingStrip ? axis.basis.end : desiredNow}, inputs, axis.active, incomingReady, modelContext);
  const blockPaths = useRef(new WeakMap<PlotBlock, {geometry: string; line: string; last: [number, number] | null}>());
  const prepared = usePrepared(function* () {
    const cellMs = incomingCellMs;
    const basis = {from: requested.from, to: requested.to, end: requested.end};
    const span = Math.max(60_000, basis.to - basis.from);
    const x = (at: number) => left + (at - basis.from) / span * (width - left - right);
    const drawFrom = basis.from;
    const drawNow = basis.end;
    const bx = (at: number) => x(Math.min(drawNow, at + cellMs / 2));
    const y = (value: number) => top + (1 - (value-(valueAxis?.min??0)) / ((valueAxis?.max??100)-(valueAxis?.min??0))) * (height - top - bottom);
    const geometry = `${basis.from}:${basis.to}:${drawNow}:${width}:${height}:${cellMs}:${valueAxis?.min??0}:${valueAxis?.max??100}:${stepped}`;
    const paths: {line: string; last: [number, number] | null; parts: {key: string; line: string}[] | null; latest: string | undefined; observation?:string}[] = [];
    for (const line of incomingLines) {
      let latest: string | undefined;
      let observation: string | undefined;
      let lastAt:number|undefined,lastRemaining:number|undefined;
      for (const [at, remaining] of line.points) {if (at > drawNow) break; lastAt=at; lastRemaining=remaining; yield;}
      if(lastAt!==undefined)latest=`${lastAt}:${lastRemaining}`;
      if(lastAt!==undefined&&valueAxis?.rawValue){
        const value=valueAxis.rawValue(line.key,lastAt);latest=`${lastAt}:${value}`;
        // An unchanged balance can advance its observation without moving its drawing cell.
        const proof=line.pointMode==='observation'?valueAxis.observation?.(line.key,lastAt):undefined;
        if(proof&&Number.isSafeInteger(proof.at)&&proof.at>=0&&proof.at<=drawNow&&proof.value===value)observation=`${proof.at}:${value}`;
      }
      if(line.pointMode==='observation') {
        const observed=yield* observationRunsPrepared(line.points,incomingStrip?.from??drawFrom,incomingStrip?.to??basis.to,drawNow);
        const runs:[number,number][][]=[];
        for(const run of observed.runs){const mapped:[number,number][]=[];for(const [at,value] of run){mapped.push([x(at),y(value)]);yield;}runs.push(mapped);}
        paths.push({line:yield* plotPathPrepared(runs,true),last:observed.last?[x(observed.last[0]),y(observed.last[1])]:null,parts:null,latest,observation:observed.runs.length?observation:undefined});
      } else if(line.capCells) {
        let path='',last:[number,number]|null=null;
        for(const cell of line.capCells) {
          yield;
          const start=Math.max(cell.from,incomingStrip?.from??drawFrom),end=Math.min(cell.to,drawNow);
          if(end<=start)continue;
          const py=y(cell.value);
          path+=`M${x(start).toFixed(1)},${py.toFixed(1)}L${x(end).toFixed(1)},${py.toFixed(1)}`;
          last=[x(end),py];
        }
        paths.push({line:path,last,parts:null,latest});
      } else if (incomingStrip && line.blocks) {
        let last: [number, number] | null = null;
        const parts: {key: string; line: string}[] = [];
        for (const {block, join} of line.blocks) {
          let cached = blockPaths.current.get(block);
          if (!cached || cached.geometry !== geometry) {
            let segment = -1, previousX = -Infinity;
            const runs: [number, number][][] = [];
            let end: [number, number] | null = null;
            for (const [at, remaining, group, , validUntil] of block.points) {
              yield;
              if (at > drawNow) break;
              if (validUntil !== undefined && validUntil <= at) {segment = -1; continue;}
              const px = validUntil === undefined ? bx(at) : x(Math.min(drawNow, at + cellMs / 2, validUntil)), py = y(remaining);
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
        for (const [at, remaining, group, validUntil] of line.points) {
          yield;
          if (at + cellMs < (incomingStrip?.from ?? drawFrom)) continue;
          if (at > drawNow) break;
          if (validUntil !== undefined && validUntil <= at) {segment = -1; continue;}
          const px = validUntil === undefined ? bx(at) : x(Math.min(drawNow, at + cellMs / 2, validUntil)), py = y(remaining);
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
    return {basis, cellMs, valueAxis, lines: incomingLines, plans: incomingPlans, forecasts, markers, strip: incomingStrip, from: basis.from, now: drawNow, to: basis.to, paths, planPaths, forecastPaths};
  }, [...inputs, requested.from, requested.to, requested.end], `${modelContext}:${width}:${height}`, incomingReady);
  const model = prepared.value;
  const cellMs = model?.cellMs ?? incomingCellMs;
  useLayoutEffect(()=>onDrawing?.(model?.valueAxis),[model?.valueAxis,onDrawing]);
  const shownAxis=model?.valueAxis??valueAxis;
  const basis = model?.basis ?? axis.basis;
  const lines = model?.lines ?? [];
  const planRows = (model?.plans ?? []).map((plan, index) => ({plan, path: model!.planPaths[index]})).filter(row => currentClock < (row.plan.until ?? Infinity));
  const forecastRows = (desiredLive ? model?.forecasts ?? [] : []).map((forecast, index) => ({forecast, path: model!.forecastPaths[index]})).filter(row => currentClock < (row.forecast.until ?? Infinity));
  const plans = planRows.map(row => row.plan), forecasts = forecastRows.map(row => row.forecast);
  const markers = (model?.markers ?? []).filter(marker => currentClock < (marker.until ?? Infinity));
  const strip = model?.strip ?? null, now = desiredNow, to = desiredTo;
  const paths = model?.paths ?? [], planPaths = planRows.map(row => row.path), forecastPaths = forecastRows.map(row => row.path);
  const span = Math.max(60_000, basis.to - basis.from);
  const x = (at: number) => left + (at - basis.from) / span * (width - left - right);
  const y = (value: number) => top + (1 - (value-(shownAxis?.min??0)) / ((shownAxis?.max??100)-(shownAxis?.min??0))) * (height - top - bottom);
  const bx = (at: number) => axis.screenX(Math.min(now, at + cellMs / 2));
  const hover = incomingReady && prepared.ready && axis.hover !== null && (!strip || axis.hover > now || covered(strip.coverage, axis.hover, axis.hover + cellMs)) ? axis.hover : null;
  const pointedAt = axis.hoverAt ?? axis.rawHover ?? hover;
  const presentation = axis.presentation(incomingReady && prepared.ready);
  const tickFrom = strip?.from ?? presentation.from, tickTo = strip?.to ?? presentation.to;
  const {ticks, daily} = niceTicks(tickFrom, tickTo, width < 560 ? 4 : 7, presentation);
  const tickWords = timeTickWords(ticks,daily,presentation);
  useLayoutEffect(() => {axis.commitDrawing(basis, incomingReady && prepared.ready);});

  const none = {left: false, plan: false, gap: false, forecast: false};
  const {rows, columns} = hover === null ? {rows: [], columns: none} : readCell(lines, plans, hover, cellMs, now, to, forecasts, strip?.coverage, pointedAt!);
  const columnCount = Object.values(columns).filter(Boolean).length;
  // A cell ahead of now where no line reads anything says only what happens in it.
  const grid = rows.length > 0 && columnCount > 0;
  // A diamond on a cell boundary remains reachable across rounding and a touch's width.
  const markerReadout = hover === null ? [] : markers.filter(m => m.at >= hover && m.at < hover + cellMs || m.past && Math.abs(axis.screenX(m.at)-axis.screenX(pointedAt!))<=4);
  // Labels are measured: a web font that arrives later makes them as wide as they are drawn.
  const [fonts, setFonts] = useState(0);
  const [boxes] = useState(() => new LabelBoxes());
  useEffect(() => {
    const loaded = () => setFonts(count => count + 1);
    document.fonts?.addEventListener('loadingdone', loaded);
    return () => document.fonts?.removeEventListener('loadingdone', loaded);
  }, []);
  // Past the right edge: an announcement, then where windows run out, the soonest first, each
  // said there (`EdgeLabel`), how soon by the page's clock as the table says it.
  const beyond = [
    ...markers.filter(m => desiredLive && m.strong && !m.past && m.at > desiredTo).map(m => ({key: m.key, label: m.label, name:m.name??m.label,detailFrom:undefined,at: m.at, time: stamp(m.at), color: undefined, runsOut: false})),
    // Spaces drawn as one: a name typed with two in a row reads, and measures, as SVG draws it.
    ...runOutPast(forecasts, desiredTo)
      .sort((a, b) => a.at - b.at)
      .map(f => {
        const boundary=f.name.indexOf('\n');
        return {key:`forecast-${f.key}`,label:f.name,name:f.name.replace(/\s+/g,' '),
          detailFrom:boundary<0?undefined:f.name.slice(0,boundary).trimEnd().replace(/\s+/g,' ').length+1,
          at:f.at,time:t('forecast.runsOutAt',{time:stamp(f.at)}),color:f.color,runsOut:true};
      }),
  ];
  // With the announcements inside the chart, as many as the plot has rows for, from the first
  // row by one edge of the plot to the last by the other; the rest are said together.
  const announced = markers.filter(m => desiredLive && m.strong && !m.past && m.at <= desiredTo);
  const {shown: past, more} = edgeFit(announced.length, beyond, Math.floor((height - top - bottom - 26) / LABEL_STEP) + 1);
  /** A label past the right edge pointed at or tapped: the tooltip tells its time instead of the cell's values, or theirs. */
  const [edge, setEdge] = useState<{key: string; tapped: boolean} | null>(null);
  const edgeMarkers = panning || !edge ? [] : edge.key === MORE ? more : [...past,...announced.map(m=>({key:m.key,label:m.label,name:m.name??m.label,at:m.at,time:stamp(m.at),color:undefined,runsOut:false}))].filter(m => m.key === edge.key);
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
      const points=line.points;
      for (let i = pointIndex(points, a); i < points.length; i++) {
        const [at,value]=points[i];
        if(at>b)break;
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
    if(a<=b)for (const line of lines) {
      const points=line.points;
      for (let i = pointIndex(points, a); i < points.length; i++) {
        const [at,value]=points[i];
        if(at>b)break;
        count(value);
      }
    }
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
  const observationHover=lines.some(preciseReadout);
  const rowTime=(line:Line)=>preciseReadout(line)?pointedAt!:hover!;
  const hoverX = hover === null ? 0 : hover > now ? axis.screenX(Math.min(to, hover + cellMs / 2)) : observationHover?axis.screenX(pointedAt!):bx(hover);
  // On a narrow chart it spans the chart's width under the plot; a marker's time stands over its label and does not rise.
  const narrow = width < 560;
  const descriptionId=useId();
  const {tip, style: tipStyle} = useTip(svg, {width, at: hoverX, narrow, rises: !edgeKey, bottom: height * scale});
  // A marker's time stands over its label, or under it where the bars that stick at the top
  // would cover it, and a long list of them over the label where neither leaves it whole in the
  // window (`edgeOf`): found from where the label is and how tall the tooltip is uncut, never
  // from where and as it was drawn, after every render and as the page scrolls under a pointer
  // that stays.
  const pointedAnnouncement=announced.find(m=>m.key===edgeKey);
  const pointLayout=pointedAnnouncement?announcementLayout(x(pointedAnnouncement.at),left,width-right,narrow):null;
  const edgeRow = edgeKey ? stackRows.get(edgeKey)??labelY(pointLayout?.x??width-right,pointLayout?.end??true) : 0;
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
  const bandWidth = hover === null ? 0 : Math.max(1, axis.screenX(Math.min(to, hover + cellMs)) - axis.screenX(hover));

  // Clock and gesture renders move the retained artwork through its owner.
  // Only new prepared data needs to visit every series and path again.
  const seriesArtwork=useMemo(()=>lines.map((line,i)=>(
    <g key={line.key} className="series-focus" style={seriesFocusStyle(line.key)} data-series={`${line.sourceId} ${line.windowId}`} data-last={paths[i]?.latest} data-observation={paths[i]?.observation} stroke={line.color} strokeDasharray={line.dash||undefined}>
      {paths[i].parts?.map(part=><path key={part.key} d={part.line} className="series"/>)??<path d={paths[i].line} className="series"/>}
    </g>
  )),[lines,paths]);
  const seriesEnds=useMemo(()=>lines.map((line,i)=>paths[i].last?(
    <g key={`${line.key}-end`} className="line-end series-focus" style={seriesFocusStyle(line.key)}>
      <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={7} fill={line.color} opacity={0.18}/>
      <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={3} fill={line.color}/>
    </g>
  ):null),[lines,paths]);
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
        aria-describedby={descriptionId}
        className={onSelect ? 'is-selectable' : undefined}
      >
        <desc id={descriptionId}>{[t('chart.panHint'),...markers.filter(m=>m.at>=desiredFrom&&(m.past||desiredLive)).map(m=>[m.label,stamp(m.at),m.detail].filter(Boolean).join('\n')),...beyond.filter(m=>m.runsOut).map(m=>`${m.label}\n${m.time}`)].join('\n')}</desc>

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
      <PlotLayer width={width} height={height} scale={scale} left={left} right={right} main ticks={ticks.map((tick,index) => (
          <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
            {tickWords[index]}
          </text>
        ))}>
        {plans.map((plan, i) => (
          <path
            key={plan.key}
            className="plan-line"
            style={seriesFocusStyle(plan.lines)}
            stroke={plan.color}
            d={planPaths[i]}
          />
        ))}
        {forecasts.map((forecast, i) => (
          <path
            key={forecast.key}
            className="forecast-line"
            style={seriesFocusStyle(forecast.key)}
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
                <title>{[marker.label, stamp(marker.at), marker.detail].filter(Boolean).join('\n')}</title>
              </g>
            );
          }
          return (
            <g key={marker.key} className={`marker ${marker.strong ? 'is-strong' : ''}`}>
              <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.strong ? undefined : marker.color} />
              {!marker.strong && <circle cx={mx} cy={y(100)} r={3} fill={marker.color} />}
              <title>{`${marker.label}\n${stamp(marker.at)}`}</title>
            </g>
          );
        })}
        {seriesArtwork}
        {/* Announcements are read over the lines, each on its own backing. */}
        {announced.map(marker => {
          const mx = x(marker.at);
          const {end,x:lx,room}=announcementLayout(mx,left,width-right,narrow);
          return (
            <InsideLabel key={marker.key} marker={marker} x={lx} y={stackRows.get(marker.key) ?? labelY(lx,end)} end={end} room={room} fonts={fonts} scale={scale} boxes={boxes} compact={narrow} onEdge={panning?()=>{}:setEdge}/>
          );
        })}
        {hover === null && seriesEnds}
      </PlotLayer>
      <PlotOverlay width={width} height={height}>
        <g>
            {/* Beyond the visible future: at the right edge, with the distance, one under another. */}
            {past.map(label => (
              <EdgeLabel
                key={label.key}
                id={label.key}
                name={narrow||label.runsOut?label.name:label.label}
                detailFrom={label.detailFrom}
                at={label.at}
                runsOut={label.runsOut}
                color={label.color}
                x={width - right-(narrow?6:0)}
                y={stackRows.get(label.key)!}
                room={narrow?labelRoom(width-left-right):width - left - right - 6}
                compact={narrow}
                fonts={fonts} scale={scale} boxes={boxes}
                onEdge={panning ? ignoreEdge : setEdge}
              />
            ))}
            {more.length > 0 && (
              <MarkerLabel
                x={width - right}
                y={stackRows.get(MORE)!}
                end
                fonts={fonts} scale={scale} boxes={boxes}
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
            {rows.map(row => row.value !== null && <circle key={row.line.key} className="series-focus" style={seriesFocusStyle(row.line.key)} cx={preciseReadout(row.line)?hoverX:bx(hover!)} cy={y(row.value)} r={4} fill={row.line.color} />)}
          </g>
        )}
      </PlotOverlay>

      {edgeKey && !panning ? (
        <Tooltip tip={tip} className="is-edge" style={edgePlace.below ? {right: 0, top: `${(edgeRow + 11) * scale - edgePlace.by}px`, maxHeight: edgePlace.cut ?? undefined} : {right: 0, bottom: `calc(100% - ${(edgeRow - 18) * scale}px)`}}>
          {edgeMarkers.map(marker => (
            <Fragment key={marker.key}>
              <div className={`tooltip-marker multiline ${marker.color ? '' : 'is-strong'}`} style={marker.color ? {color: marker.color} : undefined}>
                {marker.label}
              </div>
              <MarkerTime at={marker.at} time={marker.time}/>
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
                    <span className="tooltip-name multiline">{row.line.name}</span>
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
                <strong>{marker.past?stamp(marker.at):clock(marker.at)}</strong>
                <span>{marker.label}</span>
                {marker.detail && <small className="tooltip-detail">{marker.detail}</small>}
              </div>
            ))}
          </Tooltip>
        )
      )}
      {prepared.ready && !lines.length && empty && <div className="chart-empty">{empty}</div>}
    </div>
  );
});
