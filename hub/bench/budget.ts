/**
 * What an idle dashboard may cost, per second of watching it (index.ts, `--ci`).
 *
 * Before the page was driven by events (commit 6f04eed), the bench job of CI run
 * 36269781391 measured it three times at 1.45, 1.54 and 1.51 ms of script a second
 * (Chrome's ScriptDuration less the probe's own time): 1.50 on average, with runs apart by
 * less than a tenth. An idle page now spends at most a fifth of that.
 */
export const IDLE_SCRIPT_MS_PER_SECOND = 0.3;
