/** Resource observations are independent of successful transport and of each other. */
export type ResourceStatus = 'observed' | 'missing' | 'unsupported' | 'invalid';
export type ResourceStatuses = {windows: ResourceStatus; resets: ResourceStatus};
export type ResourceObservation = {status: ResourceStatus; at: number; staleAfterMs: number;valueAt?:number;valueStaleAfterMs?:number};
export type CreditBalance = {
  id: 'balance:credits';
  unit: 'credits:codex';
  status: 'finite' | 'unlimited' | 'missing' | 'unsupported' | 'invalid';
  amount?: string;
  hasCredits?: boolean;
};
export type CreditBalanceState = Omit<CreditBalance, 'amount'> & {at: number; staleAfterMs: number};
export type Delivery = {at: number; staleAfterMs: number};
export type BudgetAccess = {enabled: boolean; since: number | null; anchor: number | null; revision: string};

/** Provider capability never grants a shared board access to a new financial resource. */
export function budgetAccess(provider: string, personal: boolean, grant?: {budget_since: number | null; budget_anchor_at: number | null; budget_revision: string}): BudgetAccess {
  if (personal || provider === 'openrouter' || provider === 'deepseek') return {enabled:true,since:0,anchor:0,revision:grant?.budget_revision ?? 'personal'};
  return {enabled:provider === 'codex' && grant?.budget_since != null,since:grant?.budget_since ?? null,anchor:grant?.budget_anchor_at ?? null,revision:grant?.budget_revision ?? ''};
}
