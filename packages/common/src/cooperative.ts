/**
 * Cooperative-scheduling helpers for long synchronous passes on the API thread.
 *
 * Node runs every request handler, including `GET /health`, on one thread. A pass that holds it
 * for seconds (dedup over a keyword-less fan-out, classifying ~30,000 jobs) makes the liveness
 * probe time out and gets the container killed; `dedup-hybrid/src/cooperative.ts` records the
 * production incident (a 10.6 s synchronous dedup). The cure is cooperative, not algorithmic: a
 * long pass checks a wall-clock budget and hands the loop back when it is spent.
 *
 * These are the same helpers `dedup-hybrid` introduced for that fix, hosted here so core code
 * (the jobs aggregator) and any plugin can use them without importing a peer plugin. The
 * `dedup-hybrid` copy is left in place and can switch to these later.
 *
 * **Why `setImmediate` and not a microtask.** `await Promise.resolve()` and `process.nextTick()`
 * drain the microtask queue without leaving the current loop turn, so no pending socket is ever
 * polled. `setImmediate` resumes in the check phase, after the poll phase has delivered pending
 * I/O, so an inbound `/health` request is served before the pass resumes. `setTimeout(fn, 0)`
 * also leaves the turn but is clamped to >= 1 ms per hop.
 */

/**
 * Milliseconds of uninterrupted CPU a pass may hold before it must hand the event loop back.
 * 10 ms keeps the worst `/health` stall three orders of magnitude under a 15 s probe timeout; one
 * `setImmediate` round-trip costs ~3 µs, so the yields add well under 0.1 % to the pass.
 */
export const DEFAULT_YIELD_BUDGET_MS = 10;

/** Resolve on the next event-loop check phase, after pending I/O callbacks have run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A wall-clock CPU budget for one pass. Prefer it over "yield every N items": per-item cost
 * varies by orders of magnitude with input size and machine load, so any fixed N is either far too
 * chatty or far too coarse. Reading the clock costs ~0.1 µs.
 */
export class YieldBudget {
  private deadline: number;

  constructor(private readonly budgetMs: number = DEFAULT_YIELD_BUDGET_MS) {
    this.deadline = Date.now() + budgetMs;
  }

  /** `true` once the current slice has held the loop for `budgetMs`. */
  get expired(): boolean {
    return Date.now() >= this.deadline;
  }

  /** Open a fresh slice. Call immediately after yielding. */
  renew(): void {
    this.deadline = Date.now() + this.budgetMs;
  }

  /** Yield to the event loop and open a fresh slice, but only if the current one is spent. */
  async yieldIfExpired(): Promise<boolean> {
    if (!this.expired) return false;
    await yieldToEventLoop();
    this.renew();
    return true;
  }
}
