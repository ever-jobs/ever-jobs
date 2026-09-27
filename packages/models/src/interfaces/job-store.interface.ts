import { CanonicalJob } from './canonical-job.interface';
import { SourceObservation } from './source-observation.interface';
import { JobStorePage, JobStoreQuery } from './job-store-query.interface';

/**
 * Persistent-store plugin contract for canonical jobs (Spec 004 / FR-1).
 *
 * Implementations are registered as NestJS providers under
 * {@link JOB_STORE_TOKEN}. Bootstrap binds the provider whose
 * {@link IStoreMetadata.id} matches `EVER_JOBS_STORE` (FR-3); no other code
 * consults the env var.
 *
 * Every method returns a `Promise`; callers MUST be ready for the underlying
 * backend to be down (`ERR_STORE_BACKEND_DOWN`). Callers MUST NOT depend on
 * write order across distinct keys — concurrent `upsert` calls for different
 * `canonicalJobId`s may complete in any order.
 *
 * Latency budgets per Spec 004 / NFR-1:
 *   - in-memory: < 5 ms p95 read
 *   - sqlite:    < 25 ms p95 read
 *   - postgres:  < 50 ms p95 read
 */
export interface IJobStore {
  /**
   * Insert or update a single canonical job by its `canonicalJobId`.
   *
   * Backends MUST treat `canonicalJobId` as the conflict key. The returned
   * record is the post-write row — useful for callers that want server-side
   * timestamps (`mergedAt`) reflected back without a follow-up read.
   */
  upsert(job: CanonicalJob): Promise<CanonicalJob>;

  /**
   * Bulk variant of {@link IJobStore.upsert} (Spec 004 / FR-8).
   *
   * Backends SHOULD use a single round-trip (Postgres `ON CONFLICT DO
   * UPDATE`, SQLite `INSERT ... ON CONFLICT`, Mongo bulk write, …) to hit
   * NFR-2 throughput targets. The return tuple lets callers report
   * dedup-engine effectiveness without a follow-up count.
   */
  upsertMany(
    jobs: ReadonlyArray<CanonicalJob>,
  ): Promise<{ inserted: number; updated: number }>;

  /**
   * Look up a canonical job by its primary key (which is `canonicalJobId`).
   *
   * Returns `null` (NOT `undefined`) when the key is unknown. The two are
   * not equivalent on the wire — `null` survives JSON.stringify, `undefined`
   * is dropped — so the contract pins `null` to keep the cache layer
   * cacheability rules unambiguous.
   */
  getById(id: string): Promise<CanonicalJob | null>;

  /**
   * Alias of {@link IJobStore.getById} kept for API symmetry with the
   * dedup-engine contract, which always speaks in `canonicalJobId`.
   * Implementations may share storage; the second method exists so callers
   * that hold an opaque dedup result don't have to remember that the two
   * IDs are the same field.
   */
  findByCanonicalId(canonicalJobId: string): Promise<CanonicalJob | null>;

  /**
   * Filtered, cursor-paginated list (Spec 004 / FR-7).
   *
   * The empty `JobStoreQuery` MUST return all rows (subject to `limit`).
   * Pagination is opaque-cursor; callers MUST treat `nextCursor` as a
   * black box. Backends raise `ERR_STORE_INVALID_CURSOR` for malformed
   * cursors rather than silently resetting to page 1, so callers learn
   * about cursor-format drifts immediately.
   */
  listByQuery(query: JobStoreQuery): Promise<JobStorePage<CanonicalJob>>;

  /**
   * Remove a canonical job and any directly-attached source observations.
   *
   * Returns `true` if a row was deleted, `false` if the id was unknown.
   * Backends MUST cascade to `IJobObservationStore` rows for the same
   * `canonicalJobId` so a re-scrape doesn't resurrect a soft-deleted
   * record. Soft-delete is intentionally NOT in the v1 contract — Spec
   * 012 will revisit retention policies.
   */
  delete(id: string): Promise<boolean>;
}

/**
 * Persistent-store plugin contract for {@link SourceObservation} rows
 * (Spec 004 / FR-2).
 *
 * Source observations are 1-N to `CanonicalJob`. We split them into a
 * separate interface (rather than nesting them under `IJobStore`) so
 * backends can pick storage shape independently:
 *   - Postgres: a child table with FK + cascade.
 *   - Mongo:    embedded array on the canonical document.
 *   - Memory:   a Map<canonicalJobId, SourceObservation[]>.
 *
 * The two stores are wired by the same backend plugin; production
 * deployments SHOULD bind both to one DI provider so there's no risk of
 * the canonical row and its observations diverging in a partial outage.
 */
export interface IJobObservationStore {
  /**
   * Replace the full observation set for `canonicalJobId`.
   *
   * Replace-not-merge keeps semantics simple: the dedup engine always
   * publishes the complete set for a canonical record at merge time
   * (Spec 003 / FR-1), and there is no other writer.
   */
  putAll(
    canonicalJobId: string,
    observations: ReadonlyArray<SourceObservation>,
  ): Promise<void>;

  /**
   * Batch variant of {@link IJobObservationStore.putAll} (Spec 1722 / FR-13):
   * the same replace-not-merge result as calling `putAll` once per entry.
   *
   * Optional — callers MUST fall back to `putAll` when a backend does not
   * implement it. Backends that do SHOULD write in bounded chunks (one
   * round-trip per chunk, not per entry) so a 25 k-job persist neither
   * exhausts a connection pool nor holds one transaction open for the whole
   * batch. Atomic per chunk, not per call. An entry whose canonical row does
   * not exist MAY be skipped rather than failing its chunk.
   */
  putAllMany?(entries: ReadonlyArray<ObservationBatchEntry>): Promise<void>;

  /**
   * All observations for one canonical job, in stable order. Callers
   * MUST treat the order as backend-defined; it is NOT guaranteed to
   * match insertion order.
   */
  listByCanonicalId(
    canonicalJobId: string,
  ): Promise<ReadonlyArray<SourceObservation>>;

  /**
   * Drop every observation tied to `canonicalJobId`. Idempotent — a
   * second call after the first returns the same `count` value of `0`.
   */
  deleteByCanonicalId(canonicalJobId: string): Promise<number>;
}

/**
 * One entry of {@link IJobObservationStore.putAllMany}: the complete
 * observation set for one canonical job.
 */
export interface ObservationBatchEntry {
  readonly canonicalJobId: string;
  readonly observations: ReadonlyArray<SourceObservation>;
}

/**
 * Static metadata advertised by a store plugin via the `@StorePlugin()`
 * decorator (Spec 004 / FR-4 / T02).
 *
 * `id` is what `EVER_JOBS_STORE` matches against; pick a short kebab-case
 * string (`postgres`, `sqlite`, `memory`, `mongo`, …). `description` is
 * surfaced by `GET /api/storage` and the CLI's `stores list` subcommand
 * for operator triage.
 */
export interface IStoreMetadata {
  /** Match key for `EVER_JOBS_STORE`. Lower-case kebab-case. */
  readonly id: string;
  /** Human-readable one-liner shown in admin/CLI output. */
  readonly description?: string;
}

/**
 * DI token used to bind the active `IJobStore`. Resolved by
 * `StoreModule.forActive(storeId)` (Spec 004 / T04).
 */
export const JOB_STORE_TOKEN = 'JOB_STORE';

/**
 * DI token used to bind the active `IJobObservationStore`. Bound by the
 * same plugin that binds {@link JOB_STORE_TOKEN} so the two stay
 * transactionally aligned.
 */
export const JOB_OBSERVATION_STORE_TOKEN = 'JOB_OBSERVATION_STORE';

/**
 * Reflector metadata key used by the `@StorePlugin()` decorator
 * (Spec 004 / T02). Kept here next to the contract so plugin authors
 * don't import from a deeper internal path.
 */
export const STORE_PLUGIN_METADATA_KEY = 'ever-jobs:store-plugin';

/**
 * Error code raised when bootstrap encounters an unknown
 * `EVER_JOBS_STORE` value (Spec 004 / §7.3 / T12). Surfaces via the
 * thrown `Error.code` — bootstrap MUST fail fast and refuse to start.
 */
export const ERR_STORE_NOT_FOUND = 'ERR_STORE_NOT_FOUND';

/** Error code raised by a backend when the underlying DB is unreachable. */
export const ERR_STORE_BACKEND_DOWN = 'ERR_STORE_BACKEND_DOWN';

/** Error code raised when a caller passes a malformed pagination cursor. */
export const ERR_STORE_INVALID_CURSOR = 'ERR_STORE_INVALID_CURSOR';
