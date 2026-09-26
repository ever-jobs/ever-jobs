/**
 * Process-wide pacing for the InHire API host (Spec 1692).
 *
 * Every tenant is served from the one origin `api.inhire.app`, so the minimum
 * gap between request starts is kept per process, not per scrape: two tenants
 * scraped at once share the same queue of slots. The shared HTTP client's own
 * rate delay reads its last-request time without a lock and races when calls
 * overlap, so the gap is enforced here with a synchronous slot reservation.
 */

/**
 * Clock and sleep used for pacing. Replaceable so tests can drive time
 * deterministically; production code never reassigns them.
 */
export const inhireRuntime: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

let nextSlotAt = 0;

/**
 * Reserve the next request slot and return how long to wait for it. The
 * reservation is synchronous, so two workers (or two scrapes) can never both
 * be told "go now": the second is queued one interval later.
 */
export function reserveInhireSlot(now: number, intervalMs: number): number {
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + Math.max(0, intervalMs);
  return at - now;
}

/** Forget the pacer's memory (tests, and a process-level reset). */
export function resetInhireState(): void {
  nextSlotAt = 0;
}
