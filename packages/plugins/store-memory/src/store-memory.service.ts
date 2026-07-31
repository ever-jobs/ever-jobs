import { Injectable } from '@nestjs/common';
import {
  CanonicalJob,
  ERR_STORE_INVALID_CURSOR,
  HEALTH_SNAPSHOT_QUERY_DEFAULT_LIMIT,
  HEALTH_SNAPSHOT_QUERY_MAX_LIMIT,
  HealthSnapshotQuery,
  HealthSnapshotRow,
  IHealthSnapshotStore,
  IJobObservationStore,
  IJobStore,
  JOB_STORE_QUERY_DEFAULT_LIMIT,
  JOB_STORE_QUERY_MAX_LIMIT,
  JobStorePage,
  JobStoreQuery,
  Site,
  SourceHealth,
  SourceObservation,
} from '@ever-jobs/models';
import { StorePlugin } from '@ever-jobs/plugin';

/**
 * Canonical id under which this backend registers with `StoreRegistry`.
 * Operators select it via `EVER_JOBS_STORE=memory`. Exported so consumers
 * (`apps/api`'s root module, integration tests) can import the constant
 * instead of hard-coding the string literal.
 */
export const STORE_MEMORY_ID = 'memory';

/**
 * One-line description shown by `GET /api/storage` and the CLI's
 * `stores list` subcommand for operator triage.
 */
export const STORE_MEMORY_DESCRIPTION =
  'In-memory reference store (Spec 004 — dev / tests, no persistence)';

/**
 * Default ceiling for the in-memory health-snapshot ring (Spec 005 /
 * T09 / FR-8 / NFR-3). 24 hours × 60 ticks/hour × 250 max sites
 * (Spec 005 / NFR-3 breaker pool ceiling) = 360 000 rows worst case.
 * The ring trims oldest-first so the cron can run indefinitely
 * without unbounded growth.
 *
 * Rationale for 24 h:
 *   - Operator dashboards typically render last-1h to last-24h
 *     rollups; anything older typically lives in a Postgres table.
 *   - 24 h × 60 s = 1 440 ticks; at 250 sites that's 360 000 rows.
 *     `SourceHealth` is ~120 bytes serialised → ~43 MB worst case
 *     in v8 heap (with object overhead). Within the in-memory
 *     reference backend's "dev / tests, no persistence" contract.
 */
export const DEFAULT_SNAPSHOT_CAP = 360_000;

/**
 * Default ceiling for the canonical-job / observation maps (Spec 5024).
 *
 * The snapshot ring has been capped since Spec 005 / T09, but `canonicals`
 * and `observations` were not — and because `JobsAggregator.maybePersist`
 * defaults `persist` to `true`, every `/api/jobs/search` upserted its whole
 * post-dedup corpus into them. Each `CanonicalJob` holds its source job's
 * `description` **by reference**, so an uncapped map pins every job
 * description ever returned for the lifetime of the process. On a
 * 4Gi container that is an OOMKill on a timer.
 *
 * 50 000 rows × ~3–4 KB/row (markdown descriptions, per Spec 004 / NFR-3's
 * ≤ 2 KB/job budget plus provenance) ≈ **150–200 MB** worst case — a
 * defensible ceiling for a backend whose own contract is "dev / tests, no
 * persistence", and small enough to leave headroom under a 4Gi limit.
 *
 * Override per-deployment with `EVER_JOBS_STORE_MAX_ROWS`, or per-instance
 * via {@link InMemoryJobStore.setRowCap}.
 */
export const DEFAULT_ROW_CAP = 50_000;

/**
 * Environment variable read at construction time for {@link DEFAULT_ROW_CAP}.
 * Kept as a plugin-local env read (rather than an injected `ConfigService`)
 * because `StoreModule.forActive` instantiates the backend class directly
 * with no constructor arguments — the same reason `DEFAULT_SNAPSHOT_CAP`
 * uses a constant + a setter seam instead of DI.
 */
export const STORE_MAX_ROWS_ENV_VAR = 'EVER_JOBS_STORE_MAX_ROWS';

/**
 * Resolve the row cap from the environment, falling back to
 * {@link DEFAULT_ROW_CAP} for unset / non-numeric / non-positive values.
 * Exported for the unit tests, which drive it with a synthetic env map
 * rather than mutating `process.env`.
 */
export function resolveRowCap(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[STORE_MAX_ROWS_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_ROW_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROW_CAP;
  return Math.floor(n);
}

/**
 * Stable opaque-cursor envelope (base64-encoded JSON).
 *
 * In-memory backend uses a logical row offset because the dataset is
 * already sorted deterministically (mergedAt DESC, canonicalJobId ASC).
 * The `v` discriminator lets a future change to cursor shape detect
 * and reject older clients with a structured `ERR_STORE_INVALID_CURSOR`
 * rather than silently desync them.
 */
interface MemoryCursor {
  readonly v: 1;
  readonly offset: number;
}

const MEMORY_CURSOR_VERSION = 1;

/**
 * Error type thrown for malformed pagination cursors. Carries the
 * Spec 004 §7.3 wire code so callers and the conformance suite can
 * `expect(...).toMatchObject({ code: ERR_STORE_INVALID_CURSOR })`
 * without coupling to a specific class.
 */
class MemoryStoreCursorError extends Error {
  readonly code: string = ERR_STORE_INVALID_CURSOR;

  constructor(detail: string) {
    super(`Malformed JobStoreQuery cursor (${detail})`);
    this.name = 'MemoryStoreCursorError';
  }
}

/**
 * Encode an opaque cursor for the next page. Base64 keeps the cursor
 * URL-safe-enough for a JSON wire payload; callers MUST treat it as
 * a black box per the contract.
 */
function encodeCursor(cursor: MemoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

/**
 * Decode and validate the opaque cursor. Surface `ERR_STORE_INVALID_CURSOR`
 * for every reject path: not-base64, not-json, missing fields, wrong
 * version, non-integer / negative offset. Silent fallback to "page 1"
 * is the failure mode this code path was created to prevent — operators
 * watching the dataset shrink will spot a thrown error in logs; a
 * silently-reset cursor will go unnoticed for hours.
 */
function decodeCursor(raw: string): MemoryCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new MemoryStoreCursorError('not base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new MemoryStoreCursorError('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MemoryStoreCursorError('not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== MEMORY_CURSOR_VERSION) {
    throw new MemoryStoreCursorError(`unsupported version ${String(obj.v)}`);
  }
  const offset = obj.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new MemoryStoreCursorError('offset is not a non-negative integer');
  }
  return { v: MEMORY_CURSOR_VERSION, offset };
}

/**
 * Resolve the effective `limit` for a query. The contract docs say
 * "default to {@link JOB_STORE_QUERY_DEFAULT_LIMIT} when omitted" and
 * "clamp to {@link JOB_STORE_QUERY_MAX_LIMIT}". A non-finite or
 * non-positive caller value falls back to the default rather than
 * throwing — caller hostility is the dedup engine's responsibility,
 * not the store's.
 */
function resolveLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return JOB_STORE_QUERY_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), JOB_STORE_QUERY_MAX_LIMIT);
}

/**
 * Ordering used by `listByQuery`: most-recent-first by `mergedAt`,
 * tie-broken by `canonicalJobId` ASC for total determinism (so cursor
 * pagination can resume by offset without surprising callers when two
 * jobs share an identical `mergedAt`).
 */
function compareForListing(a: CanonicalJob, b: CanonicalJob): number {
  if (a.mergedAt > b.mergedAt) return -1;
  if (a.mergedAt < b.mergedAt) return 1;
  if (a.canonicalJobId < b.canonicalJobId) return -1;
  if (a.canonicalJobId > b.canonicalJobId) return 1;
  return 0;
}

/**
 * In-memory reference implementation of `IJobStore` + `IJobObservationStore`
 * (Spec 004 / Phase 2 / T05–T06).
 *
 * Backing data structures:
 *   - `Map<canonicalJobId, CanonicalJob>` — primary keyed lookup.
 *   - `Map<canonicalJobId, SourceObservation[]>` — observations.
 *
 * Cursor pagination uses a base64-encoded `{ v: 1, offset }` envelope
 * over a deterministic ordering (mergedAt DESC, canonicalJobId ASC).
 * Filters honour Spec 004 §7.1 / FR-7: case-insensitive substring on
 * `company` / `title` / `location`, plus an inclusive lower bound on
 * `mergedAt` (`since`).
 *
 * Memory characteristics (Spec 004 / NFR-3 — ≤ 2 KB / job):
 *   The implementation stores each `CanonicalJob` reference verbatim;
 *   no copies, no indexes. Memory overhead is exactly the JSON shape
 *   the dedup engine produced. Observations are stored as a flat array
 *   keyed by canonical id — `putAll` discards the old array reference
 *   so GC can reclaim it immediately.
 *
 * Concurrency: single-threaded JS makes mutations atomic at the method
 * granularity. Concurrent `upsert` for distinct ids is safe; concurrent
 * `upsertMany` batches with overlapping ids race in caller order
 * (later writer wins), matching the contract's "concurrent upsert calls
 * for different canonicalJobIds may complete in any order" caveat.
 *
 * Decorated with `@StorePlugin({ id: 'memory' })` so
 * `StoreModule.forActive('memory', { backends: [InMemoryJobStore] })`
 * picks it up at bootstrap. The decorator is `SetMetadata` under the
 * hood — it does not introduce a NestJS-DI runtime dependency, so
 * the conformance suite can still `new InMemoryJobStore()` directly
 * without spinning up a `TestingModule`.
 */
@StorePlugin({ id: STORE_MEMORY_ID, description: STORE_MEMORY_DESCRIPTION })
@Injectable()
export class InMemoryJobStore
  implements IJobStore, IJobObservationStore, IHealthSnapshotStore
{
  private readonly canonicals = new Map<string, CanonicalJob>();
  private readonly observations = new Map<string, SourceObservation[]>();
  /**
   * Append-only ring of `(ts, health)` rows ordered by insertion (== ts
   * ASC by construction — `HealthSnapshotCron` uses one fresh `Date()`
   * per tick). 24 hours at the default 60 s cadence × 250 max sites
   * (Spec 005 / NFR-3 ceiling) = 360 000 rows ~ ~95 MB worst case.
   * Capped at {@link MAX_SNAPSHOT_ROWS}; oldest rows drop first
   * (`shift()`-style trim) so the cron can run indefinitely without
   * unbounded growth. Override the cap by calling
   * {@link InMemoryJobStore.setSnapshotCap} (test seam; production
   * uses the default).
   */
  private readonly snapshots: { ts: Date; health: SourceHealth }[] = [];
  private snapshotCap: number = DEFAULT_SNAPSHOT_CAP;
  /**
   * Ceiling on {@link canonicals} (and, by cascade, {@link observations}).
   * Spec 5024. Resolved from `EVER_JOBS_STORE_MAX_ROWS` at construction;
   * override per-instance with {@link setRowCap}.
   */
  private rowCap: number = resolveRowCap();

  // ----------------------------------------------------------------------
  // IJobStore
  // ----------------------------------------------------------------------

  async upsert(job: CanonicalJob): Promise<CanonicalJob> {
    this.canonicals.set(job.canonicalJobId, job);
    this.trimRows();
    return job;
  }

  async upsertMany(
    jobs: ReadonlyArray<CanonicalJob>,
  ): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const job of jobs) {
      if (this.canonicals.has(job.canonicalJobId)) {
        updated++;
      } else {
        inserted++;
      }
      this.canonicals.set(job.canonicalJobId, job);
    }
    // Trim ONCE after the whole batch, not per row: a single search can
    // upsert tens of thousands of canonicals, and trimming inside the loop
    // would be O(n²) against the Map iterator.
    this.trimRows();
    return { inserted, updated };
  }

  /**
   * Enforce {@link rowCap} on {@link canonicals}, cascading into
   * {@link observations} (Spec 5024).
   *
   * Eviction order is **first-insert-first-out, not LRU** — `Map.set` on an
   * existing key does not move it to the back of the iteration order, so a
   * hot row that keeps being re-upserted still ages out on its original
   * insertion position. That is deliberate: this is a safety valve against
   * unbounded growth on a backend documented as "dev / tests, no
   * persistence", not a cache eviction policy. Callers that need real
   * recency semantics should use a durable backend.
   *
   * The cascade into `observations` is load-bearing: `putAll` stores a
   * shallow `.slice()` of the observation array, so dropping a canonical
   * without dropping its observations would free almost nothing.
   *
   * Uses a `while` loop rather than a single `if`, because `upsertMany`
   * can push the map past the cap by an arbitrary amount in one call.
   */
  private trimRows(): void {
    while (this.canonicals.size > this.rowCap) {
      const oldest = this.canonicals.keys().next().value;
      if (oldest === undefined) break;
      this.canonicals.delete(oldest);
      this.observations.delete(oldest);
    }

    // `observations` must ALSO be bounded on its own, not only via the
    // cascade above. `JobsAggregator.maybePersist` calls `upsertMany(batch)`
    // and then `putAll(id, …)` for **every** id in that batch — so when a
    // batch is larger than the cap, the ids `upsertMany` just evicted get
    // their observations written straight back by the following `putAll`
    // loop. Those orphans have no canonical to cascade from, so a
    // cascade-only trim would let `observations` grow without limit and
    // simply relocate the leak this cap exists to close.
    while (this.observations.size > this.rowCap) {
      const oldest = this.observations.keys().next().value;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
    }
  }

  async getById(id: string): Promise<CanonicalJob | null> {
    return this.canonicals.get(id) ?? null;
  }

  async findByCanonicalId(canonicalJobId: string): Promise<CanonicalJob | null> {
    // Aliased intentionally per Spec 004 §7.1 — the two ids are the
    // same field; the second method name exists for caller clarity
    // when the value flowed in from the dedup engine's typed `canonicalJobId`.
    return this.getById(canonicalJobId);
  }

  async listByQuery(query: JobStoreQuery): Promise<JobStorePage<CanonicalJob>> {
    const limit = resolveLimit(query.limit);
    // `typeof === 'string'` (NOT truthy) so an explicit empty-string
    // cursor doesn't silently fall through to "page 1" — a caller that
    // sent `cursor: ''` deserves the structured `ERR_STORE_INVALID_CURSOR`
    // signal, same as any other malformed cursor.
    const offset =
      typeof query.cursor === 'string' ? decodeCursor(query.cursor).offset : 0;

    const lcCompany = query.company?.toLowerCase();
    const lcTitle = query.title?.toLowerCase();
    const lcLocation = query.location?.toLowerCase();
    const sinceIso = query.since instanceof Date ? query.since.toISOString() : undefined;

    // Single-pass filter — avoids materialising the unfiltered set
    // when the cohort is large and the filter is selective.
    const filtered: CanonicalJob[] = [];
    for (const job of this.canonicals.values()) {
      if (lcCompany && !job.company.toLowerCase().includes(lcCompany)) continue;
      if (lcTitle && !job.title.toLowerCase().includes(lcTitle)) continue;
      if (lcLocation && !job.location.toLowerCase().includes(lcLocation)) continue;
      if (sinceIso && job.mergedAt < sinceIso) continue;
      filtered.push(job);
    }

    filtered.sort(compareForListing);

    const items = filtered.slice(offset, offset + limit);
    // `items` is the slice we'll return; build a `JobStorePage` whose
    // `nextCursor` is OMITTED (key absent, not `nextCursor: undefined`)
    // when we've reached the end so JSON callers see a clean payload.
    const hasMore = offset + items.length < filtered.length;
    if (hasMore) {
      return {
        items,
        nextCursor: encodeCursor({ v: MEMORY_CURSOR_VERSION, offset: offset + items.length }),
      };
    }
    return { items };
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.canonicals.delete(id);
    if (existed) {
      // Cascade per Spec 004 §7.1 — a re-scrape MUST NOT resurrect
      // stale observations attached to a soft-deleted canonical row.
      this.observations.delete(id);
    }
    return existed;
  }

  // ----------------------------------------------------------------------
  // IJobObservationStore
  // ----------------------------------------------------------------------

  async putAll(
    canonicalJobId: string,
    observations: ReadonlyArray<SourceObservation>,
  ): Promise<void> {
    // Replace-not-merge per FR-2: we copy the input array so future
    // mutations on the caller's reference don't bleed into the store
    // (and vice-versa). The dedup engine is the single writer per
    // Spec 003 / FR-1, but defensive copy is cheap (~N pointers).
    this.observations.set(canonicalJobId, observations.slice());
    // Spec 5024 — `putAll` is a write path into an unbounded Map, so it has to
    // respect the cap too. See `trimRows()` for why the cascade alone is not
    // enough when a persisted batch exceeds the cap.
    this.trimRows();
  }

  async listByCanonicalId(
    canonicalJobId: string,
  ): Promise<ReadonlyArray<SourceObservation>> {
    const found = this.observations.get(canonicalJobId);
    if (!found) return [];
    // Return a frozen view so callers cannot mutate the store's
    // internal array. The slice is intentional — `Object.freeze`
    // alone would not stop a sneaky `[].push` if we returned the
    // live array.
    return found.slice();
  }

  async deleteByCanonicalId(canonicalJobId: string): Promise<number> {
    const existing = this.observations.get(canonicalJobId);
    if (!existing) return 0;
    this.observations.delete(canonicalJobId);
    return existing.length;
  }

  // ----------------------------------------------------------------------
  // IHealthSnapshotStore (Spec 005 / T09 / FR-8)
  // ----------------------------------------------------------------------

  /**
   * Append a per-tick batch of `SourceHealth` snapshots to the ring.
   *
   * Empty batch short-circuits per the contract (`{ inserted: 0 }`,
   * no Map mutation). The defensive `.slice()` on each entry would
   * be wasteful — `SourceHealth` is a `readonly`-shaped DTO; we
   * trust the caller-provided reference. The shared `ts` Date is
   * stored *by value* (`new Date(ts.getTime())`) so a caller that
   * later mutates the original Date (rare but possible) cannot
   * retroactively change a stored row.
   *
   * Trimming to {@link snapshotCap} happens inline — `splice(0, N)`
   * drops the N oldest rows when capacity is exceeded. The
   * append-and-trim pattern is amortised O(1) per insert (V8 ring-
   * buffer behaviour for arrays under ~1M elements).
   */
  async putBatch(
    snapshots: ReadonlyArray<SourceHealth>,
    ts: Date,
  ): Promise<{ inserted: number }> {
    if (snapshots.length === 0) {
      return { inserted: 0 };
    }
    // Defensive copy of the timestamp so a caller mutating their
    // original Date object doesn't retroactively shift stored rows.
    const frozenTs = new Date(ts.getTime());
    for (const health of snapshots) {
      this.snapshots.push({ ts: frozenTs, health });
    }
    // Trim oldest-first when over the cap. Slice-and-replace would
    // GC every retained reference; splice keeps the existing array
    // identity so concurrent `listSince` walkers stay coherent.
    const overflow = this.snapshots.length - this.snapshotCap;
    if (overflow > 0) {
      this.snapshots.splice(0, overflow);
    }
    return { inserted: snapshots.length };
  }

  /**
   * Read every snapshot whose `ts >= since`, optionally narrowed by
   * site, sorted ascending by `(ts, site)`.
   *
   * Implementation walks the ring from the end backwards (newest-
   * first) until it sees the first row strictly older than `since`;
   * everything before that point is necessarily older too because
   * the ring is sorted by insertion order (== ts ASC by construction
   * — `HealthSnapshotCron` uses one fresh `Date()` per tick). We
   * then reverse-sort the collected window to match the contract's
   * ascending order.
   *
   * `limit` clamps at {@link HEALTH_SNAPSHOT_QUERY_MAX_LIMIT}; values
   * `<= 0` fall back to {@link HEALTH_SNAPSHOT_QUERY_DEFAULT_LIMIT}.
   * The clamp-and-continue posture matches `JobStoreQuery` precedent.
   */
  async listSince(
    since: Date,
    options?: HealthSnapshotQuery,
  ): Promise<ReadonlyArray<HealthSnapshotRow>> {
    const sinceMs = since.getTime();
    const siteFilter = options?.site;
    const limit = resolveSnapshotLimit(options?.limit);

    // Walk newest-first, gather matching rows until we hit `since` OR
    // the limit. Reverse at the end so the contract's ascending order
    // is honoured.
    const collected: HealthSnapshotRow[] = [];
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const row = this.snapshots[i];
      if (row.ts.getTime() < sinceMs) break;
      if (siteFilter !== undefined && row.health.site !== siteFilter) continue;
      collected.push({ ts: row.ts, health: row.health });
      if (collected.length >= limit) break;
    }
    collected.reverse();
    return collected;
  }

  /**
   * Latest recorded snapshot for `site`, or `null` when this site
   * has never been snapshotted.
   *
   * Newest-first scan; bails on first hit. O(N_total) worst case,
   * O(1) typical (the cron writes every active site each tick, so
   * the latest entry for any active site is the most recent tail
   * entry). A future ring keyed by site would optimise the
   * worst-case `null` lookup, but the in-memory backend's contract
   * is "dev / tests, no persistence" — premature.
   */
  async latest(site: Site): Promise<SourceHealth | null> {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].health.site === site) {
        return this.snapshots[i].health;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------------
  // Test / debug surface (not part of either interface contract).
  // ----------------------------------------------------------------------

  /**
   * Total canonical rows currently stored. Intended for diagnostics and
   * tests; production callers SHOULD use `listByQuery` for any business
   * logic.
   */
  get size(): number {
    return this.canonicals.size;
  }

  /**
   * Drop every row + observation + snapshot. Tests use this between
   * cases when the same instance is shared across `it()` blocks;
   * `factory()` in the conformance suite returns a fresh instance per
   * case so prod code SHOULD not call this.
   */
  clear(): void {
    this.canonicals.clear();
    this.observations.clear();
    this.snapshots.length = 0;
  }

  /**
   * Total snapshot rows currently stored. Diagnostic-only seam; the
   * contract surface is `listSince` / `latest`.
   */
  get snapshotSize(): number {
    return this.snapshots.length;
  }

  /**
   * Override the snapshot ring cap. Test seam — production code uses
   * the {@link DEFAULT_SNAPSHOT_CAP} default. Trims immediately if
   * the current ring exceeds the new cap so callers can verify
   * trim-on-overflow behaviour with smaller, faster fixtures.
   */
  /**
   * Current row ceiling. Diagnostic seam so an admin endpoint / test can
   * assert the resolved `EVER_JOBS_STORE_MAX_ROWS` without re-reading env.
   */
  get rowCapacity(): number {
    return this.rowCap;
  }

  /**
   * Number of canonical ids currently holding an observation array.
   * Diagnostic-only seam — `observations` is bounded independently of
   * `canonicals` (see {@link trimRows}), so it needs its own counter to be
   * observable.
   */
  get observationCount(): number {
    return this.observations.size;
  }

  /**
   * Override the canonical-row cap (Spec 5024). Test seam and escape hatch;
   * production resolves {@link DEFAULT_ROW_CAP} / `EVER_JOBS_STORE_MAX_ROWS`
   * at construction. Trims immediately so callers can verify
   * trim-on-overflow with small fixtures.
   */
  setRowCap(cap: number): void {
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      throw new RangeError(
        `setRowCap requires a positive finite number (got ${String(cap)})`,
      );
    }
    this.rowCap = Math.floor(cap);
    this.trimRows();
  }

  setSnapshotCap(cap: number): void {
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      throw new RangeError(
        `setSnapshotCap requires a positive finite number (got ${String(cap)})`,
      );
    }
    this.snapshotCap = Math.floor(cap);
    const overflow = this.snapshots.length - this.snapshotCap;
    if (overflow > 0) {
      this.snapshots.splice(0, overflow);
    }
  }
}

/**
 * Resolve the effective `limit` for {@link InMemoryJobStore.listSince}.
 * Mirrors {@link resolveLimit} but uses the snapshot-specific
 * defaults / clamps. Pulled into a standalone function for symmetry
 * with the existing job-store helper and to keep the method bodies
 * readable.
 */
function resolveSnapshotLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return HEALTH_SNAPSHOT_QUERY_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), HEALTH_SNAPSHOT_QUERY_MAX_LIMIT);
}

