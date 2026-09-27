import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CanonicalJob,
  ERR_STORE_INVALID_CURSOR,
  IJobObservationStore,
  IJobStore,
  JOB_STORE_QUERY_DEFAULT_LIMIT,
  JOB_STORE_QUERY_MAX_LIMIT,
  JobStorePage,
  JobStoreQuery,
  ObservationBatchEntry,
  Site,
  SourceObservation,
} from '@ever-jobs/models';
import { StorePlugin } from '@ever-jobs/plugin';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, like, lt, or, sql } from 'drizzle-orm';
import {
  BetterSQLite3Database,
  drizzle,
} from 'drizzle-orm/better-sqlite3';
import { canonicalJob, INITIAL_SCHEMA_SQL, sourceObservation } from '../drizzle/schema';

/**
 * Canonical id under which this backend registers with `StoreRegistry`.
 * Operators select it via `EVER_JOBS_STORE=sqlite`.
 */
export const STORE_SQLITE_DRIZZLE_ID = 'sqlite';

/**
 * One-line description shown by `GET /api/storage` and the CLI's
 * `stores list` subcommand for operator triage.
 */
export const STORE_SQLITE_DRIZZLE_DESCRIPTION =
  'SQLite reference store via Drizzle + better-sqlite3 (Spec 004 — dev-default)';

/**
 * Cursor envelope for SQLite keyset pagination.
 *
 * Encoded as base64-of-JSON over `{ v, mergedAt, canonicalJobId }`. We use
 * **keyset** pagination (NOT offset) because offset paging on SQLite
 * degrades to O(N) at scale: every page has to walk the prefix it would
 * skip. With a keyset cursor, the seek is a single B-tree probe against
 * the `(merged_at, canonical_job_id)` composite index, regardless of how
 * deep the page is. This keeps `listByQuery` within Spec 004 / NFR-1's
 * < 25 ms p95 budget even on a million-row table.
 *
 * The cursor literally encodes the last-yielded row's ordering tuple so
 * page N+1 resumes with `WHERE (merged_at, canonical_job_id) < cursor`
 * (in the deterministic-listing sense — `merged_at` DESC, `canonical_job_id`
 * ASC tie-break). Any drift from that ordering would silently desync
 * pagination; see {@link compareCursorRow} for the inversion that turns
 * "DESC, ASC" into a single SQL predicate.
 */
interface SqliteCursor {
  readonly v: 1;
  readonly mergedAt: string;
  readonly canonicalJobId: string;
}

const SQLITE_CURSOR_VERSION = 1;

/**
 * Error type thrown for malformed pagination cursors. Carries the
 * Spec 004 §7.3 wire code so callers and the conformance suite can
 * `expect(...).toMatchObject({ code: ERR_STORE_INVALID_CURSOR })`
 * without coupling to a specific class.
 */
class SqliteStoreCursorError extends Error {
  readonly code: string = ERR_STORE_INVALID_CURSOR;

  constructor(detail: string) {
    super(`Malformed JobStoreQuery cursor (${detail})`);
    this.name = 'SqliteStoreCursorError';
  }
}

function encodeCursor(cursor: SqliteCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

/**
 * Decode and validate the opaque cursor. Surface `ERR_STORE_INVALID_CURSOR`
 * for every reject path: not-base64, not-json, missing fields, wrong
 * version, non-string components. Silent fallback to "page 1" is the
 * failure mode this code path was created to prevent — a cursor-format
 * drift would silently desync paginating callers.
 */
function decodeCursor(raw: string): SqliteCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new SqliteStoreCursorError('not base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new SqliteStoreCursorError('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SqliteStoreCursorError('not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== SQLITE_CURSOR_VERSION) {
    throw new SqliteStoreCursorError(`unsupported version ${String(obj.v)}`);
  }
  if (typeof obj.mergedAt !== 'string' || obj.mergedAt.length === 0) {
    throw new SqliteStoreCursorError('mergedAt is not a non-empty string');
  }
  if (typeof obj.canonicalJobId !== 'string' || obj.canonicalJobId.length === 0) {
    throw new SqliteStoreCursorError('canonicalJobId is not a non-empty string');
  }
  return {
    v: SQLITE_CURSOR_VERSION,
    mergedAt: obj.mergedAt,
    canonicalJobId: obj.canonicalJobId,
  };
}

/**
 * Resolve the effective `limit` for a query. Mirrors the in-memory
 * backend (T06): default to {@link JOB_STORE_QUERY_DEFAULT_LIMIT} when
 * omitted / non-finite / non-positive; clamp to
 * {@link JOB_STORE_QUERY_MAX_LIMIT}. Behaviour MUST match across
 * backends so the conformance suite's limit cases pass uniformly.
 */
function resolveLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return JOB_STORE_QUERY_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), JOB_STORE_QUERY_MAX_LIMIT);
}

/**
 * Configuration for the SQLite backend. Defaults to an ephemeral
 * `:memory:` database — this is what the conformance test factory uses
 * so each test gets a brand-new schema. Production deployments pass a
 * file path (e.g. `/var/lib/ever-jobs/jobs.db`).
 */
export interface StoreSqliteDrizzleConfig {
  /**
   * Filesystem path passed to `better-sqlite3`. `':memory:'` (default)
   * creates an ephemeral in-process database; pass an absolute path for
   * persistent storage.
   */
  readonly databaseUrl?: string;

  /**
   * Rows per transaction for `upsertMany` / `putAllMany` (Spec 1722 /
   * FR-15). The event loop gets a turn between chunks. Defaults to
   * {@link DEFAULT_SQLITE_BATCH_SIZE}; the API binds it from
   * `EVER_JOBS_STORE_BATCH_SIZE`.
   */
  readonly batchSize?: number;
}

/**
 * Default rows per transaction. With prepared statements a row costs a few
 * microseconds, so a 500-row chunk blocks the event loop for single-digit
 * milliseconds — short enough for NDJSON heartbeats and concurrent requests.
 */
export const DEFAULT_SQLITE_BATCH_SIZE = 500;

/**
 * NestJS DI token for {@link StoreSqliteDrizzleConfig}. Bind it via a
 * provider in the consuming app's root module so the SQLite path is
 * resolved from `EVER_JOBS_SQLITE_PATH` at bootstrap. The token is
 * `@Optional()` on the constructor — when absent, the backend defaults
 * to `:memory:`, which is the right behaviour for tests but NOT for
 * production (operators MUST set the path explicitly to get
 * persistence).
 */
export const STORE_SQLITE_DRIZZLE_CONFIG = 'STORE_SQLITE_DRIZZLE_CONFIG';

/**
 * SQLite-backed reference implementation of `IJobStore` +
 * `IJobObservationStore` (Spec 004 / Phase 3 / T07–T08).
 *
 * Design choices:
 *
 * 1. **Synchronous driver.** `better-sqlite3` is the recommended
 *    Node binding for SQLite and is intentionally synchronous —
 *    SQLite itself is in-process, so an async wrapper would add
 *    overhead without parallelism. The IJobStore methods stay async
 *    (returning resolved Promises) to match the contract.
 *
 * 2. **Drizzle as the SQL builder.** Drizzle gives us schema-typed
 *    query construction without a heavyweight ORM. The schema in
 *    `../drizzle/schema.ts` is the single source-of-truth; both the
 *    runtime queries here and the migration SQL in
 *    `../drizzle/migrations/0000_init.sql` derive from it.
 *
 * 3. **Keyset cursor pagination.** Spec 004 / NFR-1 budgets < 25 ms
 *    p95 for sqlite. Offset paging fails this at scale (every page
 *    walks the skipped prefix); keyset paging stays O(log N) by
 *    seeking on the composite `(merged_at, canonical_job_id)` index.
 *    See {@link buildKeysetCursorPredicate} for the inversion that
 *    converts "ORDER BY merged_at DESC, canonical_job_id ASC" into a
 *    single SQL predicate.
 *
 * 4. **JSON columns for `fields` and `sources`.** The `CanonicalJob`
 *    interface has nested data (`fields` is a Record, `sources` is
 *    an array) that doesn't decompose cleanly into SQL columns
 *    without losing fidelity. Storing them as JSON is what the
 *    Spec 004 §7.1 contract effectively asks for ("backends MAY
 *    store nested data as opaque blobs"). `sources_json` is also
 *    redundantly populated alongside the `source_observation` rows
 *    so callers that only want the round-trip shape can avoid the
 *    JOIN — at the cost of ~2x the bytes per row. The authoritative
 *    source for joins / FK cascade / observation-side queries is
 *    still {@link sourceObservation}.
 *
 * 5. **Case-folded shadow columns.** `company_lc`/`title_lc`/
 *    `location_lc` are populated on every insert/update by the
 *    application layer (this service). Filter queries hit the
 *    indexed `_lc` column with `LIKE`; this turns case-insensitive
 *    substring search into a B-tree prefix scan that stays inside
 *    NFR-1 even on a million-row cohort.
 *
 * 6. **`PRAGMA foreign_keys = ON`.** Set in the constructor; a
 *    backend-specific test exercises the cascade explicitly to
 *    guard against future schema-only edits forgetting the PRAGMA
 *    (the in-memory backend simulates the cascade in JS, but here
 *    SQLite owns it).
 */
@StorePlugin({
  id: STORE_SQLITE_DRIZZLE_ID,
  description: STORE_SQLITE_DRIZZLE_DESCRIPTION,
})
@Injectable()
export class SqliteDrizzleJobStore implements IJobStore, IJobObservationStore {
  private readonly db: BetterSQLite3Database<{
    canonicalJob: typeof canonicalJob;
    sourceObservation: typeof sourceObservation;
  }>;
  private readonly client: Database.Database;
  private readonly batchSize: number;
  /** Prepared statements for the batch paths, compiled on first use. */
  private batchStatements?: SqliteBatchStatements;

  constructor(
    @Optional()
    @Inject(STORE_SQLITE_DRIZZLE_CONFIG)
    config?: StoreSqliteDrizzleConfig,
  ) {
    const databaseUrl = config?.databaseUrl ?? ':memory:';
    this.batchSize = resolveBatchSize(config?.batchSize);
    this.client = new Database(databaseUrl);
    // FK cascade enforcement is OFF by default in SQLite — set it
    // here so DELETE on canonical_job propagates to source_observation.
    this.client.pragma('foreign_keys = ON');
    // WAL journal mode is faster and safer for concurrent readers,
    // but irrelevant for `:memory:`. Skip it when the path is in-memory.
    if (databaseUrl !== ':memory:') {
      this.client.pragma('journal_mode = WAL');
    }
    this.db = drizzle(this.client, {
      schema: { canonicalJob, sourceObservation },
    });
    // Bootstrap the schema — idempotent thanks to `IF NOT EXISTS`.
    // Splits the multi-statement SQL on `;\n` because better-sqlite3
    // .exec() requires single statements.
    const schemaSql = INITIAL_SCHEMA_SQL.queryChunks
      .map((c) => (typeof c === 'object' && 'value' in c ? String(c.value) : ''))
      .join('');
    this.client.exec(schemaSql);
  }

  // ----------------------------------------------------------------------
  // IJobStore
  // ----------------------------------------------------------------------

  async upsert(job: CanonicalJob): Promise<CanonicalJob> {
    const row = toCanonicalJobRow(job);
    this.db
      .insert(canonicalJob)
      .values(row)
      .onConflictDoUpdate({
        target: canonicalJob.canonicalJobId,
        set: {
          title: row.title,
          company: row.company,
          location: row.location,
          description: row.description,
          url: row.url,
          mergedAt: row.mergedAt,
          fieldsJson: row.fieldsJson,
          sourcesJson: row.sourcesJson,
          companyLc: row.companyLc,
          titleLc: row.titleLc,
          locationLc: row.locationLc,
        },
      })
      .run();
    return job;
  }

  async upsertMany(
    jobs: ReadonlyArray<CanonicalJob>,
  ): Promise<{ inserted: number; updated: number }> {
    if (jobs.length === 0) {
      return { inserted: 0, updated: 0 };
    }
    // Spec 1722 / FR-15. The previous shape bound EVERY id in one
    // `IN (…)` pre-check (fails past SQLite's 32 766-variable limit) and
    // wrote the whole batch in one synchronous transaction (a 10 000-row
    // persist blocked the event loop for ~4 s: no other request, no NDJSON
    // heartbeat). Now: prepared statements (one row's values per statement),
    // one transaction per chunk, and a `setImmediate` turn between chunks.
    //
    // The existence probe runs inside the chunk's transaction just before
    // each write, so a repeated id counts as an update of the row its first
    // occurrence inserted — exactly what sequential upserts report.
    // Atomic per chunk, not per call: a failure part-way leaves earlier
    // chunks written, which is safe for idempotent upserts.
    const statements = this.getBatchStatements();
    const writeChunk = this.client.transaction((chunk: ReadonlyArray<CanonicalJob>) => {
      let inserted = 0;
      for (const job of chunk) {
        const exists = statements.canonicalExists.get(job.canonicalJobId) !== undefined;
        statements.upsertCanonical.run(toCanonicalJobRow(job));
        if (!exists) inserted++;
      }
      return inserted;
    });

    let inserted = 0;
    for (let start = 0; start < jobs.length; start += this.batchSize) {
      if (start > 0) await yieldToEventLoop();
      inserted += writeChunk(jobs.slice(start, start + this.batchSize));
    }
    return { inserted, updated: jobs.length - inserted };
  }

  async getById(id: string): Promise<CanonicalJob | null> {
    const rows = this.db
      .select()
      .from(canonicalJob)
      .where(eq(canonicalJob.canonicalJobId, id))
      .limit(1)
      .all();
    if (rows.length === 0) return null;
    return fromCanonicalJobRow(rows[0]);
  }

  async findByCanonicalId(canonicalJobId: string): Promise<CanonicalJob | null> {
    return this.getById(canonicalJobId);
  }

  async listByQuery(query: JobStoreQuery): Promise<JobStorePage<CanonicalJob>> {
    const limit = resolveLimit(query.limit);
    const cursor =
      typeof query.cursor === 'string' ? decodeCursor(query.cursor) : undefined;

    const conds = [];
    if (query.company) {
      conds.push(like(canonicalJob.companyLc, `%${query.company.toLowerCase()}%`));
    }
    if (query.title) {
      conds.push(like(canonicalJob.titleLc, `%${query.title.toLowerCase()}%`));
    }
    if (query.location) {
      conds.push(like(canonicalJob.locationLc, `%${query.location.toLowerCase()}%`));
    }
    if (query.since instanceof Date) {
      conds.push(gte(canonicalJob.mergedAt, query.since.toISOString()));
    }
    if (cursor) {
      conds.push(buildKeysetCursorPredicate(cursor));
    }

    const where = conds.length > 0 ? and(...conds) : undefined;

    const rows = this.db
      .select()
      .from(canonicalJob)
      .where(where)
      .orderBy(desc(canonicalJob.mergedAt), asc(canonicalJob.canonicalJobId))
      .limit(limit)
      .all();

    const items = rows.map(fromCanonicalJobRow);

    if (items.length < limit) {
      // Last page — no cursor.
      return { items };
    }
    // Probe one extra row with a follow-up keyset query to know whether
    // there's MORE data after this page. Cheaper than `OFFSET` + a
    // duplicate scan; the index seek is O(log N).
    const last = items[items.length - 1];
    const more = this.db
      .select({ id: canonicalJob.canonicalJobId })
      .from(canonicalJob)
      .where(
        where
          ? and(
              where,
              buildKeysetCursorPredicate({
                v: SQLITE_CURSOR_VERSION,
                mergedAt: last.mergedAt,
                canonicalJobId: last.canonicalJobId,
              }),
            )
          : buildKeysetCursorPredicate({
              v: SQLITE_CURSOR_VERSION,
              mergedAt: last.mergedAt,
              canonicalJobId: last.canonicalJobId,
            }),
      )
      .limit(1)
      .all();

    if (more.length === 0) {
      return { items };
    }
    return {
      items,
      nextCursor: encodeCursor({
        v: SQLITE_CURSOR_VERSION,
        mergedAt: last.mergedAt,
        canonicalJobId: last.canonicalJobId,
      }),
    };
  }

  async delete(id: string): Promise<boolean> {
    // FK ON DELETE CASCADE drops attached observations automatically
    // (PRAGMA foreign_keys = ON in the constructor enforces this).
    const result = this.db
      .delete(canonicalJob)
      .where(eq(canonicalJob.canonicalJobId, id))
      .run();
    return result.changes > 0;
  }

  // ----------------------------------------------------------------------
  // IJobObservationStore
  // ----------------------------------------------------------------------

  async putAll(
    canonicalJobId: string,
    observations: ReadonlyArray<SourceObservation>,
  ): Promise<void> {
    // Replace-not-merge per FR-2: drop the existing set, then insert
    // the new one. Wrapped in a transaction so partial failure leaves
    // the prior set intact.
    const tx = this.client.transaction(
      (id: string, obs: ReadonlyArray<SourceObservation>) => {
        this.db
          .delete(sourceObservation)
          .where(eq(sourceObservation.canonicalJobId, id))
          .run();
        if (obs.length === 0) return;
        const rows = obs.map((o) => ({
          canonicalJobId: id,
          site: String(o.site),
          sourceJobId: o.sourceJobId,
          url: o.url,
          observedAt: o.observedAt,
          rawTitle: o.rawTitle ?? null,
        }));
        this.db.insert(sourceObservation).values(rows).run();
      },
    );
    tx(canonicalJobId, observations);
  }

  /**
   * Batch `putAll` (Spec 1722 / FR-13, FR-15): one transaction per chunk of
   * `batchSize` entries, prepared statements, an event-loop turn between
   * chunks. Same replace-not-merge result as one `putAll` per entry; a
   * repeated canonical id means the last entry wins. Entries whose canonical
   * row does not exist are skipped (their rows would violate the FK and roll
   * back the chunk), and a repeated `(site, sourceJobId)` within one entry
   * keeps the last observation instead of failing on the primary key.
   */
  async putAllMany(entries: ReadonlyArray<ObservationBatchEntry>): Promise<void> {
    if (entries.length === 0) return;
    const byId = new Map<string, ReadonlyArray<SourceObservation>>();
    for (const entry of entries) byId.set(entry.canonicalJobId, entry.observations);
    const ids = [...byId.keys()];

    const statements = this.getBatchStatements();
    const writeChunk = this.client.transaction((chunkIds: ReadonlyArray<string>) => {
      for (const id of chunkIds) {
        if (statements.canonicalExists.get(id) === undefined) continue;
        statements.deleteObservations.run(id);
        for (const o of byId.get(id) ?? []) {
          statements.upsertObservation.run({
            canonicalJobId: id,
            site: String(o.site),
            sourceJobId: o.sourceJobId,
            url: o.url,
            observedAt: o.observedAt,
            rawTitle: o.rawTitle ?? null,
          });
        }
      }
    });

    for (let start = 0; start < ids.length; start += this.batchSize) {
      if (start > 0) await yieldToEventLoop();
      writeChunk(ids.slice(start, start + this.batchSize));
    }
  }

  /**
   * Compile the batch statements once per connection. Column names mirror
   * `../drizzle/schema.ts`; the named parameters are the keys of
   * {@link toCanonicalJobRow}'s result.
   */
  private getBatchStatements(): SqliteBatchStatements {
    if (!this.batchStatements) {
      this.batchStatements = {
        canonicalExists: this.client.prepare(
          'SELECT 1 FROM canonical_job WHERE canonical_job_id = ?',
        ),
        upsertCanonical: this.client.prepare(
          `INSERT INTO canonical_job (
             canonical_job_id, title, company, location, description, url, merged_at,
             fields_json, sources_json, company_lc, title_lc, location_lc
           ) VALUES (
             @canonicalJobId, @title, @company, @location, @description, @url, @mergedAt,
             @fieldsJson, @sourcesJson, @companyLc, @titleLc, @locationLc
           )
           ON CONFLICT (canonical_job_id) DO UPDATE SET
             title = excluded.title,
             company = excluded.company,
             location = excluded.location,
             description = excluded.description,
             url = excluded.url,
             merged_at = excluded.merged_at,
             fields_json = excluded.fields_json,
             sources_json = excluded.sources_json,
             company_lc = excluded.company_lc,
             title_lc = excluded.title_lc,
             location_lc = excluded.location_lc`,
        ),
        deleteObservations: this.client.prepare(
          'DELETE FROM source_observation WHERE canonical_job_id = ?',
        ),
        upsertObservation: this.client.prepare(
          `INSERT INTO source_observation (
             canonical_job_id, site, source_job_id, url, observed_at, raw_title
           ) VALUES (
             @canonicalJobId, @site, @sourceJobId, @url, @observedAt, @rawTitle
           )
           ON CONFLICT (canonical_job_id, site, source_job_id) DO UPDATE SET
             url = excluded.url,
             observed_at = excluded.observed_at,
             raw_title = excluded.raw_title`,
        ),
      };
    }
    return this.batchStatements;
  }

  async listByCanonicalId(
    canonicalJobId: string,
  ): Promise<ReadonlyArray<SourceObservation>> {
    const rows = this.db
      .select()
      .from(sourceObservation)
      .where(eq(sourceObservation.canonicalJobId, canonicalJobId))
      .all();
    return rows.map((r) => ({
      site: r.site as Site,
      sourceJobId: r.sourceJobId,
      url: r.url,
      observedAt: r.observedAt,
      rawTitle: r.rawTitle ?? undefined,
    }));
  }

  async deleteByCanonicalId(canonicalJobId: string): Promise<number> {
    const result = this.db
      .delete(sourceObservation)
      .where(eq(sourceObservation.canonicalJobId, canonicalJobId))
      .run();
    return result.changes;
  }

  // ----------------------------------------------------------------------
  // Test / debug surface (not part of either interface contract).
  // ----------------------------------------------------------------------

  /**
   * Total canonical rows currently stored. Test-only diagnostic.
   */
  get size(): number {
    const row = this.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(canonicalJob)
      .all();
    return Number(row[0]?.c ?? 0);
  }

  /**
   * Drop every row + observation. Test-only — production callers SHOULD
   * use the IJobStore contract.
   */
  clear(): void {
    // FK cascade handles observations.
    this.db.delete(canonicalJob).run();
  }

  /**
   * Close the underlying SQLite connection. Tests SHOULD call this in
   * `afterEach` to release file descriptors when the backend was
   * configured with a non-`:memory:` path; for `:memory:` the GC takes
   * care of it.
   */
  close(): void {
    this.client.close();
  }
}

// =====================================================================
// Helpers
// =====================================================================

/** Prepared statements behind `upsertMany` / `putAllMany` (Spec 1722 / FR-15). */
interface SqliteBatchStatements {
  readonly canonicalExists: Database.Statement;
  readonly upsertCanonical: Database.Statement;
  readonly deleteObservations: Database.Statement;
  readonly upsertObservation: Database.Statement;
}

/**
 * Clamp a configured batch size into `[1, 5000]`; anything non-finite or
 * non-positive means {@link DEFAULT_SQLITE_BATCH_SIZE}.
 */
function resolveBatchSize(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    return DEFAULT_SQLITE_BATCH_SIZE;
  }
  return Math.min(Math.floor(raw), 5_000);
}

/**
 * Give the event loop one turn. better-sqlite3 is synchronous by design, so
 * this is the only way a long batch lets timers (NDJSON heartbeats) and
 * other requests run.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Internal row shape persisted to the `canonical_job` table. We store
 * `fields` and `sources` as JSON blobs (see service-class JSDoc point 4)
 * and derive case-folded shadow columns up-front.
 */
function toCanonicalJobRow(job: CanonicalJob) {
  return {
    canonicalJobId: job.canonicalJobId,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description ?? null,
    url: job.url,
    mergedAt: job.mergedAt,
    fieldsJson: JSON.stringify(job.fields ?? {}),
    sourcesJson: JSON.stringify(job.sources ?? []),
    companyLc: job.company.toLowerCase(),
    titleLc: job.title.toLowerCase(),
    locationLc: job.location.toLowerCase(),
  };
}

/**
 * Reconstruct a `CanonicalJob` from the row shape stored in SQLite.
 * `description` and `sources` round-trip via JSON; the contract treats
 * them as opaque payloads.
 */
function fromCanonicalJobRow(row: typeof canonicalJob.$inferSelect): CanonicalJob {
  return {
    canonicalJobId: row.canonicalJobId,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description ?? undefined,
    url: row.url,
    mergedAt: row.mergedAt,
    fields: row.fieldsJson ? (JSON.parse(row.fieldsJson) as CanonicalJob['fields']) : {},
    sources: row.sourcesJson
      ? (JSON.parse(row.sourcesJson) as CanonicalJob['sources'])
      : [],
  };
}

/**
 * Build the SQL predicate that resumes pagination after a keyset cursor.
 *
 * The canonical ordering is `merged_at DESC, canonical_job_id ASC`; to
 * "resume after cursor", we want every row strictly later in that order
 * than the cursor's tuple. In SQL that is:
 *
 *   merged_at < cursor.mergedAt
 *   OR (merged_at = cursor.mergedAt AND canonical_job_id > cursor.canonicalJobId)
 *
 * (Note the asymmetry — `<` for the DESC column, `>` for the ASC tie-break.)
 */
function buildKeysetCursorPredicate(cursor: SqliteCursor) {
  return or(
    lt(canonicalJob.mergedAt, cursor.mergedAt),
    and(
      eq(canonicalJob.mergedAt, cursor.mergedAt),
      sql`${canonicalJob.canonicalJobId} > ${cursor.canonicalJobId}`,
    ),
  );
}
