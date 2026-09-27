import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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

/**
 * Canonical id under which this backend registers with `StoreRegistry`.
 * Operators select it via `EVER_JOBS_STORE=postgres`.
 */
export const STORE_POSTGRES_PRISMA_ID = 'postgres';

/**
 * One-line description shown by `GET /api/storage` and the CLI's
 * `stores list` subcommand for operator triage.
 */
export const STORE_POSTGRES_PRISMA_DESCRIPTION =
  'Postgres production store via Prisma + pg_trgm GIN indexes (Spec 004 — prod-default)';

/**
 * Cursor envelope for Postgres keyset pagination.
 *
 * Encoded as base64-of-JSON over `{ v, mergedAt, canonicalJobId }`. The
 * envelope is wire-compatible with the SQLite backend's cursor (T08) so
 * the future `GET /api/jobs?cursor=…` endpoint does NOT fork on backend
 * type — operators can swap `EVER_JOBS_STORE=sqlite` ↔ `=postgres` and
 * outstanding cursors still parse. The `v: 1` discriminator is forward-
 * compatibility insurance: a future v2 envelope (e.g. SAFE-pointer for a
 * sharded backend) ships `v: 2` and rejects v1 cursors with
 * `ERR_STORE_INVALID_CURSOR` rather than silently misinterpreting them.
 *
 * The cursor literally encodes the last-yielded row's ordering tuple so
 * page N+1 resumes via `(merged_at < cursor.mergedAt) OR (merged_at =
 * cursor.mergedAt AND canonical_job_id > cursor.canonicalJobId)` — note
 * the asymmetry, `<` for the DESC column and `>` for the ASC tie-break.
 * This predicate is index-friendly: the planner picks
 * `idx_canonical_job_merged_at_id` for an index seek of O(log N) rather
 * than the seq scan + sort an OFFSET-based pager would force.
 */
interface PostgresCursor {
  readonly v: 1;
  readonly mergedAt: string;
  readonly canonicalJobId: string;
}

const POSTGRES_CURSOR_VERSION = 1;

/**
 * Error type thrown for malformed pagination cursors. Carries the
 * Spec 004 §7.3 wire code so callers and the conformance suite can
 * `expect(...).toMatchObject({ code: ERR_STORE_INVALID_CURSOR })`
 * without coupling to a specific class.
 */
class PostgresStoreCursorError extends Error {
  readonly code: string = ERR_STORE_INVALID_CURSOR;

  constructor(detail: string) {
    super(`Malformed JobStoreQuery cursor (${detail})`);
    this.name = 'PostgresStoreCursorError';
  }
}

function encodeCursor(cursor: PostgresCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

/**
 * Decode and validate the opaque cursor. Surface `ERR_STORE_INVALID_CURSOR`
 * for every reject path: not-base64, not-json, missing fields, wrong
 * version, non-string components. Silent fallback to "page 1" is the
 * failure mode this code path was created to prevent — a cursor-format
 * drift would silently desync paginating callers.
 */
function decodeCursor(raw: string): PostgresCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new PostgresStoreCursorError('not base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new PostgresStoreCursorError('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PostgresStoreCursorError('not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== POSTGRES_CURSOR_VERSION) {
    throw new PostgresStoreCursorError(`unsupported version ${String(obj.v)}`);
  }
  if (typeof obj.mergedAt !== 'string' || obj.mergedAt.length === 0) {
    throw new PostgresStoreCursorError('mergedAt is not a non-empty string');
  }
  if (typeof obj.canonicalJobId !== 'string' || obj.canonicalJobId.length === 0) {
    throw new PostgresStoreCursorError('canonicalJobId is not a non-empty string');
  }
  return {
    v: POSTGRES_CURSOR_VERSION,
    mergedAt: obj.mergedAt,
    canonicalJobId: obj.canonicalJobId,
  };
}

/**
 * Resolve the effective `limit` for a query. Mirrors the in-memory and
 * sqlite-drizzle backends: default to {@link JOB_STORE_QUERY_DEFAULT_LIMIT}
 * when omitted / non-finite / non-positive; clamp to
 * {@link JOB_STORE_QUERY_MAX_LIMIT}. Behaviour MUST match across backends
 * so the conformance suite's limit cases pass uniformly.
 */
function resolveLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return JOB_STORE_QUERY_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), JOB_STORE_QUERY_MAX_LIMIT);
}

// =====================================================================
// Structural Prisma client surface
// =====================================================================

/**
 * Row shape persisted to the `canonical_job` table. Mirrors the
 * Prisma-generated `CanonicalJob` model. Declared structurally here so
 * this package's TS surface does NOT depend on a successful
 * `prisma generate` — the typed client is a code-gen artefact (it lives
 * under `node_modules/.prisma/client` after `prisma generate` runs)
 * which the scheduled-task sandbox cannot produce. CI runs
 * `prisma generate` before tests, and the real generated client
 * structurally satisfies this interface.
 */
interface PrismaCanonicalJobRow {
  canonicalJobId: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  url: string;
  mergedAt: Date;
  fields: unknown;
  sources: unknown;
}

/** Row shape persisted to the `source_observation` table. */
interface PrismaSourceObservationRow {
  canonicalJobId: string;
  site: string;
  sourceJobId: string;
  url: string;
  observedAt: Date;
  rawTitle: string | null;
}

/**
 * Narrowed Prisma client surface this store relies on. The real
 * `PrismaClient` produced by `prisma generate` against
 * `prisma/schema.prisma` structurally satisfies this — the fields
 * `canonicalJob` / `sourceObservation` and methods `upsert / findUnique /
 * findMany / delete / deleteMany / createMany / count` are all standard
 * Prisma model-delegate API.
 *
 * Why a structural interface instead of `import type { PrismaClient }
 * from '@prisma/client'`?
 *
 *   1. The typed client is a code-gen artefact. Without `prisma generate`
 *      it does not exist; ts-jest in the scheduled-task sandbox would
 *      fail to type-check this file. The structural interface compiles
 *      regardless.
 *   2. It pins the contract this store actually uses. If a future Prisma
 *      major version renames a delegate method, the failure surfaces
 *      here, not at every call-site.
 *   3. It lets test fakes and mocks satisfy the contract trivially.
 */
export interface PrismaJobsClient {
  canonicalJob: {
    upsert(args: {
      where: { canonicalJobId: string };
      create: PrismaCanonicalJobRow;
      update: Partial<Omit<PrismaCanonicalJobRow, 'canonicalJobId'>>;
    }): Promise<PrismaCanonicalJobRow>;

    findUnique(args: {
      where: { canonicalJobId: string };
    }): Promise<PrismaCanonicalJobRow | null>;

    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      take?: number;
    }): Promise<PrismaCanonicalJobRow[]>;

    delete(args: {
      where: { canonicalJobId: string };
    }): Promise<PrismaCanonicalJobRow>;

    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };

  sourceObservation: {
    createMany(args: {
      data: ReadonlyArray<PrismaSourceObservationRow>;
    }): Promise<{ count: number }>;

    findMany(args: {
      where?: Record<string, unknown>;
    }): Promise<PrismaSourceObservationRow[]>;

    deleteMany(args: {
      where?: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };

  /**
   * Callback-form transaction. Prisma's `$transaction(fn)` runs `fn`
   * inside a single Postgres transaction and rolls back on throw.
   *
   * `options` overrides the client-level `transactionOptions` for one call
   * (Prisma's own signature). Prisma's defaults are `maxWait: 2000` and
   * `timeout: 5000` ms, which is why the batch paths below do not use an
   * interactive transaction at all (Spec 1722 / FR-12).
   */
  $transaction<T>(
    fn: (tx: PrismaJobsClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;

  /**
   * Raw parameterised query (Prisma's standard client API). Used by the
   * set-based batch writes (Spec 1722 / FR-12, FR-13): values are sent as
   * bind parameters, never interpolated into the SQL text.
   */
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;

  /**
   * Release the underlying connection pool. Tests SHOULD await this in
   * `afterAll` to avoid Jest's "open handle" leak warning.
   */
  $disconnect(): Promise<void>;
}

// =====================================================================
// Configuration + DI tokens
// =====================================================================

/**
 * Configuration for the Postgres backend. The consumer constructs the
 * `PrismaClient` (or a structural fake) and passes it via this config —
 * the store itself does NOT construct or own the client, so its runtime
 * imports stay free of `@prisma/client`.
 *
 * Production wiring (`apps/api`):
 *
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * const prisma = new PrismaClient({
 *   datasourceUrl: process.env.DATABASE_URL,
 * });
 *
 * StoreModule.forActive(process.env.EVER_JOBS_STORE ?? 'postgres', {
 *   backends: [PostgresPrismaJobStore],
 *   providers: [
 *     {
 *       provide: STORE_POSTGRES_PRISMA_CONFIG,
 *       useValue: { client: prisma },
 *     },
 *   ],
 * });
 * ```
 */
export interface StorePostgresPrismaConfig {
  /**
   * Pre-constructed Prisma client. The store does NOT manage the
   * lifecycle of this object — operator-owned wiring is responsible for
   * calling `prisma.$disconnect()` at process-shutdown.
   */
  readonly client: PrismaJobsClient;

  /**
   * Rows per statement for `upsertMany` / `putAllMany` (Spec 1722 / FR-12).
   * Defaults to {@link DEFAULT_POSTGRES_BATCH_SIZE}; the API binds it from
   * `EVER_JOBS_STORE_BATCH_SIZE`.
   */
  readonly batchSize?: number;
}

/**
 * Default rows per batch statement. 500 canonical jobs with descriptions is
 * a ~2–3 MB `jsonb` parameter — one round-trip that Postgres parses and
 * upserts in well under a second — while keeping each statement's row locks
 * short-lived.
 */
export const DEFAULT_POSTGRES_BATCH_SIZE = 500;

/**
 * NestJS DI token for {@link StorePostgresPrismaConfig}. Bind it via a
 * provider in the consuming app's root module so the Prisma client is
 * resolved from `DATABASE_URL` at bootstrap. The token is `@Optional()`
 * on the constructor — when absent, the constructor throws a
 * configuration error fail-fast so a misconfigured deployment cannot
 * silently fall back to a no-op or another backend.
 */
export const STORE_POSTGRES_PRISMA_CONFIG = 'STORE_POSTGRES_PRISMA_CONFIG';

// =====================================================================
// Service
// =====================================================================

/**
 * Postgres-backed reference implementation of `IJobStore` +
 * `IJobObservationStore` (Spec 004 / Phase 4 / T10).
 *
 * Design choices:
 *
 *   1. **Asynchronous Prisma driver.** Postgres is over-the-wire — every
 *      query is genuinely async. The IJobStore methods stay async to
 *      match the contract; no fake-async wrappers needed.
 *
 *   2. **Structural Prisma client surface ({@link PrismaJobsClient}).**
 *      The store does NOT import `@prisma/client` at runtime; it
 *      receives a pre-constructed client via DI and types it
 *      structurally. Keeps this package compileable in environments
 *      that haven't run `prisma generate` yet (the scheduled-task
 *      sandbox) without weakening the API surface in environments
 *      that have.
 *
 *   3. **Keyset cursor pagination.** Spec 004 / NFR-1 budgets <50 ms
 *      p95 read on Postgres. Offset paging fails this at scale (every
 *      page walks the skipped prefix); keyset paging stays O(log N) by
 *      seeking on the composite `(merged_at DESC, canonical_job_id ASC)`
 *      index from `0_init/migration.sql`. See
 *      {@link buildCursorWherePredicate}.
 *
 *   4. **`pg_trgm` GIN indexes for `ILIKE`.** The migration creates
 *      `idx_canonical_job_company_trgm` / `_title_trgm` / `_location_trgm`
 *      with the `gin_trgm_ops` opclass. Prisma's `{ company: { contains:
 *      'foo', mode: 'insensitive' } }` compiles to `company ILIKE
 *      '%foo%'`, which the planner can satisfy via a GIN index seek
 *      (vs the seq scan it would otherwise fall back to).
 *
 *   5. **`jsonb` for `fields` / `sources`.** Stored as Postgres `jsonb`
 *      (binary representation, GIN-indexable, faster reads) per the
 *      schema decision in T09. The store round-trips through Prisma's
 *      `Json` type, which accepts arbitrary JSON-serialisable values
 *      and returns the same shape on read.
 *
 *   6. **FK CASCADE owned by Postgres.** The `source_observation.
 *      canonical_job_id` FK with `ON DELETE CASCADE` means a single
 *      `prisma.canonicalJob.delete` drops every attached observation
 *      atomically. Postgres enforces FKs unconditionally; no PRAGMA
 *      toggle (unlike SQLite).
 *
 *   7. **Eager-fail constructor.** When the consumer forgets to bind
 *      `STORE_POSTGRES_PRISMA_CONFIG`, the constructor throws at
 *      bootstrap. Spec 004 §7.3 / FR-3 explicitly says misconfigured
 *      deployments MUST fail fast — silent fallback to in-memory mode
 *      would let the prod cohort silently disappear.
 *
 *   8. **Set-based batch writes (Spec 1722 / FR-12, FR-13).** `upsertMany`
 *      and `putAllMany` send one raw statement per chunk of `batchSize`
 *      rows, fed by a single `jsonb` parameter, instead of one Prisma call
 *      per row inside an interactive transaction (which timed out at
 *      ~10 000 rows under Prisma's default 5 s limit).
 */
@StorePlugin({
  id: STORE_POSTGRES_PRISMA_ID,
  description: STORE_POSTGRES_PRISMA_DESCRIPTION,
})
@Injectable()
export class PostgresPrismaJobStore implements IJobStore, IJobObservationStore {
  private readonly logger = new Logger(PostgresPrismaJobStore.name);

  private readonly client: PrismaJobsClient;
  private readonly batchSize: number;

  constructor(
    @Optional()
    @Inject(STORE_POSTGRES_PRISMA_CONFIG)
    config?: StorePostgresPrismaConfig,
  ) {
    if (!config?.client) {
      // Spec 004 / §7.3 / FR-3: bootstrap MUST fail fast on a
      // misconfigured store rather than silently fall back to an empty
      // in-memory cohort. The error message names the missing token so
      // the operator can fix it without grepping the source tree.
      throw new Error(
        '[PostgresPrismaJobStore] requires a Prisma client. Bind ' +
          'STORE_POSTGRES_PRISMA_CONFIG with a `{ client: new PrismaClient(...) }` ' +
          'provider in apps/api root module before activating this backend ' +
          '(Spec 004 / §7.3 / FR-3).',
      );
    }
    this.client = config.client;
    this.batchSize = resolveBatchSize(config.batchSize);
  }

  // ----------------------------------------------------------------------
  // IJobStore
  // ----------------------------------------------------------------------

  async upsert(job: CanonicalJob): Promise<CanonicalJob> {
    const row = toPrismaCanonicalJobRow(job);
    await this.client.canonicalJob.upsert({
      where: { canonicalJobId: row.canonicalJobId },
      create: row,
      update: {
        title: row.title,
        company: row.company,
        location: row.location,
        description: row.description,
        url: row.url,
        mergedAt: row.mergedAt,
        fields: row.fields,
        sources: row.sources,
      },
    });
    return job;
  }

  async upsertMany(
    jobs: ReadonlyArray<CanonicalJob>,
  ): Promise<{ inserted: number; updated: number }> {
    if (jobs.length === 0) {
      return { inserted: 0, updated: 0 };
    }
    // Spec 1722 / FR-12 — set-based, one statement per chunk.
    //
    // The previous shape (one Prisma `upsert` per row inside ONE interactive
    // `$transaction`) hit Prisma's default 5 s interactive-transaction
    // timeout at ~10 000 rows (P2028), so every list-mode persist failed.
    // A single `INSERT … ON CONFLICT DO UPDATE` statement per chunk needs no
    // interactive transaction, is atomic per chunk, and costs one
    // round-trip per `batchSize` rows instead of one per row.
    //
    // Last occurrence of a repeated id wins (what sequential upserts would
    // leave behind; `ON CONFLICT` cannot touch one row twice in a statement),
    // and rows are written in id order so two concurrent persists lock
    // overlapping rows in the same order and cannot deadlock.
    const rows = [...lastById(jobs, (j) => j.canonicalJobId).values()]
      .sort((a, b) => compareIds(a.canonicalJobId, b.canonicalJobId))
      .map(toCanonicalJobSqlRow);

    let inserted = 0;
    for (let start = 0; start < rows.length; start += this.batchSize) {
      const chunk = rows.slice(start, start + this.batchSize);
      const result = await this.client.$queryRawUnsafe<
        Array<{ inserted: number; affected: number }>
      >(UPSERT_CANONICAL_CHUNK_SQL, toJsonbParam(chunk));
      inserted += Number(result[0]?.inserted ?? 0);
    }
    // A repeated id is an update of the row its first occurrence inserted,
    // so `inserted + updated` is always the input length.
    return { inserted, updated: jobs.length - inserted };
  }

  async getById(id: string): Promise<CanonicalJob | null> {
    const row = await this.client.canonicalJob.findUnique({
      where: { canonicalJobId: id },
    });
    if (row === null) return null;
    return fromPrismaCanonicalJobRow(row);
  }

  async findByCanonicalId(canonicalJobId: string): Promise<CanonicalJob | null> {
    return this.getById(canonicalJobId);
  }

  async listByQuery(query: JobStoreQuery): Promise<JobStorePage<CanonicalJob>> {
    const limit = resolveLimit(query.limit);
    const cursor =
      typeof query.cursor === 'string' ? decodeCursor(query.cursor) : undefined;

    const where = buildWhereClause(query, cursor);

    const rows = await this.client.canonicalJob.findMany({
      where,
      orderBy: [{ mergedAt: 'desc' }, { canonicalJobId: 'asc' }],
      take: limit,
    });

    const items = rows.map(fromPrismaCanonicalJobRow);

    if (items.length < limit) {
      // Last page — no cursor.
      return { items };
    }
    // Probe one extra row with a follow-up keyset query to know whether
    // there's MORE data after this page. Cheaper than `OFFSET` + a
    // duplicate scan; the index seek is O(log N).
    const last = items[items.length - 1];
    const probeCursor: PostgresCursor = {
      v: POSTGRES_CURSOR_VERSION,
      mergedAt: last.mergedAt,
      canonicalJobId: last.canonicalJobId,
    };
    const moreWhere = buildWhereClause(query, probeCursor);
    const more = await this.client.canonicalJob.findMany({
      where: moreWhere,
      orderBy: [{ mergedAt: 'desc' }, { canonicalJobId: 'asc' }],
      take: 1,
    });

    if (more.length === 0) {
      return { items };
    }
    return {
      items,
      nextCursor: encodeCursor(probeCursor),
    };
  }

  async delete(id: string): Promise<boolean> {
    // FK ON DELETE CASCADE drops attached observations automatically
    // (Postgres enforces FKs unconditionally — no PRAGMA toggle).
    // Prisma's `delete` throws when the row doesn't exist; we want
    // `false` instead, so check first via a count.
    const exists = await this.client.canonicalJob.count({
      where: { canonicalJobId: id },
    });
    if (exists === 0) return false;
    await this.client.canonicalJob.delete({ where: { canonicalJobId: id } });
    return true;
  }

  // ----------------------------------------------------------------------
  // IJobObservationStore
  // ----------------------------------------------------------------------

  async putAll(
    canonicalJobId: string,
    observations: ReadonlyArray<SourceObservation>,
  ): Promise<void> {
    // Replace-not-merge per FR-2: drop the existing set, then insert the
    // new one. Wrapped in a transaction so partial failure leaves the
    // prior set intact.
    await this.client.$transaction(async (tx) => {
      await tx.sourceObservation.deleteMany({
        where: { canonicalJobId },
      });
      if (observations.length === 0) return;
      const data: PrismaSourceObservationRow[] = observations.map((o) => ({
        canonicalJobId,
        site: String(o.site),
        sourceJobId: o.sourceJobId,
        url: o.url,
        observedAt: new Date(o.observedAt),
        rawTitle: o.rawTitle ?? null,
      }));
      await tx.sourceObservation.createMany({ data });
    });
  }

  /**
   * Batch `putAll` (Spec 1722 / FR-13) — one statement per chunk of
   * `batchSize` canonical ids, no interactive transaction.
   *
   * Replace-not-merge per canonical id, without rewriting what did not
   * change: observations no longer present are deleted, new ones inserted,
   * and an existing one is updated only when `url`, `observed_at` or
   * `raw_title` differ. The previous aggregator path deleted and re-inserted
   * every observation of every job on every run, one transaction per job,
   * all started at once — which exhausted the pool at list-mode size.
   *
   * Entries whose canonical row does not exist are skipped (their
   * observations would violate the FK and fail the whole chunk). A repeated
   * canonical id: the last entry wins, as sequential `putAll` calls would.
   * An entry with an unparsable `observedAt` is skipped whole and its stored
   * set left as it was — what its own `putAll` did (the transaction failed):
   * replacing the set without that observation would delete the stored one.
   */
  async putAllMany(entries: ReadonlyArray<ObservationBatchEntry>): Promise<void> {
    if (entries.length === 0) return;
    const byId = new Map<string, ReadonlyArray<SourceObservation>>();
    for (const entry of entries) byId.set(entry.canonicalJobId, entry.observations);
    const ids = [...byId.keys()].sort(compareIds);

    let skipped = 0;
    for (let start = 0; start < ids.length; start += this.batchSize) {
      const chunkIds: string[] = [];
      const rows: ObservationSqlRow[] = [];
      for (const canonicalJobId of ids.slice(start, start + this.batchSize)) {
        // Within one canonical id the (site, sourceJobId) primary key must be
        // unique in a single statement: the last observation wins.
        const observations = lastById(
          byId.get(canonicalJobId) ?? [],
          (o) => `${String(o.site)}\u0000${o.sourceJobId}`,
        );
        const entryRows: ObservationSqlRow[] = [];
        let valid = true;
        for (const o of observations.values()) {
          // `observedAt` is the source's own posting date when it had one.
          // An unparsable value fails this entry only (see above), not the chunk.
          const observedAt = isoOrUndefined(o.observedAt);
          if (observedAt === undefined) {
            valid = false;
            break;
          }
          entryRows.push({
            canonical_job_id: canonicalJobId,
            site: String(o.site),
            source_job_id: o.sourceJobId,
            url: o.url,
            observed_at: observedAt,
            raw_title: o.rawTitle ?? null,
          });
        }
        if (!valid) {
          skipped++;
          continue;
        }
        chunkIds.push(canonicalJobId);
        rows.push(...entryRows);
      }
      if (chunkIds.length === 0) continue;
      await this.client.$queryRawUnsafe(
        REPLACE_OBSERVATIONS_CHUNK_SQL,
        toJsonbParam(chunkIds),
        toJsonbParam(rows),
      );
    }
    if (skipped > 0) {
      this.logger.warn(
        `putAllMany: ${skipped} of ${ids.length} observation sets left unchanged (an unparsable observedAt)`,
      );
    }
  }

  async listByCanonicalId(
    canonicalJobId: string,
  ): Promise<ReadonlyArray<SourceObservation>> {
    const rows = await this.client.sourceObservation.findMany({
      where: { canonicalJobId },
    });
    return rows.map((r) => ({
      site: r.site as Site,
      sourceJobId: r.sourceJobId,
      url: r.url,
      observedAt: r.observedAt instanceof Date
        ? r.observedAt.toISOString()
        : String(r.observedAt),
      rawTitle: r.rawTitle ?? undefined,
    }));
  }

  async deleteByCanonicalId(canonicalJobId: string): Promise<number> {
    const result = await this.client.sourceObservation.deleteMany({
      where: { canonicalJobId },
    });
    return result.count;
  }

  // ----------------------------------------------------------------------
  // Test / debug surface (not part of either interface contract).
  // ----------------------------------------------------------------------

  /**
   * Total canonical rows currently stored. Test-only diagnostic.
   */
  async size(): Promise<number> {
    return this.client.canonicalJob.count();
  }
}

// =====================================================================
// Batch SQL (Spec 1722 / FR-12, FR-13)
// =====================================================================

/**
 * Upsert one chunk of canonical jobs. `$1` is a JSON array of
 * {@link CanonicalJobSqlRow}; one `jsonb` parameter per chunk keeps the
 * statement far below Postgres's 65 535 bind-parameter limit whatever the
 * chunk size. `xmax = 0` is true exactly for rows this statement inserted,
 * which yields the inserted/updated split without a pre-read.
 */
export const UPSERT_CANONICAL_CHUNK_SQL = `
WITH incoming AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS r(
    canonical_job_id text,
    title text,
    company text,
    location text,
    description text,
    url text,
    merged_at timestamptz,
    fields_json jsonb,
    sources_json jsonb
  )
), upserted AS (
  INSERT INTO "canonical_job" (
    "canonical_job_id", "title", "company", "location", "description",
    "url", "merged_at", "fields_json", "sources_json"
  )
  SELECT canonical_job_id, title, company, location, description, url, merged_at,
         COALESCE(fields_json, '{}'::jsonb), COALESCE(sources_json, '[]'::jsonb)
  FROM incoming
  ORDER BY canonical_job_id
  ON CONFLICT ("canonical_job_id") DO UPDATE SET
    "title" = EXCLUDED."title",
    "company" = EXCLUDED."company",
    "location" = EXCLUDED."location",
    "description" = EXCLUDED."description",
    "url" = EXCLUDED."url",
    "merged_at" = EXCLUDED."merged_at",
    "fields_json" = EXCLUDED."fields_json",
    "sources_json" = EXCLUDED."sources_json"
  RETURNING (xmax = 0) AS inserted
)
SELECT (COUNT(*) FILTER (WHERE inserted))::int AS inserted, COUNT(*)::int AS affected
FROM upserted`;

/**
 * Replace the observation sets of one chunk of canonical ids. `$1` is the
 * JSON array of canonical ids in the chunk (including ids whose new set is
 * empty), `$2` the JSON array of {@link ObservationSqlRow}.
 *
 * The two data-modifying CTEs touch disjoint rows — `removed` only rows
 * absent from `incoming`, `written` only rows present in it — so running them
 * in one statement is well-defined. `written` skips rows whose values did not
 * change, so a re-persist of an unchanged corpus rewrites nothing.
 */
export const REPLACE_OBSERVATIONS_CHUNK_SQL = `
WITH ids AS (
  SELECT DISTINCT t.id AS canonical_job_id
  FROM jsonb_array_elements_text($1::jsonb) AS t(id)
), incoming AS (
  SELECT r.canonical_job_id, r.site, r.source_job_id, r.url, r.observed_at, r.raw_title
  FROM jsonb_to_recordset($2::jsonb) AS r(
    canonical_job_id text,
    site text,
    source_job_id text,
    url text,
    observed_at timestamptz,
    raw_title text
  )
  WHERE EXISTS (
    SELECT 1 FROM "canonical_job" c WHERE c."canonical_job_id" = r.canonical_job_id
  )
), removed AS (
  DELETE FROM "source_observation" o
  USING ids
  WHERE o."canonical_job_id" = ids.canonical_job_id
    AND NOT EXISTS (
      SELECT 1 FROM incoming i
      WHERE i.canonical_job_id = o."canonical_job_id"
        AND i.site = o."site"
        AND i.source_job_id = o."source_job_id"
    )
  RETURNING 1
), written AS (
  INSERT INTO "source_observation" (
    "canonical_job_id", "site", "source_job_id", "url", "observed_at", "raw_title"
  )
  SELECT canonical_job_id, site, source_job_id, url, observed_at, raw_title
  FROM incoming
  ORDER BY canonical_job_id, site, source_job_id
  ON CONFLICT ("canonical_job_id", "site", "source_job_id") DO UPDATE SET
    "url" = EXCLUDED."url",
    "observed_at" = EXCLUDED."observed_at",
    "raw_title" = EXCLUDED."raw_title"
  WHERE ("source_observation"."url", "source_observation"."observed_at", "source_observation"."raw_title")
    IS DISTINCT FROM (EXCLUDED."url", EXCLUDED."observed_at", EXCLUDED."raw_title")
  RETURNING 1
)
SELECT (SELECT COUNT(*) FROM removed)::int AS removed,
       (SELECT COUNT(*) FROM written)::int AS written`;

/** Row shape of {@link UPSERT_CANONICAL_CHUNK_SQL}'s `jsonb` parameter. */
interface CanonicalJobSqlRow {
  canonical_job_id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  url: string;
  merged_at: string;
  fields_json: unknown;
  sources_json: unknown;
}

/** Row shape of {@link REPLACE_OBSERVATIONS_CHUNK_SQL}'s `$2` parameter. */
interface ObservationSqlRow {
  canonical_job_id: string;
  site: string;
  source_job_id: string;
  url: string;
  observed_at: string;
  raw_title: string | null;
}

/**
 * Clamp a configured batch size into `[1, 5000]`; anything non-finite or
 * non-positive means the default.
 */
function resolveBatchSize(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    return DEFAULT_POSTGRES_BATCH_SIZE;
  }
  return Math.min(Math.floor(raw), 5_000);
}

/** Collapse repeated keys, keeping the LAST value (insertion order of first sighting). */
function lastById<T>(items: ReadonlyArray<T>, keyOf: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) out.set(keyOf(item), item);
  return out;
}

/** Code-unit order; only has to be the same for every caller. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * An ISO-8601 timestamp for a `timestamptz` column (Postgres parses ISO
 * strings reliably), or `undefined` when `Date` cannot parse the value.
 */
function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** {@link isoOrUndefined} with a fallback for the unparsable case. */
function toIsoTimestamp(value: unknown, fallback: () => string): string {
  return isoOrUndefined(value) ?? fallback();
}

function toCanonicalJobSqlRow(job: CanonicalJob): CanonicalJobSqlRow {
  return {
    canonical_job_id: job.canonicalJobId,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description ?? null,
    url: job.url,
    // `mergedAt` is the merge time; the dedup engine always stamps a valid
    // ISO string, so the fallback is "now", i.e. when this merge is written.
    merged_at: toIsoTimestamp(job.mergedAt, () => new Date().toISOString()),
    fields_json: job.fields ?? {},
    sources_json: job.sources ?? [],
  };
}

/**
 * Serialise a batch for a `$n::jsonb` parameter. Postgres `text` and `jsonb`
 * cannot hold U+0000, and scraped descriptions occasionally carry one; left
 * in, a single such job would fail its whole chunk, so the character is
 * dropped from every string value.
 */
function toJsonbParam(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'string' && v.includes('\u0000') ? v.split('\u0000').join('') : v,
  );
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Translate a `CanonicalJob` (interface contract — `mergedAt` is an
 * ISO-8601 string) to the Prisma row shape (`mergedAt` is a `Date`).
 * Postgres's `timestamptz` round-trips losslessly via Prisma's
 * `DateTime` mapping.
 */
function toPrismaCanonicalJobRow(job: CanonicalJob): PrismaCanonicalJobRow {
  return {
    canonicalJobId: job.canonicalJobId,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description ?? null,
    url: job.url,
    mergedAt: new Date(job.mergedAt),
    fields: job.fields ?? {},
    sources: job.sources ?? [],
  };
}

/**
 * Reconstruct a `CanonicalJob` from the row shape stored in Postgres.
 * `description` survives `null → undefined` conversion to match the
 * contract; `fields` and `sources` round-trip via Prisma's `Json` /
 * `JsonB` mapping which yields plain JS objects/arrays.
 *
 * `mergedAt` MUST come back as an ISO-8601 string per the
 * `CanonicalJob` interface, so we always normalise via
 * `Date.toISOString()` regardless of whether the driver yielded a
 * native Date or a string.
 */
function fromPrismaCanonicalJobRow(row: PrismaCanonicalJobRow): CanonicalJob {
  return {
    canonicalJobId: row.canonicalJobId,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description ?? undefined,
    url: row.url,
    mergedAt: row.mergedAt instanceof Date
      ? row.mergedAt.toISOString()
      : String(row.mergedAt),
    fields: (row.fields ?? {}) as CanonicalJob['fields'],
    sources: (row.sources ?? []) as CanonicalJob['sources'],
  };
}

/**
 * Build the Prisma `where` clause for `listByQuery`. Combines:
 *
 *   - `company` / `title` / `location`: `ILIKE '%term%'` via Prisma's
 *     `{ contains, mode: 'insensitive' }`. Backed by the `pg_trgm` GIN
 *     trigram indexes from `0_init/migration.sql`.
 *   - `since`: lower-bound (inclusive) on `mergedAt`.
 *   - `cursor`: keyset predicate to resume after a previous page.
 *
 * Returns `undefined` when no filters and no cursor were supplied so
 * the planner sees a clean ORDER BY ... LIMIT ... query.
 */
function buildWhereClause(
  query: JobStoreQuery,
  cursor: PostgresCursor | undefined,
): Record<string, unknown> | undefined {
  const conditions: Record<string, unknown>[] = [];

  if (query.company) {
    conditions.push({
      company: { contains: query.company, mode: 'insensitive' },
    });
  }
  if (query.title) {
    conditions.push({
      title: { contains: query.title, mode: 'insensitive' },
    });
  }
  if (query.location) {
    conditions.push({
      location: { contains: query.location, mode: 'insensitive' },
    });
  }
  if (query.since instanceof Date) {
    conditions.push({ mergedAt: { gte: query.since } });
  }
  if (cursor) {
    conditions.push(buildCursorWherePredicate(cursor));
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { AND: conditions };
}

/**
 * Build the Prisma `where` predicate that resumes pagination after a
 * keyset cursor. Equivalent SQL:
 *
 *   merged_at < cursor.mergedAt
 *   OR (merged_at = cursor.mergedAt AND canonical_job_id > cursor.canonicalJobId)
 *
 * (Note the asymmetry — `<` for the DESC column, `>` for the ASC
 * tie-break.) The Postgres planner picks `idx_canonical_job_merged_at_id`
 * for this predicate and seeks via a single B-tree probe regardless of
 * how deep the page is; this is what keeps `listByQuery` inside Spec 004
 * NFR-1's <50 ms p95 budget on multi-million-row cohorts.
 */
function buildCursorWherePredicate(
  cursor: PostgresCursor,
): Record<string, unknown> {
  const cursorMergedAt = new Date(cursor.mergedAt);
  return {
    OR: [
      { mergedAt: { lt: cursorMergedAt } },
      {
        mergedAt: cursorMergedAt,
        canonicalJobId: { gt: cursor.canonicalJobId },
      },
    ],
  };
}
