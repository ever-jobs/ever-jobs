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

function buildBatch(size: number): JobPostDto[] {
  const out: JobPostDto[] = [];
  for (let i = 0; i < size; i++) {
    out.push(
      new JobPostDto({
        id: String(i),
        title: `Engineer ${i}`,
        companyName: `Company ${i}`,
        jobUrl: `https://e.test/${i}`,
        site: i % 2 === 0 ? Site.GREENHOUSE : Site.LINKEDIN,
        description: description(i),
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

    expect(JSON.stringify(cooperative)).toEqual(JSON.stringify(sync));
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

    expect(a.assignments).toEqual(solo.assignments);
    expect(b.assignments).toEqual(solo.assignments);
    expect(a.metrics.outputCount).toBe(solo.metrics.outputCount);
    expect(b.metrics.outputCount).toBe(solo.metrics.outputCount);
  }, 120_000);
});
