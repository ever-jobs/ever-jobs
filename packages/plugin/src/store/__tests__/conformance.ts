import {
  CanonicalJob,
  ERR_STORE_INVALID_CURSOR,
  IJobObservationStore,
  IJobStore,
  JOB_STORE_QUERY_DEFAULT_LIMIT,
  JOB_STORE_QUERY_MAX_LIMIT,
  Site,
  SourceObservation,
} from '@ever-jobs/models';

/**
 * Shape of the value yielded by the per-test factory passed to
 * {@link runStoreConformance}. Backends implement BOTH `IJobStore` and
 * `IJobObservationStore` — Spec 004 §7 expects a single backend to
 * satisfy both contracts in production deployments so the canonical
 * row and its observations stay transactionally aligned.
 *
 * The factory MUST return a brand-new, empty backend on every call
 * so test isolation holds without per-suite cleanup hooks.
 */
export type ConformanceBackend = IJobStore & IJobObservationStore;

/**
 * Factory contract for the shared conformance suite — `factory()` is
 * called from every test's `beforeEach`, so a fresh backend is wired
 * for every assertion. Backends backed by external resources (sqlite
 * temp file, Postgres testcontainer) MUST teardown anything stateful
 * before returning a new instance.
 */
export type ConformanceBackendFactory = () => ConformanceBackend;

/** Optional capabilities a backend opts into (Spec 1722 / FR-13). */
export interface ConformanceOptions {
  /**
   * The backend implements `IJobObservationStore.putAllMany`; run the batch
   * cases (equivalence with `putAll` per entry, last-wins, unknown ids).
   */
  readonly batch?: boolean;
}

/**
 * Shared conformance test suite for {@link IJobStore} +
 * {@link IJobObservationStore} backends (Spec 004 / Phase 2+).
 *
 * Every backend (in-memory T06, sqlite-drizzle T08, postgres-prisma
 * T10, future plugins) re-imports this and calls
 * `runStoreConformance('store-memory', () => new InMemoryJobStore())`
 * from inside its own `__tests__/<plugin>.spec.ts`. The suite owns
 * the contract; backend tests own backend-specific edge cases that
 * fall outside the contract (e.g. SQL connection failure paths).
 *
 * Cases covered:
 *
 *   1. `upsert` round-trip                                    — FR-1
 *   2. `findByCanonicalId` is symmetric with `getById`        — FR-1
 *   3. `getById(unknown)` returns `null` (NOT `undefined`)    — interface JSDoc
 *   4. `upsert` overwrites existing row                       — FR-1
 *   5. `upsertMany` mixed insert / update counts              — FR-8
 *   6. `upsertMany([])` → `{ inserted: 0, updated: 0 }`       — FR-8
 *   7. `delete(known)` → true, follow-up `getById` is `null`  — FR-1
 *   8. `delete(unknown)` → false                              — interface JSDoc
 *   9. `delete` cascades to attached observations             — FR-1 / FR-2
 *  10. `listByQuery({})` returns full set up to default limit — FR-7
 *  11. `listByQuery` filters by `company` (case-insensitive)  — FR-7
 *  12. `listByQuery` filters by `title`                       — FR-7
 *  13. `listByQuery` filters by `location`                    — FR-7
 *  14. `listByQuery` filters by `since` (Date lower bound)    — FR-7
 *  15. `listByQuery` honours combined filters                 — FR-7
 *  16. `listByQuery` clamps `limit` to MAX                    — FR-7 / NFR-3
 *  17. `listByQuery` defaults `limit` when undefined          — FR-7
 *  18. `listByQuery` cursor pagination — full set, no dupes   — FR-7
 *  19. `listByQuery` final page has no `nextCursor`           — JobStorePage JSDoc
 *  20. `listByQuery` malformed cursor → ERR_STORE_INVALID_CURSOR
 *  21. `IJobObservationStore.putAll` round-trip               — FR-2
 *  22. `putAll` REPLACES (not merges) existing set            — FR-2 JSDoc
 *  23. `deleteByCanonicalId` returns count; idempotent        — FR-2 JSDoc
 *  24. `listByCanonicalId(unknown)` returns `[]`              — FR-2
 *
 * @param label Human-readable backend label injected into the outer
 *   `describe()` name so failures point to the right backend.
 * @param factory Returns a fresh, empty backend instance.
 */
export function runStoreConformance(
  label: string,
  factory: ConformanceBackendFactory,
  options: ConformanceOptions = {},
): void {
  describe(`IJobStore + IJobObservationStore conformance — ${label}`, () => {
    let store: ConformanceBackend;

    beforeEach(() => {
      store = factory();
    });

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * Build a deterministic `CanonicalJob` for fixture rows. We only set
     * the fields the contract reads (`canonicalJobId`, `title`, `company`,
     * `location`, `mergedAt`, `url`); the rest stay valid empty defaults
     * so backends that round-trip via JSON / SQL columns see realistic
     * payloads.
     */
    const makeJob = (overrides: Partial<CanonicalJob> = {}): CanonicalJob => {
      const id = overrides.canonicalJobId ?? 'job-1';
      const title = overrides.title ?? 'Software Engineer';
      const company = overrides.company ?? 'Acme';
      const location = overrides.location ?? 'Remote';
      const mergedAt = overrides.mergedAt ?? '2026-01-01T00:00:00.000Z';
      const url = overrides.url ?? `https://example.com/jobs/${id}`;
      return {
        canonicalJobId: id,
        title,
        company,
        location,
        url,
        description: overrides.description,
        sources: overrides.sources ?? [],
        fields: overrides.fields ?? {},
        mergedAt,
      };
    };

    /** Build a deterministic `SourceObservation` for fixture rows. */
    const makeObs = (
      sourceJobId: string,
      site: Site = Site.LINKEDIN,
      observedAt: string = '2026-01-01T00:00:00.000Z',
    ): SourceObservation => ({
      site,
      sourceJobId,
      url: `https://example.com/${site}/${sourceJobId}`,
      observedAt,
      rawTitle: `Raw ${sourceJobId}`,
    });

    // ------------------------------------------------------------------
    // 1. upsert / get round-trip
    // ------------------------------------------------------------------

    describe('upsert / getById', () => {
      it('round-trips a CanonicalJob unchanged', async () => {
        const job = makeJob();
        const written = await store.upsert(job);
        expect(written).toEqual(job);
        const read = await store.getById('job-1');
        expect(read).toEqual(job);
      });

      it('findByCanonicalId returns the same row as getById', async () => {
        const job = makeJob({ canonicalJobId: 'abc' });
        await store.upsert(job);
        const a = await store.getById('abc');
        const b = await store.findByCanonicalId('abc');
        expect(a).toEqual(b);
        expect(a).toEqual(job);
      });

      it('getById(unknown) returns null (not undefined)', async () => {
        const result = await store.getById('does-not-exist');
        expect(result).toBeNull();
        // Pin the contract: null SURVIVES JSON.stringify, undefined is dropped.
        expect(JSON.stringify({ result })).toContain('null');
      });

      it('findByCanonicalId(unknown) returns null', async () => {
        const result = await store.findByCanonicalId('does-not-exist');
        expect(result).toBeNull();
      });

      it('upsert overwrites an existing row by canonicalJobId', async () => {
        await store.upsert(makeJob({ title: 'V1' }));
        await store.upsert(makeJob({ title: 'V2' }));
        const read = await store.getById('job-1');
        expect(read?.title).toBe('V2');
      });
    });

    // ------------------------------------------------------------------
    // 2. upsertMany
    // ------------------------------------------------------------------

    describe('upsertMany', () => {
      it('inserts all-new rows and reports inserted=N, updated=0', async () => {
        const jobs = [
          makeJob({ canonicalJobId: 'a' }),
          makeJob({ canonicalJobId: 'b' }),
          makeJob({ canonicalJobId: 'c' }),
        ];
        const result = await store.upsertMany(jobs);
        expect(result).toEqual({ inserted: 3, updated: 0 });
      });

      it('reports a mixed insert/update batch correctly', async () => {
        await store.upsert(makeJob({ canonicalJobId: 'a', title: 'V1' }));
        const result = await store.upsertMany([
          makeJob({ canonicalJobId: 'a', title: 'V2' }),
          makeJob({ canonicalJobId: 'b' }),
          makeJob({ canonicalJobId: 'c' }),
        ]);
        expect(result).toEqual({ inserted: 2, updated: 1 });
        expect((await store.getById('a'))?.title).toBe('V2');
      });

      it('returns { 0, 0 } for an empty array', async () => {
        const result = await store.upsertMany([]);
        expect(result).toEqual({ inserted: 0, updated: 0 });
      });

      it('a repeated id counts once as insert, then as update, and the last value wins (Spec 1722 / FR-12)', async () => {
        const result = await store.upsertMany([
          makeJob({ canonicalJobId: 'a', title: 'first' }),
          makeJob({ canonicalJobId: 'b' }),
          makeJob({ canonicalJobId: 'a', title: 'last' }),
        ]);
        expect(result).toEqual({ inserted: 2, updated: 1 });
        expect((await store.getById('a'))?.title).toBe('last');
      });
    });

    // ------------------------------------------------------------------
    // 3. delete
    // ------------------------------------------------------------------

    describe('delete', () => {
      it('returns true and removes the row', async () => {
        await store.upsert(makeJob());
        const ok = await store.delete('job-1');
        expect(ok).toBe(true);
        expect(await store.getById('job-1')).toBeNull();
      });

      it('returns false when the id is unknown', async () => {
        const ok = await store.delete('never-existed');
        expect(ok).toBe(false);
      });

      it('cascades to attached observations', async () => {
        await store.upsert(makeJob());
        await store.putAll('job-1', [makeObs('s1'), makeObs('s2')]);
        const ok = await store.delete('job-1');
        expect(ok).toBe(true);
        const obs = await store.listByCanonicalId('job-1');
        expect(obs).toEqual([]);
      });
    });

    // ------------------------------------------------------------------
    // 4. listByQuery — filters
    // ------------------------------------------------------------------

    describe('listByQuery filters', () => {
      beforeEach(async () => {
        // Seed a 5-row cohort spanning different companies / titles /
        // locations / mergedAt timestamps for filter tests.
        await store.upsertMany([
          makeJob({
            canonicalJobId: 'a',
            company: 'Acme Corp',
            title: 'Software Engineer',
            location: 'Remote',
            mergedAt: '2026-01-01T00:00:00.000Z',
          }),
          makeJob({
            canonicalJobId: 'b',
            company: 'Beta LLC',
            title: 'Senior Software Engineer',
            location: 'New York',
            mergedAt: '2026-02-01T00:00:00.000Z',
          }),
          makeJob({
            canonicalJobId: 'c',
            company: 'Acme Corp',
            title: 'Data Scientist',
            location: 'Berlin',
            mergedAt: '2026-03-01T00:00:00.000Z',
          }),
          makeJob({
            canonicalJobId: 'd',
            company: 'Gamma Inc',
            title: 'Product Manager',
            location: 'Remote',
            mergedAt: '2026-04-01T00:00:00.000Z',
          }),
          makeJob({
            canonicalJobId: 'e',
            company: 'Delta Co',
            title: 'Engineer',
            location: 'San Francisco',
            mergedAt: '2026-05-01T00:00:00.000Z',
          }),
        ]);
      });

      it('empty filter returns all rows', async () => {
        const page = await store.listByQuery({});
        expect(page.items).toHaveLength(5);
      });

      it('filters by company (case-insensitive substring)', async () => {
        const page = await store.listByQuery({ company: 'acme' });
        expect(page.items.map((j) => j.canonicalJobId).sort()).toEqual([
          'a',
          'c',
        ]);
      });

      it('filters by title (case-insensitive substring)', async () => {
        const page = await store.listByQuery({ title: 'engineer' });
        expect(page.items.map((j) => j.canonicalJobId).sort()).toEqual([
          'a',
          'b',
          'e',
        ]);
      });

      it('filters by location (case-insensitive substring)', async () => {
        const page = await store.listByQuery({ location: 'remote' });
        expect(page.items.map((j) => j.canonicalJobId).sort()).toEqual([
          'a',
          'd',
        ]);
      });

      it('filters by since (Date lower bound, inclusive)', async () => {
        const page = await store.listByQuery({
          since: new Date('2026-03-01T00:00:00.000Z'),
        });
        expect(page.items.map((j) => j.canonicalJobId).sort()).toEqual([
          'c',
          'd',
          'e',
        ]);
      });

      it('honours combined filters (company + since)', async () => {
        const page = await store.listByQuery({
          company: 'acme',
          since: new Date('2026-02-01T00:00:00.000Z'),
        });
        expect(page.items.map((j) => j.canonicalJobId)).toEqual(['c']);
      });
    });

    // ------------------------------------------------------------------
    // 5. listByQuery — limits
    // ------------------------------------------------------------------

    describe('listByQuery limits', () => {
      it('clamps limit to JOB_STORE_QUERY_MAX_LIMIT', async () => {
        // Seed slightly over the max so an honest implementation MUST
        // chop the result set.
        const jobs = Array.from({ length: JOB_STORE_QUERY_MAX_LIMIT + 5 }).map(
          (_, i) =>
            makeJob({
              canonicalJobId: `j-${i.toString().padStart(5, '0')}`,
              mergedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
            }),
        );
        await store.upsertMany(jobs);
        const page = await store.listByQuery({
          limit: JOB_STORE_QUERY_MAX_LIMIT + 100,
        });
        expect(page.items.length).toBe(JOB_STORE_QUERY_MAX_LIMIT);
      });

      it('defaults to JOB_STORE_QUERY_DEFAULT_LIMIT when limit is omitted', async () => {
        const seedSize = JOB_STORE_QUERY_DEFAULT_LIMIT + 5;
        const jobs = Array.from({ length: seedSize }).map((_, i) =>
          makeJob({
            canonicalJobId: `k-${i.toString().padStart(5, '0')}`,
            mergedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          }),
        );
        await store.upsertMany(jobs);
        const page = await store.listByQuery({});
        expect(page.items.length).toBe(JOB_STORE_QUERY_DEFAULT_LIMIT);
      });
    });

    // ------------------------------------------------------------------
    // 6. listByQuery — cursor pagination
    // ------------------------------------------------------------------

    describe('listByQuery cursor pagination', () => {
      const seedPagination = async (count: number): Promise<void> => {
        const jobs = Array.from({ length: count }).map((_, i) =>
          makeJob({
            canonicalJobId: `p-${i.toString().padStart(5, '0')}`,
            mergedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          }),
        );
        await store.upsertMany(jobs);
      };

      it('paginates the full set without dupes or gaps', async () => {
        await seedPagination(25);

        const seen = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        const pageSize = 7;

        do {
          const page = await store.listByQuery({ limit: pageSize, cursor });
          pages++;
          for (const item of page.items) {
            // No dupes across pages.
            expect(seen.has(item.canonicalJobId)).toBe(false);
            seen.add(item.canonicalJobId);
          }
          // Each non-final page MUST be `pageSize` long; the final page
          // MAY be shorter. We let the backend pick its order; the
          // important contract is "every row is yielded exactly once".
          if (page.nextCursor) {
            expect(page.items.length).toBe(pageSize);
          }
          cursor = page.nextCursor;
          // Safety belt: a buggy backend might loop forever.
          if (pages > 100) {
            throw new Error('cursor pagination did not terminate');
          }
        } while (cursor);

        expect(seen.size).toBe(25);
      });

      it('omits nextCursor on the final page (undefined, not null)', async () => {
        await seedPagination(3);
        const page = await store.listByQuery({ limit: 100 });
        expect(page.items.length).toBe(3);
        expect(page.nextCursor).toBeUndefined();
        // Pin: undefined drops out of the JSON payload entirely.
        expect(Object.prototype.hasOwnProperty.call(page, 'nextCursor')).toBe(
          false,
        );
      });

      it('throws ERR_STORE_INVALID_CURSOR for malformed cursors', async () => {
        await seedPagination(3);
        await expect(
          store.listByQuery({ cursor: 'not-a-valid-cursor!' }),
        ).rejects.toMatchObject({ code: ERR_STORE_INVALID_CURSOR });
      });
    });

    // ------------------------------------------------------------------
    // 7. IJobObservationStore
    // ------------------------------------------------------------------

    describe('IJobObservationStore', () => {
      it('round-trips observations via putAll → listByCanonicalId', async () => {
        await store.upsert(makeJob());
        const obs = [makeObs('s1'), makeObs('s2', Site.INDEED)];
        await store.putAll('job-1', obs);
        const read = await store.listByCanonicalId('job-1');
        expect(read).toHaveLength(2);
        // Order is backend-defined; sort by sourceJobId for assertion.
        const sortedRead = [...read].sort((x, y) =>
          x.sourceJobId.localeCompare(y.sourceJobId),
        );
        expect(sortedRead.map((o) => o.sourceJobId)).toEqual(['s1', 's2']);
      });

      it('putAll REPLACES (not merges) the existing set', async () => {
        // Canonical row MUST exist before observations attach — production
        // backends enforce FR-2's 1-N relationship via a FK constraint
        // (see store-sqlite-drizzle's `source_observation.canonical_job_id`
        // FK). The in-memory backend tolerates orphans for simplicity, but
        // the contract is "observations belong to a canonical job".
        await store.upsert(makeJob());
        await store.putAll('job-1', [makeObs('s1'), makeObs('s2')]);
        await store.putAll('job-1', [makeObs('s3')]);
        const read = await store.listByCanonicalId('job-1');
        expect(read.map((o) => o.sourceJobId)).toEqual(['s3']);
      });

      it('deleteByCanonicalId returns count and is idempotent', async () => {
        await store.upsert(makeJob());
        await store.putAll('job-1', [makeObs('s1'), makeObs('s2')]);
        const first = await store.deleteByCanonicalId('job-1');
        expect(first).toBe(2);
        const second = await store.deleteByCanonicalId('job-1');
        expect(second).toBe(0);
      });

      it('listByCanonicalId(unknown) returns []', async () => {
        const read = await store.listByCanonicalId('never-seen');
        expect(read).toEqual([]);
      });
    });

    // ------------------------------------------------------------------
    // 8. putAllMany (optional batch API, Spec 1722 / FR-13)
    // ------------------------------------------------------------------

    (options.batch ? describe : describe.skip)('IJobObservationStore.putAllMany', () => {
      const ids = (read: ReadonlyArray<SourceObservation>): string[] =>
        read.map((o) => o.sourceJobId).sort();

      it('is implemented', () => {
        expect(typeof store.putAllMany).toBe('function');
      });

      it('equals putAll per entry: replaces, clears with [], and skips unknown canonical ids', async () => {
        await store.upsertMany([
          makeJob({ canonicalJobId: 'a' }),
          makeJob({ canonicalJobId: 'b' }),
          makeJob({ canonicalJobId: 'c' }),
        ]);
        await store.putAll('a', [makeObs('a-old')]);
        await store.putAll('b', [makeObs('b-1'), makeObs('b-2')]);
        await store.putAll('c', [makeObs('c-1')]);

        await store.putAllMany!([
          { canonicalJobId: 'a', observations: [makeObs('a-new'), makeObs('a-new-2', Site.INDEED)] },
          { canonicalJobId: 'b', observations: [makeObs('b-2')] },
          { canonicalJobId: 'c', observations: [] },
          { canonicalJobId: 'not-a-canonical-job', observations: [makeObs('orphan')] },
        ]);

        expect(ids(await store.listByCanonicalId('a'))).toEqual(['a-new', 'a-new-2']);
        expect(ids(await store.listByCanonicalId('b'))).toEqual(['b-2']);
        expect(await store.listByCanonicalId('c')).toEqual([]);
        expect(await store.listByCanonicalId('not-a-canonical-job')).toEqual([]);
      });

      it('a repeated canonical id: the last entry wins', async () => {
        await store.upsert(makeJob({ canonicalJobId: 'a' }));
        await store.putAllMany!([
          { canonicalJobId: 'a', observations: [makeObs('first')] },
          { canonicalJobId: 'a', observations: [makeObs('last')] },
        ]);
        expect(ids(await store.listByCanonicalId('a'))).toEqual(['last']);
      });

      it('a repeated (site, sourceJobId) within one entry keeps one row instead of failing', async () => {
        await store.upsert(makeJob({ canonicalJobId: 'a' }));
        await store.putAllMany!([
          {
            canonicalJobId: 'a',
            observations: [
              { ...makeObs('dup'), url: 'https://example.com/first' },
              { ...makeObs('dup'), url: 'https://example.com/last' },
            ],
          },
        ]);
        const read = await store.listByCanonicalId('a');
        expect(read).toHaveLength(1);
        expect(read[0]!.url).toBe('https://example.com/last');
      });

      it('round-trips every field putAll round-trips', async () => {
        await store.upsert(makeJob({ canonicalJobId: 'a' }));
        const observation = makeObs('s1', Site.INDEED, '2026-02-03T04:05:06.000Z');
        await store.putAllMany!([{ canonicalJobId: 'a', observations: [observation] }]);
        expect(await store.listByCanonicalId('a')).toEqual([observation]);
      });
    });
  });
}
