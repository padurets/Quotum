import type {CreditBalanceState} from './resources.js';
import type {Win} from './quota.js';
import type {KeyPart, Meter} from './meters.js';

export type WindowValue = Win & {observedAt:number; validUntil:number; stale:boolean};
/** Measurements only. Operational status, account names and actions come from the live board. */
export type PeriodValues = {
  id:string;
  provider:string;
  windows:WindowValue[];
  meters:Meter[];
  keys:KeyPart[];
  creditBalance?:CreditBalanceState;
  validFor?:{from:number;to:number};
  currencyUnavailable?:boolean;
};
