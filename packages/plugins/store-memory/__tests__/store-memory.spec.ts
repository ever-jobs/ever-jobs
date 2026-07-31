import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ERR_STORE_INVALID_CURSOR,
  IStoreMetadata,
  Site,
  STORE_PLUGIN_METADATA_KEY,
} from '@ever-jobs/models';
import { runStoreConformance } from '../../../plugin/src/store/__tests__/conformance';
import {
  DEFAULT_ROW_CAP,
  InMemoryJobStore,
  resolveRowCap,
  STORE_MAX_ROWS_ENV_VAR,
  STORE_MEMORY_DESCRIPTION,
  STORE_MEMORY_ID,
  StoreMemoryModule,
} from '../src';

/**
 * Spec 004 / T06 — In-memory backend tests.
 *
 * The bulk of the assertion surface lives in the shared conformance
 * suite at `packages/plugin/src/store/__tests__/conformance.ts`; this
 * file (a) runs that suite against a fresh `InMemoryJobStore` per case
 * and (b) covers in-memory-specific paths that fall outside the
 * contract — the cursor envelope shape, version drift, the
 * `@StorePlugin()` metadata wiring, and the NestJS module export.
 */

describe('store-memory plugin (Spec 004 / T06)', () => {
  // Conformance — gives us all 24 contract cases against the in-memory backend.
  runStoreConformance('store-memory', () => new InMemoryJobStore());

  // ----------------------------------------------------------------------
  // Cursor-envelope failure modes (in-memory-specific; the conformance
  // suite only checks the abstract `ERR_STORE_INVALID_CURSOR` contract).
  // ----------------------------------------------------------------------

  describe('cursor envelope (in-memory specific)', () => {
    let store: InMemoryJobStore;

    beforeEach(async () => {
      store = new InMemoryJobStore();
      // Seed enough rows that pagination is meaningful.
      for (let i = 0; i < 5; i++) {
        await store.upsert({
          canonicalJobId: `j-${i}`,
          title: `t${i}`,
          company: 'C',
          location: 'L',
          url: `https://example.com/${i}`,
          sources: [],
          fields: {},
          mergedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        });
      }
    });

    const invalidCursors: Array<[string, string]> = [
      ['empty string', ''],
      ['plain text', 'hello-world'],
      // Valid base64, NOT JSON.
      ['base64 of non-JSON', Buffer.from('not json', 'utf8').toString('base64')],
      // Valid JSON, NOT an object.
      [
        'base64 of JSON literal',
        Buffer.from(JSON.stringify(42), 'utf8').toString('base64'),
      ],
      // Valid object, missing `v`.
      [
        'object missing version',
        Buffer.from(JSON.stringify({ offset: 0 }), 'utf8').toString('base64'),
      ],
      // Wrong version.
      [
        'object with wrong version',
        Buffer.from(JSON.stringify({ v: 999, offset: 0 }), 'utf8').toString(
          'base64',
        ),
      ],
      // Valid version, NEGATIVE offset.
      [
        'negative offset',
        Buffer.from(JSON.stringify({ v: 1, offset: -1 }), 'utf8').toString(
          'base64',
        ),
      ],
      // Valid version, FRACTIONAL offset.
      [
        'fractional offset',
        Buffer.from(JSON.stringify({ v: 1, offset: 1.5 }), 'utf8').toString(
          'base64',
        ),
      ],
      // Valid version, STRING offset.
      [
        'string offset',
        Buffer.from(JSON.stringify({ v: 1, offset: '0' }), 'utf8').toString(
          'base64',
        ),
      ],
    ];

    it.each(invalidCursors)(
      'rejects %s with ERR_STORE_INVALID_CURSOR',
      async (_label, cursor) => {
        await expect(store.listByQuery({ cursor })).rejects.toMatchObject({
          code: ERR_STORE_INVALID_CURSOR,
          name: 'MemoryStoreCursorError',
        });
      },
    );

    it('a returned nextCursor is opaque base64 — round-trips back into a valid page', async () => {
      const first = await store.listByQuery({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      // The cursor MUST be base64-decodable to a JSON object.
      const decoded = JSON.parse(
        Buffer.from(first.nextCursor as string, 'base64').toString('utf8'),
      );
      expect(decoded).toMatchObject({ v: 1, offset: 2 });

      // Round-trip: feeding the cursor back yields the next page.
      const second = await store.listByQuery({
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items).toHaveLength(2);
      // No id appears twice across the two pages.
      const ids = [
        ...first.items.map((j) => j.canonicalJobId),
        ...second.items.map((j) => j.canonicalJobId),
      ];
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ----------------------------------------------------------------------
  // @StorePlugin metadata wiring (T05 acceptance: plugin is discoverable
  // by `StoreModule.forActive`).
  // ----------------------------------------------------------------------

  describe('@StorePlugin metadata', () => {
    it('attaches { id, description } via @StorePlugin', () => {
      const meta = Reflect.getMetadata(
        STORE_PLUGIN_METADATA_KEY,
        InMemoryJobStore,
      ) as IStoreMetadata | undefined;
      expect(meta).toBeDefined();
      expect(meta?.id).toBe(STORE_MEMORY_ID);
      expect(meta?.id).toBe('memory');
      expect(meta?.description).toBe(STORE_MEMORY_DESCRIPTION);
    });

    it('Reflector.get returns the same metadata as raw Reflect.getMetadata', () => {
      const reflector = new Reflector();
      const fromReflector = reflector.get<IStoreMetadata>(
        STORE_PLUGIN_METADATA_KEY,
        InMemoryJobStore,
      );
      const fromReflect = Reflect.getMetadata(
        STORE_PLUGIN_METADATA_KEY,
        InMemoryJobStore,
      ) as IStoreMetadata;
      expect(fromReflector).toBe(fromReflect);
    });
  });

  // ----------------------------------------------------------------------
  // NestJS module wiring (T05 acceptance: builds standalone).
  // ----------------------------------------------------------------------

  describe('StoreMemoryModule', () => {
    it('exports InMemoryJobStore as an injectable provider', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StoreMemoryModule],
      }).compile();
      const store = moduleRef.get(InMemoryJobStore);
      expect(store).toBeInstanceOf(InMemoryJobStore);
    });

    it('binds a singleton — two consumers see the same instance', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StoreMemoryModule],
      }).compile();
      const a = moduleRef.get(InMemoryJobStore);
      const b = moduleRef.get(InMemoryJobStore);
      expect(a).toBe(b);
    });
  });

  // ----------------------------------------------------------------------
  // Diagnostic / debug surface
  // ----------------------------------------------------------------------

  describe('size / clear', () => {
    it('reports size after upserts and resets to 0 after clear', async () => {
      const store = new InMemoryJobStore();
      expect(store.size).toBe(0);
      await store.upsert({
        canonicalJobId: 'a',
        title: 't',
        company: 'c',
        location: 'l',
        url: 'https://example.com/a',
        sources: [],
        fields: {},
        mergedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(store.size).toBe(1);
      store.clear();
      expect(store.size).toBe(0);
    });

    it('clear() drops observations as well as canonicals', async () => {
      const store = new InMemoryJobStore();
      await store.putAll('a', [
        {
          site: Site.LINKEDIN,
          sourceJobId: 's1',
          url: 'https://example.com/s1',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      expect(await store.listByCanonicalId('a')).toHaveLength(1);
      store.clear();
      expect(await store.listByCanonicalId('a')).toEqual([]);
    });
  });

  // ----------------------------------------------------------------------
  // Spec 5024 — bounded canonical/observation retention
  // ----------------------------------------------------------------------

  describe('row cap (Spec 5024)', () => {
    const job = (id: string) => ({
      canonicalJobId: id,
      title: `title-${id}`,
      company: 'c',
      location: 'l',
      url: `https://example.com/${id}`,
      sources: [],
      fields: {},
      mergedAt: '2026-01-01T00:00:00.000Z',
    });

    it('defaults to DEFAULT_ROW_CAP when the env var is unset', () => {
      expect(resolveRowCap({})).toBe(DEFAULT_ROW_CAP);
      expect(resolveRowCap({ [STORE_MAX_ROWS_ENV_VAR]: '' })).toBe(DEFAULT_ROW_CAP);
      expect(new InMemoryJobStore().rowCapacity).toBe(DEFAULT_ROW_CAP);
    });

    it('honours EVER_JOBS_STORE_MAX_ROWS and rejects junk values', () => {
      expect(resolveRowCap({ [STORE_MAX_ROWS_ENV_VAR]: '250' })).toBe(250);
      expect(resolveRowCap({ [STORE_MAX_ROWS_ENV_VAR]: '250.9' })).toBe(250);
      expect(resolveRowCap({ [STORE_MAX_ROWS_ENV_VAR]: 'nope' })).toBe(DEFAULT_ROW_CAP);
      expect(resolveRowCap({ [STORE_MAX_ROWS_ENV_VAR]: '0' })).toBe(DEFAULT_ROW_CAP);
      expect(resolveRowCap({ [STORE_MAX_ROWS_ENV_VAR]: '-5' })).toBe(DEFAULT_ROW_CAP);
    });

    it('upsert trims oldest-first once the cap is exceeded', async () => {
      const store = new InMemoryJobStore();
      store.setRowCap(3);
      for (const id of ['a', 'b', 'c', 'd']) await store.upsert(job(id));

      expect(store.size).toBe(3);
      expect(await store.getById('a')).toBeNull();
      expect(await store.getById('d')).not.toBeNull();
    });

    it('upsertMany trims a whole over-cap batch, not just one row', async () => {
      const store = new InMemoryJobStore();
      store.setRowCap(2);
      // A single batch pushes 5 rows past a cap of 2 — an `if` instead of a
      // `while` would leave 4 rows resident. This is the regression guard.
      await store.upsertMany(['a', 'b', 'c', 'd', 'e'].map(job));

      expect(store.size).toBe(2);
      expect(await store.getById('d')).not.toBeNull();
      expect(await store.getById('e')).not.toBeNull();
      expect(await store.getById('a')).toBeNull();
    });

    it('trimming cascades into observations (dropping a canonical alone frees nothing)', async () => {
      const store = new InMemoryJobStore();
      store.setRowCap(1);
      await store.upsert(job('a'));
      await store.putAll('a', [
        {
          site: Site.LINKEDIN,
          sourceJobId: 's1',
          url: 'https://example.com/s1',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      expect(await store.listByCanonicalId('a')).toHaveLength(1);

      await store.upsert(job('b'));

      expect(await store.getById('a')).toBeNull();
      expect(await store.listByCanonicalId('a')).toEqual([]);
    });

    it('setRowCap trims immediately and rejects non-positive / non-finite values', async () => {
      const store = new InMemoryJobStore();
      await store.upsertMany(['a', 'b', 'c', 'd'].map(job));
      expect(store.size).toBe(4);

      store.setRowCap(2);
      expect(store.size).toBe(2);
      expect(store.rowCapacity).toBe(2);

      expect(() => store.setRowCap(0)).toThrow(RangeError);
      expect(() => store.setRowCap(-1)).toThrow(RangeError);
      expect(() => store.setRowCap(Number.NaN)).toThrow(RangeError);
    });

    it('observations stay bounded when a batch exceeds the cap (orphan write-back)', async () => {
      // Regression guard for the exact JobsAggregator.maybePersist sequence:
      //   upsertMany(batch)  → evicts the oldest ids in the batch
      //   putAll(id, …) for EVERY id in the batch → writes the evicted ids
      //                                             straight back
      // A cascade-only trim would let `observations` grow without limit and
      // just relocate the leak the cap exists to close.
      const store = new InMemoryJobStore();
      store.setRowCap(10);

      const observation = (id: string) => ({
        site: Site.LINKEDIN,
        sourceJobId: `s-${id}`,
        url: `https://example.com/${id}`,
        observedAt: '2026-01-01T00:00:00.000Z',
      });

      for (let round = 0; round < 5; round++) {
        const batch = Array.from({ length: 100 }, (_, i) => job(`r${round}-j${i}`));
        await store.upsertMany(batch);
        // The aggregator does not filter by what survived the upsert.
        for (const c of batch) {
          await store.putAll(c.canonicalJobId, [observation(c.canonicalJobId)]);
        }
      }

      expect(store.size).toBeLessThanOrEqual(10);
      expect(store.observationCount).toBeLessThanOrEqual(10);
    });

    it('re-upserting an existing id does not grow the map past the cap', async () => {
      const store = new InMemoryJobStore();
      store.setRowCap(2);
      await store.upsertMany([job('a'), job('b')]);
      await store.upsertMany([job('a'), job('a'), job('b')]);

      expect(store.size).toBe(2);
    });
  });

  // ----------------------------------------------------------------------
  // Spec 005 / T09 — IHealthSnapshotStore co-resident binding
  // ----------------------------------------------------------------------

  describe('IHealthSnapshotStore (Spec 005 / T09)', () => {
    function makeHealth(
      site: Site,
      overrides: Partial<{
        successRate: number;
        p95LatencyMs: number;
        state: 'closed' | 'open' | 'half-open';
      }> = {},
    ) {
      return {
        site,
        state: overrides.state ?? ('closed' as const),
        successRate: overrides.successRate ?? 1,
        p95LatencyMs: overrides.p95LatencyMs ?? 0,
        windowMs: 60_000,
      };
    }

    it('putBatch appends rows and reports inserted count', async () => {
      const store = new InMemoryJobStore();
      const ts = new Date('2026-04-27T10:00:00Z');
      const result = await store.putBatch(
        [makeHealth(Site.LINKEDIN), makeHealth(Site.INDEED, { successRate: 0.9 })],
        ts,
      );
      expect(result).toEqual({ inserted: 2 });
      expect(store.snapshotSize).toBe(2);
    });

    it('putBatch with empty input is a no-op (contract)', async () => {
      const store = new InMemoryJobStore();
      const result = await store.putBatch([], new Date());
      expect(result).toEqual({ inserted: 0 });
      expect(store.snapshotSize).toBe(0);
    });

    it('putBatch defensive-copies the timestamp (mutating caller Date does not shift rows)', async () => {
      const store = new InMemoryJobStore();
      const ts = new Date('2026-04-27T10:00:00Z');
      await store.putBatch([makeHealth(Site.LINKEDIN)], ts);
      // Mutate the caller's Date AFTER putBatch — stored row must keep
      // its original timestamp.
      ts.setTime(0);
      const rows = await store.listSince(new Date('2026-04-27T09:59:59Z'));
      expect(rows).toHaveLength(1);
      expect(rows[0].ts.toISOString()).toBe('2026-04-27T10:00:00.000Z');
    });

    it('listSince returns rows >= since, ascending by insertion order', async () => {
      const store = new InMemoryJobStore();
      const t1 = new Date('2026-04-27T10:00:00Z');
      const t2 = new Date('2026-04-27T10:01:00Z');
      const t3 = new Date('2026-04-27T10:02:00Z');
      await store.putBatch([makeHealth(Site.LINKEDIN)], t1);
      await store.putBatch([makeHealth(Site.INDEED)], t2);
      await store.putBatch([makeHealth(Site.GLASSDOOR)], t3);

      const rows = await store.listSince(t2);
      expect(rows.map((r) => r.health.site)).toEqual([Site.INDEED, Site.GLASSDOOR]);
    });

    it('listSince filters by site when options.site is set', async () => {
      const store = new InMemoryJobStore();
      const t1 = new Date('2026-04-27T10:00:00Z');
      const t2 = new Date('2026-04-27T10:01:00Z');
      await store.putBatch(
        [makeHealth(Site.LINKEDIN), makeHealth(Site.INDEED)],
        t1,
      );
      await store.putBatch(
        [makeHealth(Site.LINKEDIN), makeHealth(Site.INDEED)],
        t2,
      );

      const rows = await store.listSince(t1, { site: Site.LINKEDIN });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.health.site === Site.LINKEDIN)).toBe(true);
    });

    it('listSince clamps an excessive limit at HEALTH_SNAPSHOT_QUERY_MAX_LIMIT', async () => {
      const store = new InMemoryJobStore();
      const ts = new Date('2026-04-27T10:00:00Z');
      // Insert 50 rows under one ts.
      const batch = Array.from({ length: 50 }, () => makeHealth(Site.LINKEDIN));
      await store.putBatch(batch, ts);
      const rows = await store.listSince(ts, { limit: 1_000_000 });
      // The cap (10 000) is well above 50; we just confirm it doesn't NaN-error.
      expect(rows.length).toBe(50);
    });

    it('latest returns the most recent SourceHealth for a site or null', async () => {
      const store = new InMemoryJobStore();
      expect(await store.latest(Site.LINKEDIN)).toBeNull();

      await store.putBatch(
        [makeHealth(Site.LINKEDIN, { successRate: 0.5 })],
        new Date('2026-04-27T10:00:00Z'),
      );
      await store.putBatch(
        [makeHealth(Site.LINKEDIN, { successRate: 0.9 })],
        new Date('2026-04-27T10:01:00Z'),
      );

      const latest = await store.latest(Site.LINKEDIN);
      expect(latest?.successRate).toBe(0.9);
      expect(await store.latest(Site.INDEED)).toBeNull();
    });

    it('setSnapshotCap trims oldest rows when current size exceeds the new cap', async () => {
      const store = new InMemoryJobStore();
      const ts = new Date('2026-04-27T10:00:00Z');
      await store.putBatch(
        [
          makeHealth(Site.LINKEDIN),
          makeHealth(Site.INDEED),
          makeHealth(Site.GLASSDOOR),
        ],
        ts,
      );
      expect(store.snapshotSize).toBe(3);
      store.setSnapshotCap(2);
      expect(store.snapshotSize).toBe(2);
      // Oldest is dropped first — Site.LINKEDIN was first in the batch.
      const all = await store.listSince(new Date(0));
      expect(all.map((r) => r.health.site)).not.toContain(Site.LINKEDIN);
    });

    it('setSnapshotCap rejects non-positive / non-finite values', () => {
      const store = new InMemoryJobStore();
      expect(() => store.setSnapshotCap(0)).toThrow(RangeError);
      expect(() => store.setSnapshotCap(-1)).toThrow(RangeError);
      expect(() => store.setSnapshotCap(Number.NaN)).toThrow(RangeError);
      expect(() => store.setSnapshotCap(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('clear() drops snapshot rows', async () => {
      const store = new InMemoryJobStore();
      await store.putBatch([makeHealth(Site.LINKEDIN)], new Date());
      expect(store.snapshotSize).toBe(1);
      store.clear();
      expect(store.snapshotSize).toBe(0);
    });
  });
});
