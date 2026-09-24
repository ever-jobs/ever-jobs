import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  ERR_STORE_INVALID_CURSOR,
  IStoreMetadata,
  STORE_PLUGIN_METADATA_KEY,
  Site,
} from '@ever-jobs/models';
import { runStoreConformance } from '../../../plugin/src/store/__tests__/conformance';
import {
  PostgresPrismaJobStore,
  PrismaJobsClient,
  STORE_POSTGRES_PRISMA_CONFIG,
  STORE_POSTGRES_PRISMA_DESCRIPTION,
  STORE_POSTGRES_PRISMA_ID,
  StorePostgresPrismaModule,
} from '../src';

/**
 * Spec 004 / Phase 4 / T09 + T10 — Postgres (Prisma) backend tests.
 *
 * Test surface — split into two layers:
 *
 *   1. **Always-on (no Postgres required)**
 *      - `@StorePlugin` metadata wiring (raw `Reflect.getMetadata` AND
 *        `Reflector.get` resolve to `{ id: 'postgres', description }`).
 *      - Constructor fails fast with a structured error when
 *        `STORE_POSTGRES_PRISMA_CONFIG` is unbound (Spec 004 §7.3 /
 *        FR-3 — bootstrap MUST fail rather than silently fall back).
 *      - `StorePostgresPrismaModule` resolves `PostgresPrismaJobStore`
 *        as a NestJS singleton when given a structural fake client.
 *
 *   2. **Gated on `RUN_PG_TESTS=1`** (Testcontainers-backed)
 *      - Full {@link runStoreConformance} suite re-run against a
 *        Testcontainers `postgres:16-alpine` instance.
 *      - Cursor envelope: keyset cursor literally encodes
 *        `{ v: 1, mergedAt, canonicalJobId }` and round-trips.
 *      - Cursor decode rejects all invalid shapes (8 cases via
 *        `it.each`).
 *      - **FK ON DELETE CASCADE** owned by Postgres — drop the
 *        canonical row and verify the underlying `source_observation`
 *        rows are gone.
 *      - **Keyset pagination tie-break** — many rows sharing identical
 *        `mergedAt` MUST resume deterministically across pages.
 *      - **`pg_trgm` ILIKE substring filter** — round-trip a
 *        case-insensitive substring search over a small seeded cohort
 *        and assert the index-friendly behaviour.
 *      - **`jsonb` round-trip** — `fields` and `sources` survive
 *        write/read with nested data preserved.
 *
 * The gated layer uses dynamic `require()` for `testcontainers` and
 * `@prisma/client` so the file parses without those packages installed
 * (the scheduled-task sandbox lacks `node_modules`; the typed
 * `PrismaClient` is a `prisma generate` artefact that lives only after
 * CI's install step). When `RUN_PG_TESTS` is unset, every Postgres-
 * backed assertion is `describe.skip`-ped; the always-on assertions
 * still run.
 */

// =====================================================================
// Always-on tests (no Postgres required).
// =====================================================================

describe('PostgresPrismaJobStore — always-on contract', () => {
  describe('@StorePlugin metadata', () => {
    it('exposes { id, description } via raw Reflect.getMetadata', () => {
      const meta = Reflect.getMetadata(
        STORE_PLUGIN_METADATA_KEY,
        PostgresPrismaJobStore,
      ) as IStoreMetadata | undefined;
      expect(meta).toEqual({
        id: STORE_POSTGRES_PRISMA_ID,
        description: STORE_POSTGRES_PRISMA_DESCRIPTION,
      });
    });

    it('exposes { id, description } via NestJS Reflector', () => {
      const reflector = new Reflector();
      const meta = reflector.get<IStoreMetadata>(
        STORE_PLUGIN_METADATA_KEY,
        PostgresPrismaJobStore,
      );
      expect(meta?.id).toBe('postgres');
      expect(meta?.description).toBe(STORE_POSTGRES_PRISMA_DESCRIPTION);
    });
  });

  describe('constructor configuration', () => {
    it('throws fail-fast when STORE_POSTGRES_PRISMA_CONFIG is unbound', () => {
      // Spec 004 §7.3 / FR-3: a misconfigured store MUST surface at
      // bootstrap rather than silently fall back to in-memory mode.
      // Pin the contract: zero-arg construction throws a structured Error
      // whose message names the missing token so operators don't have to
      // grep the source tree to fix it.
      expect(() => new PostgresPrismaJobStore()).toThrow(
        /STORE_POSTGRES_PRISMA_CONFIG/,
      );
    });

    it('throws when config is supplied but client is missing', () => {
      // Defence-in-depth: a partial config object (e.g. a future
      // additional field but the wrong shape) MUST also fail fast.
      expect(
        () =>
          new PostgresPrismaJobStore(
            // Cast to bypass the readonly/optional contract — we're
            // testing what happens when the contract is violated.
            { client: undefined } as never,
          ),
      ).toThrow(/STORE_POSTGRES_PRISMA_CONFIG/);
    });
  });

  describe('StorePostgresPrismaModule', () => {
    it('resolves PostgresPrismaJobStore as a NestJS singleton when the service + config are provided in the same scope', async () => {
      // NestJS DI resolves a provider's dependencies in the module that
      // declares the provider — `StorePostgresPrismaModule` does NOT
      // ship a config provider on purpose (the consumer owns the
      // PrismaClient lifecycle). The test mirrors what `apps/api`
      // would do at bootstrap: bind the service and the config in the
      // same module scope so the `@Optional() @Inject(TOKEN)` parameter
      // resolves to the test's structural fake.
      const fakeClient: PrismaJobsClient = makeFakePrismaClient();
      const moduleRef = await Test.createTestingModule({
        providers: [
          PostgresPrismaJobStore,
          {
            provide: STORE_POSTGRES_PRISMA_CONFIG,
            useValue: { client: fakeClient },
          },
        ],
      }).compile();
      const a = moduleRef.get(PostgresPrismaJobStore);
      const b = moduleRef.get(PostgresPrismaJobStore);
      expect(a).toBe(b);
      expect(a).toBeInstanceOf(PostgresPrismaJobStore);
      await moduleRef.close();
    });

    it('importing StorePostgresPrismaModule without a config provider fails fast', async () => {
      // Pin the FR-3 fail-fast contract end-to-end: importing the
      // module without binding `STORE_POSTGRES_PRISMA_CONFIG` MUST
      // throw at NestJS instantiation time, not silently produce a
      // half-functional store. Production wiring binds the config
      // alongside `StoreModule.forActive('postgres', ...)` so this
      // failure mode is bootstrap-only.
      await expect(
        Test.createTestingModule({
          imports: [StorePostgresPrismaModule],
        }).compile(),
      ).rejects.toThrow(/STORE_POSTGRES_PRISMA_CONFIG/);
    });
  });
});

// =====================================================================
// Postgres-gated tests (Testcontainers-backed).
// =====================================================================

const RUN_PG_TESTS = process.env.RUN_PG_TESTS === '1';
const describeIfPg = RUN_PG_TESTS ? describe : describe.skip;

/**
 * Spec 1722 — run the same suite against an existing Postgres instead of a
 * Testcontainers one (no Docker needed): set `RUN_PG_TESTS=1` and
 * `EVER_JOBS_TEST_PG_URL=postgresql://…/<db>`. The suite TRUNCATEs its tables
 * before every test, so it refuses any database whose name does not contain
 * "test" — pointing it at a real corpus by mistake must not wipe it.
 */
const EXTERNAL_PG_URL = process.env.EVER_JOBS_TEST_PG_URL?.trim() || undefined;

function assertDisposableDatabase(url: string): void {
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/test/i.test(dbName)) {
    throw new Error(
      `EVER_JOBS_TEST_PG_URL points at database "${dbName}"; this suite truncates its tables, ` +
        'so it only runs against a database whose name contains "test".',
    );
  }
}

describeIfPg('PostgresPrismaJobStore — Testcontainers-backed (RUN_PG_TESTS=1)', () => {
  // Container handle, prisma client, and current pg URL — populated by
  // beforeAll, torn down by afterAll. Typed loosely (`any`) because
  // the underlying packages (`testcontainers`, `@prisma/client`) are
  // dynamically required and their typed surfaces are codegen artefacts.
  let pgContainer: any;
  let prisma: any;
  let prismaClient: PrismaJobsClient;

  beforeAll(async () => {
    // Dynamic-require so this file parses cleanly when the packages
    // aren't installed (sandbox / RUN_PG_TESTS unset path).
    const PrismaClientCtor: new (
      args: Record<string, unknown>,
    ) => PrismaJobsClient & {
      $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number>;
      $queryRawUnsafe<T = unknown>(sql: string, ...args: unknown[]): Promise<T>;
    } = require('@prisma/client').PrismaClient;

    let databaseUrl: string;
    if (EXTERNAL_PG_URL) {
      assertDisposableDatabase(EXTERNAL_PG_URL);
      databaseUrl = EXTERNAL_PG_URL;
    } else {
      const tc = require('testcontainers');
      // Spin up a single Postgres for the suite. Per-test containers
      // would dominate runtime; we instead truncate-in-beforeEach (below)
      // for fresh state across tests.
      pgContainer = await new tc.PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('ever_jobs_test')
        .withUsername('ever_jobs')
        .withPassword('ever_jobs')
        .start();
      databaseUrl = pgContainer.getConnectionUri();
    }
    prisma = new PrismaClientCtor({ datasourceUrl: databaseUrl });

    // An external database may already carry the schema (e.g. applied with
    // `npm run store:postgres:migrate`); only replay the migration when the
    // tables are absent.
    const existing = (await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.canonical_job')::text AS t`,
    )) as Array<{ t: string | null }>;
    if (existing[0]?.t) {
      prismaClient = prisma as PrismaJobsClient;
      return;
    }

    // Apply the schema. We replay `0_init/migration.sql` directly via
    // raw exec rather than running `prisma migrate deploy` because the
    // latter shells out to `npx prisma` which adds 5–10 s of cold-start
    // overhead per suite. Splitting on `;\s*\n` is safe for our
    // migration — no embedded semicolons in literal strings.
    const migrationPath = path.resolve(
      __dirname,
      '../prisma/migrations/0_init/migration.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    // Strip line comments BEFORE deciding whether a chunk is empty. The
    // previous filter dropped every chunk that merely *started* with a
    // comment — which is every CREATE TABLE in 0_init (each is preceded by
    // a comment block) — so the replay created indexes on tables that did
    // not exist. Found by Spec 1722 running this suite for the first time
    // against a real database.
    const statements = migrationSql
      .split(/;\s*\n/)
      .map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((stmt) => stmt.length > 0);
    for (const stmt of statements) {
      await prisma.$executeRawUnsafe(stmt);
    }

    prismaClient = prisma as PrismaJobsClient;
  }, 120_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await pgContainer?.stop();
    }
  });

  beforeEach(async () => {
    // Fresh state per test. CASCADE so the FK from source_observation
    // doesn't block the truncate.
    await (prisma as any).$executeRawUnsafe(
      'TRUNCATE TABLE "source_observation", "canonical_job" CASCADE',
    );
  });

  // ----------------------------------------------------------------------
  // 1. Conformance — every contract case from Spec 004 §7.1.
  // ----------------------------------------------------------------------
  runStoreConformance(
    'store-postgres-prisma',
    () => new PostgresPrismaJobStore({ client: prismaClient }),
  );

  // ----------------------------------------------------------------------
  // 2. Cursor envelope round-trip + invalid-cursor rejection.
  // ----------------------------------------------------------------------
  describe('cursor envelope', () => {
    it('encodes nextCursor as base64-of-JSON { v: 1, mergedAt, canonicalJobId }', async () => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      // Seed 3 rows with strictly-decreasing `mergedAt` so paginating
      // page-size 2 yields cursor pointing at row #2.
      await store.upsertMany([
        {
          canonicalJobId: 'a',
          title: 'T',
          company: 'C',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-03T00:00:00.000Z',
        },
        {
          canonicalJobId: 'b',
          title: 'T',
          company: 'C',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          canonicalJobId: 'c',
          title: 'T',
          company: 'C',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const page = await store.listByQuery({ limit: 2 });
      expect(page.items.map((j) => j.canonicalJobId)).toEqual(['a', 'b']);
      expect(page.nextCursor).toBeDefined();
      const decoded = JSON.parse(
        Buffer.from(page.nextCursor!, 'base64').toString('utf8'),
      );
      expect(decoded).toEqual({
        v: 1,
        mergedAt: '2026-01-02T00:00:00.000Z',
        canonicalJobId: 'b',
      });
      // Re-feed the cursor and assert the next page is exactly row 'c'
      // and nextCursor is now omitted (final page).
      const page2 = await store.listByQuery({
        limit: 2,
        cursor: page.nextCursor,
      });
      expect(page2.items.map((j) => j.canonicalJobId)).toEqual(['c']);
      expect(page2.nextCursor).toBeUndefined();
    });

    it.each([
      ['empty string', ''],
      ['plain text', 'not-base64-and-not-json'],
      ['base64 of non-JSON', Buffer.from('not json', 'utf8').toString('base64')],
      ['base64 of literal 42', Buffer.from('42', 'utf8').toString('base64')],
      [
        'missing version',
        Buffer.from(
          JSON.stringify({
            mergedAt: '2026-01-01T00:00:00.000Z',
            canonicalJobId: 'a',
          }),
          'utf8',
        ).toString('base64'),
      ],
      [
        'wrong version',
        Buffer.from(
          JSON.stringify({
            v: 99,
            mergedAt: '2026-01-01T00:00:00.000Z',
            canonicalJobId: 'a',
          }),
          'utf8',
        ).toString('base64'),
      ],
      [
        'mergedAt is not a string',
        Buffer.from(
          JSON.stringify({ v: 1, mergedAt: 42, canonicalJobId: 'a' }),
          'utf8',
        ).toString('base64'),
      ],
      [
        'canonicalJobId is empty',
        Buffer.from(
          JSON.stringify({
            v: 1,
            mergedAt: '2026-01-01T00:00:00.000Z',
            canonicalJobId: '',
          }),
          'utf8',
        ).toString('base64'),
      ],
    ])('rejects %s with ERR_STORE_INVALID_CURSOR', async (_label, cursor) => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      await expect(store.listByQuery({ cursor })).rejects.toMatchObject({
        code: ERR_STORE_INVALID_CURSOR,
        name: 'PostgresStoreCursorError',
      });
    });
  });

  // ----------------------------------------------------------------------
  // 3. SQL-enforced FK cascade — Postgres owns this unconditionally.
  // ----------------------------------------------------------------------
  describe('SQL FK cascade', () => {
    it('ON DELETE CASCADE drops attached source_observation rows', async () => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      await store.upsert({
        canonicalJobId: 'job-1',
        title: 'T',
        company: 'C',
        location: 'L',
        url: 'u',
        sources: [],
        fields: {},
        mergedAt: '2026-01-01T00:00:00.000Z',
      });
      await store.putAll('job-1', [
        {
          site: Site.LINKEDIN,
          sourceJobId: 's1',
          url: 'u',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          site: Site.INDEED,
          sourceJobId: 's2',
          url: 'u',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      // Sanity — observations are present.
      expect((await store.listByCanonicalId('job-1')).length).toBe(2);
      // Drop the canonical row.
      const dropped = await store.delete('job-1');
      expect(dropped).toBe(true);
      // Cascade — listByCanonicalId returns [] AND deleteByCanonicalId
      // returns 0 (the rows are physically gone).
      expect(await store.listByCanonicalId('job-1')).toEqual([]);
      expect(await store.deleteByCanonicalId('job-1')).toBe(0);
    });
  });

  // ----------------------------------------------------------------------
  // 4. Keyset pagination tie-break — many rows sharing identical
  //    mergedAt MUST resume deterministically across pages.
  // ----------------------------------------------------------------------
  describe('keyset pagination tie-break', () => {
    it('resumes deterministically when many rows share an identical mergedAt', async () => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      // 10 rows all stamped with the same mergedAt — the canonical-id
      // ASC tie-break MUST drive a total order so paginating in chunks
      // of 3 yields each row exactly once.
      const sharedMergedAt = '2026-04-15T00:00:00.000Z';
      const rows = Array.from({ length: 10 }).map((_, i) => ({
        canonicalJobId: `tie-${i.toString().padStart(2, '0')}`,
        title: 'T',
        company: 'C',
        location: 'L',
        url: 'u',
        sources: [],
        fields: {},
        mergedAt: sharedMergedAt,
      }));
      await store.upsertMany(rows);

      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.listByQuery({ limit: 3, cursor });
        pages++;
        for (const item of page.items) {
          expect(seen.has(item.canonicalJobId)).toBe(false);
          seen.add(item.canonicalJobId);
        }
        cursor = page.nextCursor;
        if (pages > 50) {
          throw new Error('keyset pagination did not terminate');
        }
      } while (cursor);

      expect(seen.size).toBe(10);
      // 10 rows / 3 per page = 4 pages (3+3+3+1).
      expect(pages).toBe(4);
    });
  });

  // ----------------------------------------------------------------------
  // 5. ILIKE substring filter — exercises the pg_trgm GIN indexes.
  //
  //    The Spec 004 / NFR-1 budget (<50 ms p95) is enforced by
  //    `idx_canonical_job_company_trgm` etc. — without the GIN index,
  //    `ILIKE '%term%'` falls back to seq scan. We don't EXPLAIN-assert
  //    here because that ties the test to a specific planner version;
  //    we DO assert the functional behaviour (case-insensitive, accent-
  //    insensitive — well, latin-only-insensitive, which is what
  //    Prisma's `mode: 'insensitive'` gives us).
  // ----------------------------------------------------------------------
  describe('ILIKE substring filter (pg_trgm-backed)', () => {
    it('finds rows by case-insensitive company substring', async () => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      await store.upsertMany([
        {
          canonicalJobId: 'a',
          title: 'T',
          company: 'Acme Corporation',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          canonicalJobId: 'b',
          title: 'T',
          company: 'ACME Inc',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          canonicalJobId: 'c',
          title: 'T',
          company: 'Beta Industries',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-03T00:00:00.000Z',
        },
      ]);
      const page = await store.listByQuery({ company: 'acme' });
      expect(page.items.map((j) => j.canonicalJobId).sort()).toEqual([
        'a',
        'b',
      ]);
      // Substring (not prefix) — `cme` should still match both.
      const page2 = await store.listByQuery({ company: 'cme' });
      expect(page2.items.map((j) => j.canonicalJobId).sort()).toEqual([
        'a',
        'b',
      ]);
    });
  });

  // ----------------------------------------------------------------------
  // 6. jsonb round-trip — `fields` and `sources` survive nested data.
  //
  //    Postgres's `jsonb` does NOT preserve key insertion order (it
  //    canonicalises keys for storage efficiency), so we assert the
  //    SHAPE of the round-tripped object, not the byte-equality with
  //    the input.
  // ----------------------------------------------------------------------
  describe('jsonb round-trip', () => {
    it('preserves nested fields/sources through write+read', async () => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      const job = {
        canonicalJobId: 'json-1',
        title: 'Engineer',
        company: 'Acme',
        location: 'Remote',
        url: 'https://example.com/jobs/json-1',
        description: 'desc',
        sources: [
          {
            site: Site.LINKEDIN,
            sourceJobId: 'src-1',
            url: 'https://linkedin.com/jobs/src-1',
            observedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        fields: {
          title: {
            value: 'Engineer',
            _source: Site.LINKEDIN,
            _sourceId: 'src-1',
            _observedAt: '2026-01-01T00:00:00.000Z',
          },
          compensation: {
            value: { min: 100, max: 200, currency: 'USD' },
            _source: Site.LINKEDIN,
            _sourceId: 'src-1',
            _observedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        mergedAt: '2026-01-01T00:00:00.000Z',
      };
      await store.upsert(job);
      const read = await store.getById('json-1');
      expect(read).not.toBeNull();
      expect(read!.fields).toEqual(job.fields);
      // `sources` survives the array round-trip (JSON arrays preserve
      // order, unlike object keys).
      expect(read!.sources).toEqual(job.sources);
    });
  });

  // ----------------------------------------------------------------------
  // 7. size diagnostic.
  // ----------------------------------------------------------------------
  describe('size diagnostic', () => {
    it('reflects insert / delete counts', async () => {
      const store = new PostgresPrismaJobStore({ client: prismaClient });
      expect(await store.size()).toBe(0);
      await store.upsertMany([
        {
          canonicalJobId: 'a',
          title: 'T',
          company: 'C',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          canonicalJobId: 'b',
          title: 'T',
          company: 'C',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      expect(await store.size()).toBe(2);
      await store.delete('a');
      expect(await store.size()).toBe(1);
    });
  });
});

// =====================================================================
// Helpers
// =====================================================================

/**
 * Build a structural fake `PrismaJobsClient` for the always-on test
 * layer. Every method is a `jest.fn()` so callers can assert on
 * invocation if they need to. The fake is enough to prove the NestJS
 * module resolves the service without a real Postgres connection — we
 * intentionally do NOT reproduce backend logic here.
 */
function makeFakePrismaClient(): PrismaJobsClient {
  return {
    canonicalJob: {
      upsert: jest.fn().mockResolvedValue({
        canonicalJobId: 'fake',
        title: 'fake',
        company: 'fake',
        location: 'fake',
        description: null,
        url: 'fake',
        mergedAt: new Date('2026-01-01T00:00:00.000Z'),
        fields: {},
        sources: [],
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({
        canonicalJobId: 'fake',
        title: 'fake',
        company: 'fake',
        location: 'fake',
        description: null,
        url: 'fake',
        mergedAt: new Date('2026-01-01T00:00:00.000Z'),
        fields: {},
        sources: [],
      }),
      count: jest.fn().mockResolvedValue(0),
    },
    sourceObservation: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (fn) => {
      // Pass the same fake through so transactional calls hit the
      // same mocks the caller would assert against.
      return fn(makeFakePrismaClient());
    }),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
}
