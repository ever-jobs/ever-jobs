import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  CanonicalJob,
  ERR_STORE_INVALID_CURSOR,
  IStoreMetadata,
  STORE_PLUGIN_METADATA_KEY,
  Site,
} from '@ever-jobs/models';
import { runStoreConformance } from '../../../plugin/src/store/__tests__/conformance';
import {
  STORE_SQLITE_DRIZZLE_DESCRIPTION,
  STORE_SQLITE_DRIZZLE_ID,
  SqliteDrizzleJobStore,
  StoreSqliteDrizzleModule,
} from '../src';

/**
 * Spec 004 / Phase 3 / T07 + T08 — SQLite (Drizzle) backend tests.
 *
 * Test surface:
 *
 *   1. **Conformance suite (24 cases)** — re-runs the shared
 *      {@link runStoreConformance} against a fresh `:memory:` SQLite
 *      database per test. Every backend-agnostic contract from Spec
 *      004 §7.1 is exercised here without duplication.
 *
 *   2. **Backend-specific cases (~15 cases)** — guard SQLite-only
 *      behaviour the conformance suite cannot reach:
 *      - `@StorePlugin` metadata wiring (raw `Reflect.getMetadata`
 *        AND `Reflector.get` resolve to `{ id: 'sqlite', description }`).
 *      - `StoreSqliteDrizzleModule` resolves `SqliteDrizzleJobStore`
 *        as a NestJS singleton via `Test.createTestingModule`.
 *      - Cursor envelope: the keyset cursor literally encodes
 *        `{ v: 1, mergedAt, canonicalJobId }` and round-trips.
 *      - Cursor decode rejects all invalid shapes (8 invalid-cursor
 *        rows via `it.each`).
 *      - **FK ON DELETE CASCADE** is enforced by SQLite (not just
 *        by application code) — drop the canonical row and verify
 *        the underlying `source_observation` rows are gone via a
 *        direct query.
 *      - Keyset pagination is **deterministic across pages** even
 *        when many rows share the same `mergedAt` (the canonical-id
 *        ASC tie-break MUST hold so resume after the cursor doesn't
 *        skip / dupe rows).
 *      - `clear()` empties both tables (cascade-safe diagnostic).
 *      - `size` reflects insert / delete count.
 */
describe('SqliteDrizzleJobStore — backend-specific', () => {
  // ----------------------------------------------------------------------
  // 1. Conformance — every contract case from Spec 004 §7.1.
  // ----------------------------------------------------------------------
  runStoreConformance(
    'store-sqlite-drizzle',
    () => new SqliteDrizzleJobStore({ databaseUrl: ':memory:' }),
    { batch: true },
  );
  // Spec 1722 / FR-15 — the same contract when every batch spans many chunks.
  runStoreConformance(
    'store-sqlite-drizzle (batchSize 2)',
    () => new SqliteDrizzleJobStore({ databaseUrl: ':memory:', batchSize: 2 }),
    { batch: true },
  );

  // ----------------------------------------------------------------------
  // 2. @StorePlugin() metadata wiring.
  // ----------------------------------------------------------------------
  describe('@StorePlugin metadata', () => {
    it('exposes { id, description } via raw Reflect.getMetadata', () => {
      const meta = Reflect.getMetadata(
        STORE_PLUGIN_METADATA_KEY,
        SqliteDrizzleJobStore,
      ) as IStoreMetadata | undefined;
      expect(meta).toEqual({
        id: STORE_SQLITE_DRIZZLE_ID,
        description: STORE_SQLITE_DRIZZLE_DESCRIPTION,
      });
    });

    it('exposes { id, description } via NestJS Reflector', () => {
      const reflector = new Reflector();
      const meta = reflector.get<IStoreMetadata>(
        STORE_PLUGIN_METADATA_KEY,
        SqliteDrizzleJobStore,
      );
      expect(meta?.id).toBe('sqlite');
      expect(meta?.description).toBe(STORE_SQLITE_DRIZZLE_DESCRIPTION);
    });
  });

  // ----------------------------------------------------------------------
  // 3. StoreSqliteDrizzleModule — Nest DI wiring.
  // ----------------------------------------------------------------------
  describe('StoreSqliteDrizzleModule', () => {
    it('resolves SqliteDrizzleJobStore as a NestJS singleton', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StoreSqliteDrizzleModule],
      }).compile();
      const a = moduleRef.get(SqliteDrizzleJobStore);
      const b = moduleRef.get(SqliteDrizzleJobStore);
      expect(a).toBe(b);
      expect(a).toBeInstanceOf(SqliteDrizzleJobStore);
      a.close();
      await moduleRef.close();
    });
  });

  // ----------------------------------------------------------------------
  // 4. Cursor envelope round-trip + invalid-cursor rejection.
  // ----------------------------------------------------------------------
  describe('cursor envelope', () => {
    let store: SqliteDrizzleJobStore;

    beforeEach(() => {
      store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
    });

    afterEach(() => {
      store.close();
    });

    it('encodes nextCursor as base64-of-JSON { v: 1, mergedAt, canonicalJobId }', async () => {
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
      const page2 = await store.listByQuery({ limit: 2, cursor: page.nextCursor });
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
          JSON.stringify({ mergedAt: '2026-01-01T00:00:00.000Z', canonicalJobId: 'a' }),
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
          JSON.stringify({ v: 1, mergedAt: '2026-01-01T00:00:00.000Z', canonicalJobId: '' }),
          'utf8',
        ).toString('base64'),
      ],
    ])('rejects %s with ERR_STORE_INVALID_CURSOR', async (_label, cursor) => {
      await expect(store.listByQuery({ cursor })).rejects.toMatchObject({
        code: ERR_STORE_INVALID_CURSOR,
        name: 'SqliteStoreCursorError',
      });
    });
  });

  // ----------------------------------------------------------------------
  // 5. SQL-enforced FK cascade — the in-memory backend simulates this in
  //    JS; here SQLite owns the contract via PRAGMA foreign_keys = ON.
  // ----------------------------------------------------------------------
  describe('SQL FK cascade', () => {
    it('ON DELETE CASCADE drops attached source_observation rows', async () => {
      const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
      try {
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
        // Cascade — listByCanonicalId returns [] AND a deleteByCanonicalId
        // returns 0 (the rows are physically gone, not just hidden).
        expect(await store.listByCanonicalId('job-1')).toEqual([]);
        expect(await store.deleteByCanonicalId('job-1')).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  // ----------------------------------------------------------------------
  // 6. Keyset pagination tie-break — many rows sharing identical
  //    mergedAt MUST resume deterministically across pages.
  // ----------------------------------------------------------------------
  describe('keyset pagination tie-break', () => {
    it('resumes deterministically when many rows share an identical mergedAt', async () => {
      const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
      try {
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
      } finally {
        store.close();
      }
    });
  });

  // ----------------------------------------------------------------------
  // 7. size / clear — diagnostic surface.
  // ----------------------------------------------------------------------
  describe('size / clear', () => {
    it('size reflects insert / delete counts', async () => {
      const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
      try {
        expect(store.size).toBe(0);
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
        expect(store.size).toBe(2);
        await store.delete('a');
        expect(store.size).toBe(1);
      } finally {
        store.close();
      }
    });

    it('clear() drops every canonical row AND attached observations', async () => {
      const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
      try {
        await store.upsert({
          canonicalJobId: 'a',
          title: 'T',
          company: 'C',
          location: 'L',
          url: 'u',
          sources: [],
          fields: {},
          mergedAt: '2026-01-01T00:00:00.000Z',
        });
        await store.putAll('a', [
          {
            site: Site.LINKEDIN,
            sourceJobId: 's1',
            url: 'u',
            observedAt: '2026-01-01T00:00:00.000Z',
          },
        ]);
        store.clear();
        expect(store.size).toBe(0);
        expect(await store.listByCanonicalId('a')).toEqual([]);
      } finally {
        store.close();
      }
    });
  });
});

/**
 * Spec 1722 / FR-15 — list-mode-sized writes. Before the fix `upsertMany`
 * bound every id of the batch in ONE `IN (…)` pre-check (SQLite caps a
 * statement at 32 766 variables, so 33 000 rows failed with "too many SQL
 * variables") and wrote the batch in one synchronous transaction (a 10 000-row
 * persist blocked the event loop for ~4 s).
 */
describe('SqliteDrizzleJobStore — list-mode scale (Spec 1722 / FR-15)', () => {
  const job = (i: number, title = `Engineer ${i}`): CanonicalJob => ({
    canonicalJobId: `k${i.toString().padStart(6, '0')}`,
    title,
    company: 'Acme',
    location: 'Berlin',
    url: `https://example.com/${i}`,
    description: 'x'.repeat(200),
    mergedAt: '2026-09-25T00:00:00.000Z',
    fields: {},
    sources: [],
  });

  it('upserts 33 000 rows (more than SQLite binds in one statement), then reports them all as updates', async () => {
    const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
    try {
      const rows = Array.from({ length: 33_000 }, (_, i) => job(i));
      expect(await store.upsertMany(rows)).toEqual({ inserted: 33_000, updated: 0 });
      expect(store.size).toBe(33_000);

      const again = rows.map((r) => ({ ...r, title: `${r.title} (v2)` }));
      expect(await store.upsertMany(again)).toEqual({ inserted: 0, updated: 33_000 });
      expect((await store.getById('k032999'))?.title).toBe('Engineer 32999 (v2)');
    } finally {
      store.close();
    }
  });

  it('putAllMany writes 33 000 observation sets and replaces them on the next run', async () => {
    const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:' });
    try {
      const rows = Array.from({ length: 33_000 }, (_, i) => job(i));
      await store.upsertMany(rows);
      const entries = (suffix: string) =>
        rows.map((r) => ({
          canonicalJobId: r.canonicalJobId,
          observations: [
            {
              site: Site.LINKEDIN,
              sourceJobId: `${r.canonicalJobId}-${suffix}`,
              url: r.url,
              observedAt: '2026-09-24T00:00:00.000Z',
            },
          ],
        }));
      await store.putAllMany(entries('a'));
      await store.putAllMany(entries('b'));
      expect((await store.listByCanonicalId('k000000')).map((o) => o.sourceJobId)).toEqual(['k000000-b']);
      expect((await store.listByCanonicalId('k032999')).map((o) => o.sourceJobId)).toEqual(['k032999-b']);
    } finally {
      store.close();
    }
  });

  it('gives the event loop a turn between chunks (a probe scheduled after the call runs before it resolves)', async () => {
    const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:', batchSize: 100 });
    try {
      const rows = Array.from({ length: 1_000 }, (_, i) => job(i));
      let rowsWhenProbeRan = -1;
      const done = store.upsertMany(rows);
      setImmediate(() => {
        rowsWhenProbeRan = store.size;
      });
      await done;
      // Red before the fix: the whole batch ran synchronously inside the call,
      // so the probe only ran afterwards and saw all 1 000 rows (or -1).
      expect(rowsWhenProbeRan).toBeGreaterThan(0);
      expect(rowsWhenProbeRan).toBeLessThan(1_000);
      expect(store.size).toBe(1_000);
    } finally {
      store.close();
    }
  });

  it('a chunk that fails leaves earlier chunks written and later ones untouched', async () => {
    const store = new SqliteDrizzleJobStore({ databaseUrl: ':memory:', batchSize: 10 });
    try {
      const rows = Array.from({ length: 30 }, (_, i) => job(i));
      // NOT NULL violation in the second chunk.
      (rows[15] as { url: unknown }).url = null;
      await expect(store.upsertMany(rows)).rejects.toThrow(/NOT NULL/i);
      expect(store.size).toBe(10);
      expect(await store.getById('k000015')).toBeNull();
    } finally {
      store.close();
    }
  });
});
