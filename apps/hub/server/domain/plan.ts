/** A weekly spending plan: seven whole, non-negative percents, one per day of the window, adding up to 100. */
export function isValidPlan(plan: unknown): plan is number[] {
  return (
    Array.isArray(plan) &&
    plan.length === 7 &&
    plan.every(share => Number.isInteger(share) && share >= 0 && share <= 100) &&
    plan.reduce((sum: number, share: number) => sum + share, 0) === 100
  );
}
