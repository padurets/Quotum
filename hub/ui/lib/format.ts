import {formatLocale, t} from '../i18n';

const numbers = new Map<string, Intl.NumberFormat>();

export function num(value: number, digits: 0 | 1 | 2 = 0) {
  const locale = formatLocale();
  const key = `${locale}/${digits}`;
  let formatter = numbers.get(key);
  if (!formatter) numbers.set(key, (formatter = new Intl.NumberFormat(locale, {maximumFractionDigits: digits})));
  return formatter.format(value);
}

/**
 * A rate, percent an hour, the same wherever it is told: to a hundredth under 1, where a
 * tenth would be off by as much as half and the hours foreseen from it would not add up, to
 * a tenth above; one above 0 too small to read so reads "≈ 0".
 */
export const rateText = (value: number) => (value > 0 && value < 0.05 ? '≈ 0' : num(value, value < 1 ? 2 : 1));

/** A share, whole percent, the same wherever it is told: one above 0 that would read 0 reads "< 1". */
export const shareText = (value: number) => (value > 0 && value < 0.5 ? '< 1' : num(value));

export function duration(ms: number, short = false) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return t('time.underMinute');
  if (minutes < 60) return t('time.minutes', {n: minutes});
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (hours < 24) return short || !(minutes % 60) ? t('time.hours', {n: hours}) : t('time.hoursMinutes', {h: hours, m: minutes % 60});
  return short || !(hours % 24) ? t('time.days', {n: days}) : t('time.daysHours', {d: days, h: hours % 24});
}

/*
 * Each of these says, for what a label shows at `now`, the first moment after it that the
 * label reads otherwise (lib/clock.ts wakes the label then); null when it never does.
 * They follow the functions above: whole units, rounded as they round them.
 */

/** The first count of minutes `duration` reads otherwise after `minutes`, counting up. */
function durationUp(minutes: number, short: boolean) {
  if (minutes < 60) return minutes + 1;
  if (minutes < 1440) return short ? 60 * (Math.floor(minutes / 60) + 1) : minutes + 1;
  return short ? 1440 * (Math.floor(minutes / 1440) + 1) : 60 * (Math.floor(minutes / 60) + 1);
}

/** The largest count of minutes below `minutes` that `duration` reads otherwise, counting down; null below a minute. */
function durationDown(minutes: number, short: boolean) {
  if (minutes < 1) return null;
  if (minutes < 60) return minutes - 1;
  if (minutes < 1440) return short ? 60 * Math.floor(minutes / 60) - 1 : minutes - 1;
  return short ? 1440 * Math.floor(minutes / 1440) - 1 : 60 * Math.floor(minutes / 60) - 1;
}

/** The nearest of the moments something reads otherwise; null when none comes. */
export const earliest = (...moments: (number | null)[]) =>
  moments.reduce<number | null>((first, at) => (at !== null && (first === null || at < first) ? at : first), null);

/** `duration(now - from)`: how long something has run. */
export function durationChangesAt(from: number, now: number, short = false): number {
  const minutes = Math.max(0, Math.round((now - from) / 60_000));
  return from + (durationUp(minutes, short) - 0.5) * 60_000;
}

/** `duration(to - now)`: how long until something. */
export function durationUntilChangesAt(to: number, now: number, short = false): number | null {
  const next = durationDown(Math.max(0, Math.round((to - now) / 60_000)), short);
  return next === null ? null : to - (next + 0.5) * 60_000 + 1;
}

/** How soon is told in hours rather than days: two days are hours still, so a reset in 47 hours does not read as one day away (`countdown`). */
export const IN_HOURS_UNDER = 48 * 3_600_000;

/** `countdown(target - now)`. One minute, and past it, reads so to the end. */
export function countdownChangesAt(target: number, now: number): number | null {
  const minutes = Math.floor((target - now) / 60_000);
  if (minutes <= 1) return null;
  const unit = minutes < 60 ? 60_000 : minutes * 60_000 < IN_HOURS_UNDER ? 3_600_000 : 86_400_000;
  return target - Math.floor((target - now) / unit) * unit + 1;
}

/** `ago(time, now)`. */
export function agoChangesAt(time: number | null, now: number): number | null {
  if (!time) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const next =
    seconds < 45 ? 45 : seconds < 3600 ? Math.min(3600, 60 * Math.round(seconds / 60) + 30) : seconds < 86_400 ? 3600 * (Math.floor(seconds / 3600) + 1) : 86_400 * (Math.floor(seconds / 86_400) + 1);
  return time + (next - 0.5) * 1000;
}

/**
 * How long agents worked: minutes within the hour (any work short of a whole minute reads
 * "< 1", so the parts of a minute's bar do not each read as the whole), hours to a tenth up
 * to ten, whole hours after that. Never days: "150h" of work is not "6d 6h".
 */
export function workHours(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('time.minutes', {n: ms > 0 && ms < 60_000 ? '< 1' : minutes});
  const hours = ms / 3_600_000;
  return t('time.hours', {n: hours < 10 ? num(hours, 1) : num(Math.round(hours))});
}

/** Hours of work foreseen: about so many ("~45m"), and under a minute as it is ("< 1m"), not about that. */
export const workAbout = (ms: number) => (ms > 0 && ms < 60_000 ? workHours(ms) : t('work.about', {time: workHours(ms)}));

/**
 * How long until something, for a mark or a heading with little room: minutes within the
 * hour, hours for two days (`IN_HOURS_UNDER`), days after that, always rounded down and
 * never under a minute.
 */
export function countdown(ms: number) {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return t('time.minutes', {n: minutes});
  const hours = Math.floor(minutes / 60);
  if (hours * 3_600_000 < IN_HOURS_UNDER) return t('time.hours', {n: hours});
  return t('time.days', {n: Math.floor(hours / 24)});
}

export function ago(time: number | null, now: number) {
  if (!time) return t('time.noData');
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return t('time.justNow');
  if (seconds < 3600) return t('time.minutesAgo', {n: Math.round(seconds / 60)});
  if (seconds < 86_400) return t('time.hoursAgo', {n: Math.floor(seconds / 3600)});
  return t('time.daysAgo', {n: Math.floor(seconds / 86_400)});
}

const SHAPES = {
  clock: {hour: '2-digit', minute: '2-digit'},
  shortDay: {day: 'numeric', month: 'short'},
  day: {day: 'numeric', month: 'long'},
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const dates = new Map<string, Intl.DateTimeFormat>();

/**
 * A time in one of its shapes, as `toLocaleDateString` gives it, with a formatter kept for
 * each language and shape: making one costs as much as twenty uses, and an idle board
 * says when a great many times.
 */
function dated(shape: keyof typeof SHAPES, time: number) {
  const locale = formatLocale();
  const key = `${locale}/${shape}`;
  let formatter = dates.get(key);
  if (!formatter) dates.set(key, (formatter = new Intl.DateTimeFormat(locale, SHAPES[shape])));
  return formatter.format(time);
}

export const clock = (time: number) => dated('clock', time);

/** "22 Sept": the scale along a chart's axis, which has little room; saying when is `stamp`. */
export const shortDay = (time: number) => dated('shortDay', time);

/** "26 September": the day, its month in a word. */
export const day = (time: number) => dated('day', time);

/**
 * "26 September 14:00": the one way the board says when, with no dots or commas between
 * its parts. Where how soon or how long ago matters more and room is short, that is said
 * instead (`countdown`, `duration`, `ago`), with this beside it or in its tooltip.
 */
export const stamp = (time: number) => `${day(time)} ${clock(time)}`;
