import { JobPostDto, LocationDto, Site } from "@ever-jobs/models";
import { DedupHybridService } from "../src/dedup-hybrid.service";
import { MinHashStrategy } from "../src/strategies/minhash-strategy";
import { PreparedJob } from "../src/types";

/**
 * Event-loop liveness gate.
 *
 * Production symptom this guards: `dedup()` is `async` but used to hold the
 * thread for the whole pass (a ~6 900-job search reported
 * `dedup_metrics.elapsedMs = 10604`). `GET /health` is a pure in-process
 * handler, so a blocked loop is the only thing that can make it time out —
 * and the liveness probe (period 20 s, timeout 15 s, failureThreshold 6) then
 * SIGKILLs the container.
 *
 * The probe simulated here is a self-rescheduling `setImmediate` chain, which
 * is exactly what an inbound HTTP request needs in order to be served: the
 * poll phase must be reached. Microtasks (`Promise.resolve()`,
 * `process.nextTick`) would *not* be a valid stand-in — they run without ever
 * leaving the current turn.
 *
 * Without the cooperative yields the whole `dedup()` body runs synchronously
 * inside the caller's turn, so the chain ticks **zero** times and the worst gap
 * is the full pass — measured against the pre-fix build at this batch size:
 * `ticks=0 worstGapMs=1331`. Both assertions below fail. With the fix:
 * `ticks=131 worstGapMs=18`, and the pass wall-clock is unchanged
 * (1331 ms -> 1335 ms) with a byte-identical `assignments` array.
 */

const MAX_STALL_MS = Number(process.env.DEDUP_LOOP_MAX_STALL_MS ?? 250);

/** Long enough to clear `minTextLength` (80) with room to spare. */
const DESC_TOKENS = 600;

const VOCAB = (
  "we are hiring a senior software engineer to join our backend platform team you will design build " +
  "and operate distributed systems running on kubernetes the ideal candidate has strong experience " +
  "with typescript nestjs and postgresql we offer competitive salary equity and a remote friendly " +
  "work environment responsibilities include mentoring peers reviewing pull requests owning services " +
  "in production participating in on call rotation and collaborating with product managers designers " +
  "and data scientists across the organisation benefits include health insurance dental vision paid " +
  "time off parental leave learning budget and a home office stipend apply today"
).split(" ");

/**
 * Deterministic PRNG (mulberry32) so every posting gets a *distinct*,
 * prose-shaped description. Distinctness matters: identical texts collapse to
 * one MinHash slot (Spec 722 / FR-5), which would make the batch cheap and the
 * test vacuous.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function description(seed: number): string {
  const rnd = mulberry32(seed + 1);
  const words: string[] = new Array(DESC_TOKENS);
  for (let i = 0; i < DESC_TOKENS; i++)
    words[i] = VOCAB[Math.floor(rnd() * VOCAB.length)];
  return `${words.join(" ")} req-${seed}`;
}

/** Size of each near-duplicate group: one head + `CLUSTER_SPAN - 1` members. */
const CLUSTER_SPAN = 5;

/**
 * A near-duplicate of `head`'s description: the same prose with ~4 % of its
 * tokens swapped, which lands well inside the MinHash similarity threshold.
 *
 * 🛑 Load-bearing for tests 2 and 3. An earlier version of this fixture drew
 * every token at random, so NO two postings were near-duplicates, `cluster()`
 * returned `{clusters: []}`, and the equality/determinism assertions compared
 * an empty partition to itself — they passed against a `clusterAsync` that
 * unconditionally returned `{clusters: []}`. With real clusters those tests
 * exercise the LSH pair loop and the component-emit path, which are exactly
 * the checkpoints the cooperative pass adds. `expect(...clusters.length)` in
 * test 2 is the guard that stops this silently regressing again.
 */
function nearDuplicate(headSeed: number, variant: number): string {
  const base = description(headSeed).split(" ");
  const rnd = mulberry32(headSeed * 1000 + variant);
  const swaps = Math.max(1, Math.floor(base.length * 0.04));
  for (let s = 0; s < swaps; s++) {
    base[Math.floor(rnd() * base.length)] =
      VOCAB[Math.floor(rnd() * VOCAB.length)];
  }
  return base.join(" ");
}

function buildBatch(size: number): JobPostDto[] {
  const out: JobPostDto[] = [];
  for (let i = 0; i < size; i++) {
    const headSeed = i - (i % CLUSTER_SPAN);
    const variant = i % CLUSTER_SPAN;
    out.push(
      new JobPostDto({
        id: String(i),
        title: `Engineer ${headSeed}`,
        companyName: `Company ${headSeed}`,
        jobUrl: `https://e.test/${i}`,
        site: i % 2 === 0 ? Site.GREENHOUSE : Site.LINKEDIN,
        // Heads keep a wholly distinct description so the batch stays
        // signature-dominated (that is what makes the pass slow); members are
        // near-duplicates of their head so real clusters actually form.
        description:
          variant === 0 ? description(i) : nearDuplicate(headSeed, variant),
        location: new LocationDto({
          city: "Remote",
          state: "",
          country: "USA",
        }),
      }),
    );
  }
  return out;
}

function preparedFrom(jobs: ReadonlyArray<JobPostDto>): PreparedJob[] {
  return jobs.map((raw, index) => ({
    index,
    canonicalKey: `key-${index}`,
    canonicalJobId: `id-${index}`,
    raw,
  }));
}

/**
 * Stand-in for the liveness probe: a `setImmediate` chain that records the
 * worst gap between consecutive visits to the check phase. Returns a stopper
 * that yields the observations.
 */
function startEventLoopProbe(): () => { ticks: number; worstGapMs: number } {
  let ticks = 0;
  let worstGapMs = 0;
  let lastRunAt = Date.now();
  let running = true;

  const schedule = (): void => {
    setImmediate(() => {
      const now = Date.now();
      const gap = now - lastRunAt;
      if (gap > worstGapMs) worstGapMs = gap;
      lastRunAt = now;
      ticks++;
      if (running) schedule();
    });
  };
  schedule();

  return () => {
    running = false;
    // Fold in the still-open gap. A loop that was starved for the whole pass
    // records *no* ticks, and without this it would report a worst gap of 0 —
    // the total-starvation case has to be the worst reading, not the best.
    const trailing = Date.now() - lastRunAt;
    if (trailing > worstGapMs) worstGapMs = trailing;
    return { ticks, worstGapMs };
  };
}

describe("dedup — event-loop liveness", () => {
  it(`answers the event loop within ${MAX_STALL_MS} ms while deduping a large batch`, async () => {
    const batch = buildBatch(2500);
    const service = new DedupHybridService();

    const stopProbe = startEventLoopProbe();
    const started = Date.now();
    const out = await service.dedup(batch);
    const elapsed = Date.now() - started;
    const { ticks, worstGapMs } = stopProbe();

    // Guard: the pass has to be long enough for the assertion to mean
    // something. If this trips, the batch got cheap — grow it, don't relax it.
    expect(elapsed).toBeGreaterThan(300);
    expect(out.metrics.inputCount).toBe(batch.length);

    // The loop actually got serviced *during* the pass. Unyielded, the whole
    // `dedup()` body runs inside the caller's turn and this is 0.
    expect(ticks).toBeGreaterThan(10);

    // No single slice may hold the thread long enough to threaten the probe.
    // Unyielded this equals the whole pass (~1 400 ms locally at this batch
    // size; 10 604 ms on the production batch that prompted the fix).
    expect(worstGapMs).toBeLessThan(MAX_STALL_MS);
  }, 120_000);

  it("clusterAsync returns exactly the partition the synchronous cluster() returns", async () => {
    // The cooperative path must be a scheduling change only. Same strategy
    // instance, same input, both entry points — byte-identical partitions.
    const input = preparedFrom(buildBatch(400));
    const strategy = new MinHashStrategy();

    const sync = strategy.cluster(input);
    const cooperative = await strategy.clusterAsync(input);

    // 🛑 ANTI-VACUITY GUARD — assert BEFORE the equality, or this test is
    // worthless. With a fixture of wholly-distinct descriptions both sides are
    // `{clusters: []}` and the comparison passes against a `clusterAsync` that
    // returns a hard-coded empty partition (verified by mutation). Real
    // clusters are what force the LSH pair loop and the component-emit path —
    // the two checkpoints nothing else in the suite reaches.
    expect(sync.clusters.length).toBeGreaterThan(10);
    expect(sync.clusters.some((c) => c.length >= 2)).toBe(true);

    expect(JSON.stringify(cooperative)).toEqual(JSON.stringify(sync));
  }, 60_000);

  it("serialises concurrent passes so only one working set is ever resident", async () => {
    // The yields removed the accidental mutual exclusion a fully synchronous
    // pass used to provide, so dedup() gates itself. Without the gate K
    // concurrent passes hold K working sets (slots, buckets, signatures) live
    // at once - measured +67% peak heap at K=8 - which is the wrong trade for a
    // service that has aborted with "Reached heap limit".
    //
    // Counting callers of dedup() would prove nothing: they all enter, then
    // queue. What matters is concurrent occupancy of the CLUSTERING pass, which
    // is what actually holds the memory, so that is what this counts.
    const realClusterAsync = MinHashStrategy.prototype.clusterAsync;
    let inside = 0;
    let maxInside = 0;
    const spy = jest
      .spyOn(MinHashStrategy.prototype, "clusterAsync")
      .mockImplementation(async function (
        this: MinHashStrategy,
        input: ReadonlyArray<PreparedJob>,
      ) {
        inside++;
        if (inside > maxInside) maxInside = inside;
        try {
          return await realClusterAsync.call(this, input);
        } finally {
          inside--;
        }
      });

    try {
      const service = new DedupHybridService();
      const batch = buildBatch(200);
      await Promise.all([
        service.dedup(batch),
        service.dedup(batch),
        service.dedup(batch),
        service.dedup(batch),
      ]);

      // 4 without the gate, 1 with it.
      expect(maxInside).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it("a failing pass does not wedge the queue for later callers", async () => {
    // The gate is a promise chain; if a rejected link were awaited unguarded,
    // one bad batch would deadlock every later search for the pod's lifetime.
    const service = new DedupHybridService();

    await expect(
      service.dedup(undefined as unknown as ReadonlyArray<JobPostDto>),
    ).rejects.toBeDefined();

    const after = await service.dedup(buildBatch(20));
    expect(after.metrics.inputCount).toBe(20);
  }, 60_000);

  it("a cooperative pass is still deterministic when interleaved with another", async () => {
    // Two dedup() calls in flight over the same singleton service: their
    // yields interleave, so this fails if the pipeline kept any per-call state
    // on the instance.
    const service = new DedupHybridService();
    const batch = buildBatch(300);

    const solo = await service.dedup(batch);
    const [a, b] = await Promise.all([
      service.dedup(batch),
      service.dedup(batch),
    ]);

    // Anti-vacuity: the batch must actually merge, or "deterministic" is
    // trivially true for three empty results.
    expect(solo.metrics.outputCount).toBeLessThan(batch.length);

    expect(a.assignments).toEqual(solo.assignments);
    expect(b.assignments).toEqual(solo.assignments);
    expect(a.metrics.outputCount).toBe(solo.metrics.outputCount);
    expect(b.metrics.outputCount).toBe(solo.metrics.outputCount);
  }, 120_000);
});
