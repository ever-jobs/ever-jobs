import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CanonicalJob,
  DEDUP_ENGINE_TOKEN,
  DedupMetrics,
  IDedupEngine,
  IJobObservationStore,
  IJobStore,
  JOB_OBSERVATION_STORE_TOKEN,
  JOB_STORE_TOKEN,
  JobPostDto,
  LocationDto,
  ScraperInputDto,
} from '@ever-jobs/models';
import { dedupKeyForJob } from '@ever-jobs/common';
import { JobsService } from './jobs.service';

/**
 * Per-call options for {@link JobsAggregator.aggregate} /
 * {@link JobsAggregator.aggregateRaw}.
 */
export interface AggregateOptions {
  /**
   * Run the bound `IDedupEngine` over the fan-out result. Default: `true`
   * when an engine is bound (Spec 003 / Phase 5 migration plan).
   *
   * Setting `dedup=false` returns the raw fan-out unchanged — the only
   * supported way for legacy clients to opt out of dedup.
   */
  readonly dedup?: boolean;

  /**
   * Persist post-dedup canonical records (and their source observations)
   * via the bound `IJobStore` / `IJobObservationStore` (Spec 004 / T11).
   * Default: `true`.
   *
   * Persistence is best-effort: a backend-down blip MUST NOT turn a
   * successful search into a 500. Failures surface via
   * {@link AggregateResult.persistError} so callers / dashboards / metrics
   * can observe them without coupling to the response status code.
   *
   * Setting `persist=false` short-circuits the side-effect entirely —
   * useful for ephemeral / preview searches and for tests that don't
   * care about the store. Per Q-018 (run #25), `persist=true` with no
   * store bound is also a silent no-op (matches the dedup precedent:
   * "when nothing is bound the aggregator is a pass-through").
   */
  readonly persist?: boolean;
}

/**
 * Envelope returned by the aggregator. The shape is intentionally additive:
 * `jobs` is always populated (raw or deduped) so existing controller code
 * keeps working without conditional handling.
 */
export interface AggregateResult {
  /** Final job list — deduped when `dedup=true` and an engine is bound. */
  readonly jobs: JobPostDto[];
  /** Pre-dedup count. Equals `rawJobs.length`. */
  readonly rawCount: number;
  /** Post-dedup count. Equals `jobs.length`. */
  readonly outputCount: number;
  /** `true` iff the dedup engine actually ran. */
  readonly deduped: boolean;
  /** Populated only when {@link deduped} is `true`. */
  readonly dedupMetrics?: DedupMetrics;
  /**
   * `true` iff a backend was bound, `persist` was not opted out, and
   * the upsertMany call succeeded. Spec 004 / T11.
   */
  readonly persisted?: boolean;
  /**
   * Insert / update accounting from `IJobStore.upsertMany`. Populated
   * only when {@link persisted} is `true` and the active backend
   * advertises real counts (in-memory backends always return
   * `{ inserted, updated }`; Postgres / SQLite return real `ON CONFLICT`
   * counts).
   */
  readonly persistCounts?: { readonly inserted: number; readonly updated: number };
  /**
   * Populated only when persistence was attempted AND failed (i.e.
   * `persist=true`, a store WAS bound, and upsertMany / putAll
   * rejected). Carries the wire-stable error code (`ERR_STORE_BACKEND_DOWN`
   * / `ERR_STORE_INVALID_CURSOR` / generic `ERR_STORE_PERSIST_FAILED`)
   * plus the message. Operators read this from logs / metrics; callers
   * can surface it as a response header without blocking the response
   * body.
   */
  readonly persistError?: { readonly code: string; readonly message: string };
}

/**
 * Generic fallback error code surfaced via {@link AggregateResult.persistError}
 * when the underlying backend rejection lacks a structured `.code`.
 * Distinct from the well-known Spec 004 §7.3 codes
 * (`ERR_STORE_NOT_FOUND` / `ERR_STORE_BACKEND_DOWN` / `ERR_STORE_INVALID_CURSOR`)
 * so log queries can grep "ERR_STORE_PERSIST_FAILED" specifically when
 * triaging aggregator-side persistence drops.
 */
export const ERR_STORE_PERSIST_FAILED = 'ERR_STORE_PERSIST_FAILED';

/**
 * Thin orchestration layer between {@link JobsService} (fan-out), the
 * dedup engine (Spec 003 / Phase 5), and the persistent store
 * (Spec 004 / Phase 5).
 *
 * The aggregator is intentionally minimal — it does **not** own caching,
 * salary post-processing, or sorting (those still live in `JobsService`).
 * It only:
 *
 *   1. delegates fan-out to `JobsService.searchJobs`;
 *   2. invokes the bound `IDedupEngine` (if present and the caller didn't
 *      opt out) to collapse near-duplicates across sources;
 *   3. picks the **first** raw `JobPostDto` per canonical cluster as the
 *      "winning" representative — this preserves the input sort order
 *      established by `JobsService` (site asc, then datePosted desc);
 *   4. (Spec 004 / T11) persists the post-dedup `CanonicalJob[]` plus
 *      their `SourceObservation[]` via the bound `IJobStore` /
 *      `IJobObservationStore`, **best-effort**: any backend failure is
 *      logged and surfaced via {@link AggregateResult.persistError} but
 *      MUST NOT fail the request. Persistence runs only when an engine
 *      is bound (i.e. dedup actually produced a `canonical[]` list);
 *      pure pass-through paths skip persistence by construction.
 *
 * The engine and store bindings are **optional** so that environments
 * that haven't imported `DedupHybridModule` / `StoreModule.forActive` (or
 * that swap them for no-ops via DI) keep working. When no engine is
 * bound the aggregator is a pass-through. When no store is bound
 * persistence is silently a no-op (Q-018 / run #25).
 */
@Injectable()
export class JobsAggregator {
  private readonly logger = new Logger(JobsAggregator.name);

  constructor(
    private readonly jobsService: JobsService,
    @Optional() @Inject(DEDUP_ENGINE_TOKEN) private readonly dedupEngine?: IDedupEngine,
    @Optional() @Inject(JOB_STORE_TOKEN) private readonly jobStore?: IJobStore,
    @Optional() @Inject(JOB_OBSERVATION_STORE_TOKEN)
    private readonly observationStore?: IJobObservationStore,
  ) {}

  /**
   * Fan-out then optionally dedup.
   *
   * Use this when you have an input DTO and want the full pipeline.
   */
  async aggregate(
    input: ScraperInputDto,
    options: AggregateOptions = {},
  ): Promise<AggregateResult> {
    const rawJobs = await this.jobsService.searchJobs(input);
    return this.aggregateRaw(rawJobs, options);
  }

  /**
   * Apply (or skip) dedup on an already-fanned-out list.
   *
   * The controller uses this overload to keep the `cache → dedup` order:
   *   1. cache lookup (raw) — fast path
   *   2. fan-out via `JobsService` on miss
   *   3. cache write (raw) — keeps cache invalidation independent of
   *      dedup-engine version changes
   *   4. dedup pass per-request (this method)
   *   5. (T11) persist post-dedup canonical + observations
   */
  async aggregateRaw(
    rawJobs: JobPostDto[],
    options: AggregateOptions = {},
  ): Promise<AggregateResult> {
    const result = await this.aggregateRawUnkeyed(rawJobs, options);
    // Spec 1721 / contract C9 — every returned job carries its stable
    // cross-source key, whichever path produced the list.
    await stampDedupKeys(result.jobs);
    return result;
  }

  private async aggregateRawUnkeyed(
    rawJobs: JobPostDto[],
    options: AggregateOptions,
  ): Promise<AggregateResult> {
    const rawCount = rawJobs.length;
    const wantDedup = options.dedup ?? true;

    if (!wantDedup) {
      return {
        jobs: rawJobs,
        rawCount,
        outputCount: rawCount,
        deduped: false,
      };
    }
    if (!this.dedupEngine) {
      this.logger.debug(
        'No IDedupEngine bound under DEDUP_ENGINE_TOKEN — returning raw list',
      );
      return {
        jobs: rawJobs,
        rawCount,
        outputCount: rawCount,
        deduped: false,
      };
    }
    if (rawCount === 0) {
      return {
        jobs: rawJobs,
        rawCount,
        outputCount: 0,
        deduped: true,
        dedupMetrics: {
          inputCount: 0,
          outputCount: 0,
          mergedPairs: 0,
          elapsedMs: 0,
        },
      };
    }

    const result = await this.dedupEngine.dedup(rawJobs);

    // Pick the first raw job per canonical cluster. We iterate the input
    // (which is already sorted by `JobsService`) so the representative
    // is the most-recent-on-the-best-site entry — and the output keeps
    // the same site/date ordering as a non-deduped response.
    const seen = new Set<string>();
    const representatives: JobPostDto[] = [];
    const representativeIds: string[] = [];
    const clusterSize = new Map<string, number>();
    for (let i = 0; i < rawJobs.length; i++) {
      const canonId = result.assignments[i];
      if (!canonId) continue; // rejected by engine
      clusterSize.set(canonId, (clusterSize.get(canonId) ?? 0) + 1);
      if (seen.has(canonId)) continue;
      seen.add(canonId);
      representatives.push(rawJobs[i]);
      representativeIds.push(canonId);
    }
    // Spec 1724 — merged representatives carry the cluster's union of
    // locations, and representatives the engine kept apart never share a key.
    const deduped = await finalizeRepresentatives(
      representatives,
      representativeIds,
      clusterSize,
      result.canonical,
    );

    this.logger.log(
      `dedup: ${rawCount} → ${deduped.length} (merged ${result.metrics.mergedPairs} pairs in ${result.metrics.elapsedMs}ms)`,
    );

    const persistOutcome = await this.maybePersist(result.canonical, options);

    return {
      jobs: deduped,
      rawCount,
      outputCount: deduped.length,
      deduped: true,
      dedupMetrics: result.metrics,
      ...persistOutcome,
    };
  }

  /**
   * Best-effort persistence of the post-dedup canonical records and their
   * source observations. Spec 004 / T11 + Q-018 (run #25, Option A).
   *
   * Returns a partial {@link AggregateResult} carrying only the
   * persistence-related fields, ready to spread into the final result
   * envelope. The four outcomes are:
   *
   *   - `persist=false` opt-out → no fields (consumer sees `persisted`
   *     and friends as `undefined`).
   *   - No `IJobStore` bound → no fields. Matches the dedup-engine
   *     precedent of silently skipping when nothing is wired.
   *   - Empty canonical list → no fields. Avoids a `upsertMany([])`
   *     round-trip on every all-rejected dedup pass.
   *   - Bound + non-empty → attempt `upsertMany` and (when an
   *     observation store is bound and the canonical record carries
   *     observations) `putAll`. Success → `persisted: true` +
   *     `persistCounts`. Failure → `persisted: false` + structured
   *     `persistError`. Errors are caught here and NEVER bubble.
   */
  private async maybePersist(
    canonical: ReadonlyArray<CanonicalJob>,
    options: AggregateOptions,
  ): Promise<Partial<AggregateResult>> {
    const wantPersist = options.persist ?? true;
    if (!wantPersist) return {};
    if (!this.jobStore) {
      this.logger.debug(
        'No IJobStore bound under JOB_STORE_TOKEN — skipping persistence',
      );
      return {};
    }
    if (canonical.length === 0) return {};

    try {
      const counts = await this.jobStore.upsertMany(canonical);
      // Observations are best-effort within best-effort: a successful
      // canonical upsert is the load-bearing write; observation failures
      // degrade to "canonical persisted, observations stale" rather than
      // nuking the persisted flag.
      if (this.observationStore) {
        await this.persistObservations(this.observationStore, canonical);
      }
      this.logger.log(
        `persisted: ${canonical.length} canonical records ` +
          `(inserted=${counts.inserted}, updated=${counts.updated})`,
      );
      return {
        persisted: true,
        persistCounts: counts,
      };
    } catch (err) {
      const code = readErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `persist failed: ${code} — ${message}. Search response continues.`,
      );
      return {
        persisted: false,
        persistError: { code, message },
      };
    }
  }

  /**
   * Write every canonical record's observation set (Spec 1722 / FR-13).
   *
   * A backend with `putAllMany` gets the whole set in one call and batches
   * it itself. Otherwise `putAll` runs per record with at most
   * {@link OBSERVATION_WRITE_CONCURRENCY} in flight: the previous
   * `Promise.allSettled(canonical.map(putAll))` started one transaction per
   * job at once — 25 k of them for a list-mode search — which drained the
   * Postgres pool and failed most of them. Never throws; failures are
   * logged with a count.
   */
  private async persistObservations(
    store: IJobObservationStore,
    canonical: ReadonlyArray<CanonicalJob>,
  ): Promise<void> {
    if (typeof store.putAllMany === 'function') {
      try {
        await store.putAllMany(
          canonical.map((c) => ({ canonicalJobId: c.canonicalJobId, observations: c.sources ?? [] })),
        );
      } catch (err) {
        this.logger.warn(
          `persist observations failed for a batch of ${canonical.length}: ${readErrorCode(err)} — ` +
            `${err instanceof Error ? err.message : String(err)}. Canonical records stay persisted.`,
        );
      }
      return;
    }

    let cursor = 0;
    let failed = 0;
    let firstError: unknown;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= canonical.length) return;
        const c = canonical[index]!;
        try {
          await store.putAll(c.canonicalJobId, c.sources ?? []);
        } catch (err) {
          failed++;
          firstError ??= err;
        }
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(OBSERVATION_WRITE_CONCURRENCY, canonical.length) }, () =>
        worker(),
      ),
    );
    if (failed > 0) {
      this.logger.warn(
        `persist observations: ${failed} of ${canonical.length} putAll calls failed ` +
          `(first: ${firstError instanceof Error ? firstError.message : String(firstError)}). ` +
          'Canonical records stay persisted.',
      );
    }
  }
}

/**
 * Most `putAll` calls in flight at once when the observation store has no
 * `putAllMany` (Spec 1722 / FR-13) — below any sane connection-pool size.
 */
export const OBSERVATION_WRITE_CONCURRENCY = 8;

/**
 * Jobs keyed between event-loop yields in {@link stampDedupKeys}. One key is
 * a normalise + sha-256 (~12 µs); 500 of them is ~6 ms, well under anything a
 * liveness probe or a concurrent request would notice.
 */
const DEDUP_KEY_YIELD_EVERY = 500;

/**
 * Jobs whose `dedupKey` {@link finalizeRepresentatives} already set during
 * this pass. {@link stampDedupKeys} consumes the mark (skip + delete) instead
 * of hashing the job a second time; it must not recompute a copy's key from
 * its widened `locations[]` (Spec 1724). A mark left on a cached raw job by
 * an interleaved request is harmless: that job's key is its own per-job key,
 * which is what recomputing would write.
 */
const PRE_KEYED = new WeakSet<JobPostDto>();

/**
 * Final shape of the deduped representatives (Spec 1724).
 *
 * 1. **Union of locations.** A representative whose cluster merged several
 *    postings carries the cluster's `locations[]` union (the engine's
 *    `CanonicalJob.locations`, head first) when that adds a site it did not
 *    list itself — e.g. a board listing merged into the ATS posting that
 *    names every office.
 * 2. **Distinct keys.** `dedupKey` is the representative's own per-job key,
 *    computed from its fields BEFORE the union, so it stays equal to the
 *    engine's cluster id. When two representatives share that key — the
 *    engine kept them apart although title, company and location coincide
 *    (conflicting employment types) — each carries its cluster id instead, so
 *    distinct postings never share a `dedupKey`.
 *
 * Representatives that change are shallow COPIES: the input may be the cached
 * fan-out, which a later `dedup=false` request must see unchanged. The rest
 * are keyed in place, as {@link stampDedupKeys} would.
 */
async function finalizeRepresentatives(
  representatives: JobPostDto[],
  ids: ReadonlyArray<string>,
  clusterSize: ReadonlyMap<string, number>,
  canonical: ReadonlyArray<CanonicalJob>,
): Promise<JobPostDto[]> {
  const keys: (string | undefined)[] = new Array(representatives.length);
  const perKey = new Map<string, number>();
  for (let i = 0; i < representatives.length; i++) {
    if (i > 0 && i % DEDUP_KEY_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const key = dedupKeyForJob(representatives[i]!);
    keys[i] = key;
    if (key !== undefined) perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }

  let byId: Map<string, CanonicalJob> | undefined;
  return representatives.map((job, i) => {
    const id = ids[i]!;
    const ownKey = keys[i];
    const key = ownKey !== undefined && (perKey.get(ownKey) ?? 0) > 1 ? id : ownKey;
    let union: LocationDto[] | undefined;
    if ((clusterSize.get(id) ?? 1) > 1) {
      byId ??= new Map(canonical.map((c) => [c.canonicalJobId, c]));
      const merged = byId.get(id)?.locations;
      const own = new Set<LocationDto>(job.locations ?? []);
      if (merged && merged.some((loc) => !own.has(loc))) union = [...merged];
    }
    if (key === ownKey && union === undefined) {
      if (key !== undefined) job.dedupKey = key;
      PRE_KEYED.add(job);
      return job;
    }
    const copy = new JobPostDto({ ...job, ...(union ? { locations: union } : {}) });
    if (key !== undefined) copy.dedupKey = key;
    PRE_KEYED.add(copy);
    return copy;
  });
}

/**
 * Stamp `dedupKey` (Spec 1721 / contract C9) on every job, in place.
 *
 * Always derived from the job's own normalised company/title/location via
 * `dedupKeyForJob` — the function the default dedup engine uses for
 * `canonicalJobId` — rather than from the engine's cluster assignment, so the
 * key is identical with `dedup=false`, with a swapped engine, from a cache hit
 * or a fresh fan-out, and across runs. For every representative the default
 * engine returns, the two coincide (the representative is the cluster head).
 * One exception (Spec 1724): deduped representatives that would share a key
 * carry their cluster ids — see {@link finalizeRepresentatives}, which also
 * keys the deduped path so this pass does not hash those jobs twice.
 *
 * Yields to the event loop every {@link DEDUP_KEY_YIELD_EVERY} jobs: a
 * 25 k-job list-mode corpus would otherwise block for ~0.3 s.
 */
export async function stampDedupKeys(jobs: JobPostDto[]): Promise<void> {
  for (let i = 0; i < jobs.length; i++) {
    if (i > 0 && i % DEDUP_KEY_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const job = jobs[i];
    if (!job) continue;
    if (PRE_KEYED.delete(job)) continue;
    const key = dedupKeyForJob(job);
    if (key !== undefined) job.dedupKey = key;
  }
}

/**
 * Read the structured `.code` off an error rejection, falling back to
 * {@link ERR_STORE_PERSIST_FAILED} when the rejection is a bare `Error`
 * or non-error value. Stays in this file rather than `@ever-jobs/common`
 * because the only caller is the persistence-failure path above.
 */
function readErrorCode(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return ERR_STORE_PERSIST_FAILED;
}
