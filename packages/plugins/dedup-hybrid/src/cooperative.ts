/**
 * Cooperative-scheduling helpers for the dedup pipeline.
 *
 * `DedupHybridService.dedup()` is declared `async` but, before this module
 * existed, contained no `await` between its first and last statement: a
 * ~6 900-job production search reported `dedup_metrics.elapsedMs = 10604` —
 * 10.6 s of uninterrupted synchronous CPU on the single thread that also
 * answers `GET /health`. `/health` is a pure in-process handler (no I/O), so
 * the only way it can time out is a blocked event loop; the liveness probe
 * (period 20 s, timeout 15 s, failureThreshold 6) duly declared the container
 * dead and Kubernetes SIGKILLed it.
 *
 * The fix is cooperative, not algorithmic: the long passes check a wall-clock
 * budget and hand the loop back when it is spent. Nothing about the clustering
 * result changes — see `MinHashStrategy.clusterAsync`.
 *
 * **Why `setImmediate` and not a microtask.** `await Promise.resolve()` and
 * `process.nextTick()` drain the *microtask* queue and never leave the current
 * loop turn, so no pending socket is ever polled — they would not have fixed
 * anything. `setImmediate` resumes in the **check** phase, i.e. after the poll
 * phase has delivered whatever I/O arrived, so an inbound `/health` request is
 * served before dedup resumes. `setTimeout(fn, 0)` also leaves the turn but is
 * clamped to >= 1 ms per hop, which would be ~100x more expensive here.
 *
 * **Measured cost** (Node 24, this package's hot paths):
 *   - one `setImmediate` round-trip  ~3.1 us
 *   - one `Date.now()`               ~0.10 us
 * At the default 10 ms budget a 10.6 s pass yields ~1 060 times, i.e. ~3.3 ms
 * of added latency — ~0.03 %.
 */

/**
 * Milliseconds of uninterrupted CPU a dedup pass may hold before it must hand
 * the event loop back.
 *
 * 10 ms keeps the worst-case `/health` stall three orders of magnitude under
 * the 15 s probe timeout while costing ~0.03 % in added wall-clock. Raising it
 * buys almost nothing (the yield itself is already only 0.03 % of the pass);
 * lowering it below ~1 ms starts to be dominated by the `setImmediate` hop.
 */
export const DEFAULT_YIELD_BUDGET_MS = 10;

/**
 * Resolve on the next event-loop **check** phase — after pending I/O callbacks
 * have run. See the module doc for why this is not a microtask.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A wall-clock CPU budget for one pass.
 *
 * Prefer this over "yield every N iterations": per-iteration cost in this
 * pipeline swings ~4x with description length (a 200-token posting signs in
 * ~0.16 ms, an 800-token one in ~0.61 ms), and a further ~20x between the
 * per-job loop and the per-candidate-pair loop, so any single fixed N is
 * either far too chatty or far too coarse for half the corpus. Reading the
 * clock costs ~0.10 us — free next to either loop's per-iteration work.
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
}
