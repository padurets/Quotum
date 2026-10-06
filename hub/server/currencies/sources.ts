import type {ExchangeRates} from '../domain/currency.js';
import {ecbReader} from './ecb.js';
export type RatesReader=(signal:AbortSignal)=>Promise<ExchangeRates>;
/** Code-owned integrations. Personal fixed rates are data, never arbitrary HTTP URLs. */
export const rateSources:ReadonlyMap<string,RatesReader>=new Map([['ecb',ecbReader()]]);
export const DEFAULT_RATE_SOURCE='ecb';
