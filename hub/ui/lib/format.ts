const formatter = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0});
const formatter1 = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1});

export const num = (value: number, digits: 0 | 1 = 0) => (digits ? formatter1 : formatter).format(value);

export function duration(ms: number, short = false) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (hours < 24) return short || !(minutes % 60) ? `${hours} ч` : `${hours} ч ${minutes % 60} мин`;
  return short || !(hours % 24) ? `${days} д` : `${days} д ${hours % 24} ч`;
}

export function ago(time: number | null, now: number) {
  if (!time) return 'нет данных';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return 'только что';
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин назад`;
  return `${Math.floor(seconds / 3600)} ч назад`;
}

export function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const clock = (time: number) => new Date(time).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});

export const day = (time: number) => new Date(time).toLocaleDateString('ru-RU', {day: 'numeric', month: 'long'});

/** "сегодня 21:00", "завтра 10:30", otherwise "25 сент. 10:30" — for tight spaces. */
export function soon(time: number, now: number) {
  const dayOf = (t: number) => new Date(t).toDateString();
  if (dayOf(time) === dayOf(now)) return `сегодня ${clock(time)}`;
  if (dayOf(time) === dayOf(now + 86_400_000)) return `завтра ${clock(time)}`;
  return `${new Date(time).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'})} ${clock(time)}`;
}

export const stamp = (time: number) =>
  new Date(time).toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
