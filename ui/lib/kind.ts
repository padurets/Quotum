import type {Kind} from './types';

/** Window kind by length, with a label fallback for sources that omit the length. */
export function kindOf(minutes: number | null, label: string): Kind {
  if (minutes === 300 || /5[- ]?h|5 час/i.test(label)) return 'session';
  if (minutes === 10080 || /week|недел/i.test(label)) return 'weekly';
  return 'other';
}
