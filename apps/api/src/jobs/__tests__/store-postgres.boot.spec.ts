import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ERR_STORE_BACKEND_DOWN,
  IJobObservationStore,
  IJobStore,
  JOB_OBSERVATION_STORE_TOKEN,
  JOB_STORE_TOKEN,
  JobPostDto,
  LocationDto,
  Site,
} from '@ever-jobs/models';
import { StoreModule } from '@ever-jobs/plugin';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import { PostgresPrismaJobStore } from '@ever-jobs/store-postgres-prisma';
import configuration from '../../config/configuration';
import { connectPostgresStoreClient, resolveStoreBootstrap, resolveStoreProviders } from '../store-bootstrap.factory';
import { JobsAggregator } from '../jobs.aggregator';

/**
 * Spec 1722 — the forker path against a REAL Postgres, end to end:
 *
 *   env (EVER_JOBS_STORE=postgres + EVER_JOBS_STORE_DATABASE_URL)
 *     → resolveStoreBootstrap / resolveStoreProviders   (exactly what app.module.ts runs)
 *     → StoreModule.forActive(...)                       (generated @prisma/client, $connect)
 *     → JobsAggregator.aggregateRaw(..., { persist })    (real dedup engine)
 *     → rows readable back by dedupKey.
 *
 * Gated on `EVER_JOBS_TEST_PG_URL` pointing at a database whose schema was
 * created with `npm run store:postgres:migrate`, and on a generated Prisma
 * client (`npm run store:postgres:generate`). Rows it writes are deleted
 * again; nothing is truncated.
 */
const PG_URL = process.env.EVER_JOBS_TEST_PG_URL?.trim() || undefined;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('Postgres store — boot from env against a real database (Spec 1722)', () => {
  const run = randomUUID().slice(0, 8);
  const env = { EVER_JOBS_STORE: 'postgres', EVER_JOBS_STORE_DATABASE_URL: PG_URL! };
  let moduleRef: TestingModule;
  let store: IJobStore;
  let observations: IJobObservationStore;
  const written: string[] = [];

  beforeAll(async () => {
    const boot = resolveStoreBootstrap(env);
    expect(boot.id).toBe('postgres');
    expect(boot.persistSearch).toBe(true);

    moduleRef = await Test.createTestingModule({
      imports: [
        StoreModule.forActive(boot.id, {
          backends: [boot.backendClass],
          providers: resolveStoreProviders(boot.id, env),
        }),
      ],
    }).compile();
    store = moduleRef.get<IJobStore>(JOB_STORE_TOKEN);
    observations = moduleRef.get<IJobObservationStore>(JOB_OBSERVATION_STORE_TOKEN);
  }, 60_000);

  afterAll(async () => {
    for (const id of written) await store?.delete(id);
    await moduleRef?.close();
  });

  it('binds the Prisma-backed store from env alone', () => {
    expect(store).toBeInstanceOf(PostgresPrismaJobStore);
  });

  it('configuration() turns persistence on for an explicitly selected postgres store', () => {
    const saved = { s: process.env.EVER_JOBS_STORE, p: process.env.EVER_JOBS_PERSIST_SEARCH };
    try {
      process.env.EVER_JOBS_STORE = 'postgres';
      delete process.env.EVER_JOBS_PERSIST_SEARCH;
      expect(configuration().store.persistSearch).toBe(true);
    } finally {
      if (saved.s === undefined) delete process.env.EVER_JOBS_STORE;
      else process.env.EVER_JOBS_STORE = saved.s;
      if (saved.p !== undefined) process.env.EVER_JOBS_PERSIST_SEARCH = saved.p;
    }
  });

  it('persists a search through the aggregator; rows are keyed by the returned dedupKey', async () => {
    const aggregator = new JobsAggregator({} as never, new DedupHybridService(), store, observations);
    const title = `Platform Engineer ${run}`;
    const raw = [
      new JobPostDto({
        id: `li-${run}`,
        site: Site.LINKEDIN,
        title,
        companyName: 'Acme Corp',
        jobUrl: `https://www.linkedin.com/jobs/view/${run}`,
        location: new LocationDto({ city: 'Austin', state: 'TX' }),
        datePosted: '2026-09-20',
      }),
      new JobPostDto({
        id: `gh-${run}`,
        site: Site.GREENHOUSE,
        title,
        companyName: 'ACME CORP',
        jobUrl: `https://boards.greenhouse.io/acme/jobs/${run}`,
        location: new LocationDto({ city: 'austin', state: 'tx' }),
        datePosted: '2026-09-21',
      }),
    ];

    const result = await aggregator.aggregateRaw(raw, { dedup: true, persist: true, careerLevels: undefined });

    expect(result.persisted).toBe(true);
    expect(result.persistError).toBeUndefined();
    expect(result.jobs).toHaveLength(1);
    const key = result.jobs[0]!.dedupKey!;
    written.push(key);

    const row = await store.getById(key);
    expect(row?.canonicalJobId).toBe(key);
    expect(row?.url).toBe(raw[0]!.jobUrl);
    const obs = await observations.listByCanonicalId(key);
    expect(obs.map((o) => o.site).sort()).toEqual([Site.GREENHOUSE, Site.LINKEDIN].sort());

    // A later run of the same posting upserts the same row (no duplicate).
    const again = await aggregator.aggregateRaw(
      [new JobPostDto({ ...raw[1]!, id: `gh-${run}-rerun` })],
      { dedup: true, persist: true, careerLevels: undefined },
    );
    expect(again.jobs[0]!.dedupKey).toBe(key);
    expect(again.persistCounts).toEqual({ inserted: 0, updated: 1 });
  });

  it('an unreachable server fails with ERR_STORE_BACKEND_DOWN and never prints the password', async () => {
    const url = new URL(PG_URL!);
    const password = decodeURIComponent(url.password);
    url.port = '1'; // nothing listens on port 1
    let caught: unknown;
    try {
      await connectPostgresStoreClient(url.toString());
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe(ERR_STORE_BACKEND_DOWN);
    const message = (caught as Error).message;
    expect(message).toContain(`${url.hostname}:1`);
    if (password) expect(message).not.toContain(password);
  }, 60_000);
});
