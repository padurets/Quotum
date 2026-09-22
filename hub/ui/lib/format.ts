import {formatLocale, t} from '../i18n';

const numbers = new Map<string, Intl.NumberFormat>();

export function num(value: number, digits: 0 | 1 = 0) {
  const locale = formatLocale();
  const key = `${locale}/${digits}`;
  let formatter = numbers.get(key);
  if (!formatter) numbers.set(key, (formatter = new Intl.NumberFormat(locale, {maximumFractionDigits: digits})));
  return formatter.format(value);
}

export function duration(ms: number, short = false) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return t('time.underMinute');
  if (minutes < 60) return t('time.minutes', {n: minutes});
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (hours < 24) return short || !(minutes % 60) ? t('time.hours', {n: hours}) : t('time.hoursMinutes', {h: hours, m: minutes % 60});
  return short || !(hours % 24) ? t('time.days', {n: days}) : t('time.daysHours', {d: days, h: hours % 24});
}

export function ago(time: number | null, now: number) {
  if (!time) return t('time.noData');
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return t('time.justNow');
  if (seconds < 3600) return t('time.minutesAgo', {n: Math.round(seconds / 60)});
  if (seconds < 86_400) return t('time.hoursAgo', {n: Math.floor(seconds / 3600)});
  return t('time.daysAgo', {n: Math.floor(seconds / 86_400)});
}

export const clock = (time: number) => new Date(time).toLocaleTimeString(formatLocale(), {hour: '2-digit', minute: '2-digit'});

/** "22 September" */
export const day = (time: number) => new Date(time).toLocaleDateString(formatLocale(), {day: 'numeric', month: 'long'});

/** "22 Sept" */
export const shortDay = (time: number) => new Date(time).toLocaleDateString(formatLocale(), {day: 'numeric', month: 'short'});

/** "today 21:00", "tomorrow 10:30", otherwise "25 Sept 10:30" — for tight spaces. */
export function soon(time: number, now: number) {
  const dayOf = (t: number) => new Date(t).toDateString();
  if (dayOf(time) === dayOf(now)) return t('time.today', {time: clock(time)});
  if (dayOf(time) === dayOf(now + 86_400_000)) return t('time.tomorrow', {time: clock(time)});
  return `${shortDay(time)} ${clock(time)}`;
}

export const stamp = (time: number) =>
  new Date(time).toLocaleString(formatLocale(), {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});

export const fullStamp = (time: number) => new Date(time).toLocaleString(formatLocale());
