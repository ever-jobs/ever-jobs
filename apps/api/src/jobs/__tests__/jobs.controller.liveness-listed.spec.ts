import 'reflect-metadata';
import { EventEmitter } from 'events';
import { StreamableFile } from '@nestjs/common';
import { CRAWL_ENV, resetCrawlPolicyEnvCache } from '@ever-jobs/common';
import {
  JOB_LIVENESS_REASON_FRESH_FETCH,
  JOB_LIVENESS_REASON_LISTED,
  JobPostDto,
  ScraperInputDto,
} from '@ever-jobs/models';
import {
  DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS,
  LIVENESS_TRUST_FRESH_FETCH_ENV,
  LIVENESS_TRUST_LISTED_MAX_AGE_ENV,
  resetSwitchWarnings,
} from '../crawl-policy.mapping';
import { JobsController } from '../jobs.controller';
import { SEARCH_CACHE_ENDPOINT } from '../search-cache';
import { COMPLETE_SEARCH } from '../search-completeness';

/**
 * Spec 1715 review A3 — `?liveness=true` trusts a recent LISTING (`jobUrlListedAt`,
 * the instant the source's own index — Softy's `/sitemap.xml` — that lists the
 * offer was fetched from the network), not only a fresh fetch of the page itself.
 * A repeat search served by Softy's sitemap / detail caches or by the search cache
 * then costs Softy's shared server no liveness probes while the listing is young.
 *
 * - Trusted when `now - jobUrlListedAt <= EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS`
 *   (default 600 000 = the Softy sitemap cache TTL), measured against NOW, so a
 *   search-cache hit is trusted too. Marked `{ state: 'active', checkedAt:
 *   jobUrlListedAt, reason: 'listed' }`. Both the JSON and the NDJSON path.
 * - `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0` is the pre-fix behaviour (the
 *   job is probed); so is the `legacy` crawl preset without an explicit value.
 *
 * Red control of the key test: set {@link LISTED_MAX_AGE_FOR_KEY_TEST} to `'0'` →
 * the listed job is probed and has no `reason` (the test goes red).
 */
const LISTED_MAX_AGE_FOR_KEY_TEST: string | undefined = undefined;

type Format = 'json' | 'ndjson';

const PROBE_CHECKED_AT = '2026-09-24T00:00:00Z';
const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString();

function makeJob(id: string, extra: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({ id, title: `SWE ${id}`, companyName: 'Acme', jobUrl: `https://acme.softy.pro/offers/${id}`, ...extra });
}

/**
 * A controller whose fan-out builds its jobs when it runs (after the request start);
 * `cached` is served as a search-cache hit instead (no fan-out at all).
 */
function createController(opts: {
  produce?: () => JobPostDto[];
  cached?: JobPostDto[];
  config?: Record<string, unknown>;
}) {
  const probed: string[][] = [];
  const liveness = {
    check: jest.fn(),
    checkBatch: jest.fn(async (urls: string[]) => {
      probed.push(urls);
      return urls.map((url) => ({ url, result: 'active' as const, code: 'ok', checkedAt: PROBE_CHECKED_AT }));
    }),
  };
  const jobsService = {
    assertSearchable: jest.fn(),
    searchJobsWithDiagnostics: jest.fn(async () => ({
      jobs: (opts.produce ?? (() => []))(),
      perSource: [],
      completeness: { ...COMPLETE_SEARCH },
    })),
  };
  const aggregator = {
    aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
      jobs: raw,
      rawCount: raw.length,
      outputCount: raw.length,
      deduped: false,
    })),
  };
  const cacheService = {
    get: jest.fn(async (params: { endpoint?: string }) =>
      params.endpoint === SEARCH_CACHE_ENDPOINT && opts.cached
        ? { jobs: opts.cached, completeness: { ...COMPLETE_SEARCH } }
        : null,
    ),
    set: jest.fn(async () => undefined),
  };
  const config = opts.config ?? {};
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    {} as any,
    cacheService as any,
    { get: (key: string, def?: unknown) => (key in config ? config[key] : def) } as any,
    liveness as any,
  );
  const warn = jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);
  return { controller, liveness, probed, warn, log, jobsService };
}

class FakeResponse extends EventEmitter {
  setHeader(): void {
    /* headers are covered by jobs.controller.ndjson.spec.ts */
  }
}

async function readAll(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** `?liveness=true` on the given path; returns the jobs as the client receives them. */
async function searchWithLiveness(controller: JobsController, format: Format): Promise<JobPostDto[]> {
  const input = new ScraperInputDto({ searchTerm: 'x' });
  if (format === 'json') {
    const result = (await controller.searchJobs(input, undefined, undefined, undefined, undefined, undefined, 'true')) as {
      jobs: JobPostDto[];
    };
    return result.jobs;
  }
  const file = (await controller.searchJobs(
    input,
    'ndjson',
    undefined,
    undefined,
    undefined,
    undefined,
    'true',
    undefined,
    new FakeResponse() as any,
  )) as StreamableFile;
  const lines = (await readAll(file))
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; data?: JobPostDto; message?: string });
  const error = lines.find((l) => l.type === 'error');
  if (error) throw new Error(`NDJSON error line: ${error.message}`);
  expect(lines[lines.length - 1]!.type).toBe('end');
  return lines.filter((l) => l.type === 'job').map((l) => l.data!);
}

const livenessById = (jobs: JobPostDto[]) => Object.fromEntries(jobs.map((j) => [j.id, j.liveness ?? null]));
const url = (id: string) => `https://acme.softy.pro/offers/${id}`;

const ENV_KEYS = [LIVENESS_TRUST_LISTED_MAX_AGE_ENV, LIVENESS_TRUST_FRESH_FETCH_ENV, CRAWL_ENV.PRESET];

describe('JobsController — liveness trusts a recent listing (Spec 1715 review A3)', () => {
  let saved: Record<string, string | undefined>;

  function setEnv(vars: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetCrawlPolicyEnvCache();
  }

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    setEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])));
    resetSwitchWarnings();
  });

  afterEach(() => {
    setEnv(saved);
    resetSwitchWarnings();
  });

  it('the default max age is 10 minutes', () => {
    expect(DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS).toBe(600_000);
    expect(JOB_LIVENESS_REASON_LISTED).toBe('listed');
  });

  it.each<Format>(['json', 'ndjson'])(
    '%s: a job listed a minute ago is marked active without a probe (key test)',
    async (format) => {
      setEnv({ [LIVENESS_TRUST_LISTED_MAX_AGE_ENV]: LISTED_MAX_AGE_FOR_KEY_TEST });
      const listedAt = agoIso(60_000);
      const { controller, probed, log } = createController({
        produce: () => [makeJob('listed', { jobUrlListedAt: listedAt }), makeJob('none')],
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([[url('none')]]);
      const byId = livenessById(jobs);
      expect(byId.listed).toEqual({ state: 'active', checkedAt: listedAt, reason: JOB_LIVENESS_REASON_LISTED });
      expect(byId.none).toEqual({ state: 'active', checkedAt: PROBE_CHECKED_AT });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0'));
    },
  );

  it.each<Format>(['json', 'ndjson'])(
    '%s: the default 10 min bound — listed 9 min ago is trusted, 11 min ago is probed',
    async (format) => {
      const young = agoIso(9 * 60_000);
      const old = agoIso(11 * 60_000);
      const { controller, probed } = createController({
        produce: () => [makeJob('young', { jobUrlListedAt: young }), makeJob('old', { jobUrlListedAt: old })],
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([[url('old')]]);
      expect(livenessById(jobs)).toEqual({
        young: { state: 'active', checkedAt: young, reason: JOB_LIVENESS_REASON_LISTED },
        old: { state: 'active', checkedAt: PROBE_CHECKED_AT },
      });
    },
  );

  it.each<Format>(['json', 'ndjson'])('%s: the operator bound applies (60 s → a 2 min old listing is probed)', async (format) => {
    setEnv({ [LIVENESS_TRUST_LISTED_MAX_AGE_ENV]: '60000' });
    const within = agoIso(30_000);
    const past = agoIso(120_000);
    const { controller, probed } = createController({
      produce: () => [makeJob('within', { jobUrlListedAt: within }), makeJob('past', { jobUrlListedAt: past })],
    });

    const jobs = await searchWithLiveness(controller, format);

    expect(probed).toEqual([[url('past')]]);
    expect(livenessById(jobs).within).toEqual({ state: 'active', checkedAt: within, reason: JOB_LIVENESS_REASON_LISTED });
  });

  it.each<Format>(['json', 'ndjson'])(
    '%s: a search-cache hit trusts a young listing (age measured against now) but still no fetch time',
    async (format) => {
      const listedAt = agoIso(60_000);
      // Dated in the future: a fetch time would be trusted by any request start if the cache hit were not excluded.
      const future = new Date(Date.now() + 60_000).toISOString();
      const { controller, probed, jobsService } = createController({
        cached: [
          makeJob('listed', { jobUrlListedAt: listedAt }),
          makeJob('fetched', { jobUrlFetchedAt: future }),
          makeJob('stale', { jobUrlListedAt: agoIso(3_600_000) }),
        ],
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
      expect(probed).toEqual([[url('fetched'), url('stale')]]);
      expect(livenessById(jobs)).toEqual({
        listed: { state: 'active', checkedAt: listedAt, reason: JOB_LIVENESS_REASON_LISTED },
        fetched: { state: 'active', checkedAt: PROBE_CHECKED_AT },
        stale: { state: 'active', checkedAt: PROBE_CHECKED_AT },
      });
    },
  );

  it.each<Format>(['json', 'ndjson'])(
    `%s: ${LIVENESS_TRUST_LISTED_MAX_AGE_ENV}=0 restores the pre-fix behaviour: a listed job is probed`,
    async (format) => {
      setEnv({ [LIVENESS_TRUST_LISTED_MAX_AGE_ENV]: '0' });
      const { controller, probed } = createController({
        produce: () => [makeJob('listed', { jobUrlListedAt: agoIso(1_000) }), makeJob('none')],
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([[url('listed'), url('none')]]);
      expect(jobs.every((j) => j.liveness?.reason === undefined)).toBe(true);
    },
  );

  it.each<Format>(['json', 'ndjson'])('%s: a cache hit with the switch at 0 probes everything, as before', async (format) => {
    setEnv({ [LIVENESS_TRUST_LISTED_MAX_AGE_ENV]: '0' });
    const { controller, probed } = createController({ cached: [makeJob('listed', { jobUrlListedAt: agoIso(1_000) })] });

    await searchWithLiveness(controller, format);

    expect(probed).toEqual([[url('listed')]]);
  });

  it.each<Format>(['json', 'ndjson'])('%s: a listing time in the future is not trusted (probed)', async (format) => {
    const { controller, probed } = createController({
      produce: () => [makeJob('ahead', { jobUrlListedAt: new Date(Date.now() + 60_000).toISOString() })],
    });

    await searchWithLiveness(controller, format);

    expect(probed).toEqual([[url('ahead')]]);
  });

  it.each<Format>(['json', 'ndjson'])('%s: an unparseable listing time is not trusted (probed)', async (format) => {
    const { controller, probed } = createController({ produce: () => [makeJob('junk', { jobUrlListedAt: 'yesterday-ish' })] });

    await searchWithLiveness(controller, format);

    expect(probed).toEqual([[url('junk')]]);
  });

  it.each<Format>(['json', 'ndjson'])(
    '%s: a job fetched during this request keeps the fresh-fetch reason even when it is listed too',
    async (format) => {
      let fetchedAt = '';
      const listedAt = agoIso(5_000);
      const { controller, liveness } = createController({
        produce: () => {
          fetchedAt = new Date().toISOString();
          return [makeJob('both', { jobUrlFetchedAt: fetchedAt, jobUrlListedAt: listedAt })];
        },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(liveness.checkBatch).not.toHaveBeenCalled();
      expect(jobs[0]!.liveness).toEqual({ state: 'active', checkedAt: fetchedAt, reason: JOB_LIVENESS_REASON_FRESH_FETCH });
    },
  );

  it.each<Format>(['json', 'ndjson'])(
    `%s: the two switches are independent — ${LIVENESS_TRUST_FRESH_FETCH_ENV}=false still trusts a listing`,
    async (format) => {
      setEnv({ [LIVENESS_TRUST_FRESH_FETCH_ENV]: 'false' });
      const listedAt = agoIso(5_000);
      const { controller, probed } = createController({
        produce: () => [makeJob('both', { jobUrlFetchedAt: new Date().toISOString(), jobUrlListedAt: listedAt }), makeJob('fetched', { jobUrlFetchedAt: new Date().toISOString() })],
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([[url('fetched')]]);
      expect(livenessById(jobs).both).toEqual({ state: 'active', checkedAt: listedAt, reason: JOB_LIVENESS_REASON_LISTED });
    },
  );

  it.each<Format>(['json', 'ndjson'])('%s: with both switches off every URL is probed (pre-1714)', async (format) => {
    setEnv({ [LIVENESS_TRUST_FRESH_FETCH_ENV]: 'false', [LIVENESS_TRUST_LISTED_MAX_AGE_ENV]: '0' });
    const { controller, probed } = createController({
      produce: () => [makeJob('both', { jobUrlFetchedAt: new Date().toISOString(), jobUrlListedAt: agoIso(5_000) })],
    });

    const jobs = await searchWithLiveness(controller, format);

    expect(probed).toEqual([[url('both')]]);
    expect(jobs[0]!.liveness).toEqual({ state: 'active', checkedAt: PROBE_CHECKED_AT });
  });

  it.each<Format>(['json', 'ndjson'])(
    '%s: EVER_JOBS_CRAWL_PRESET=legacy turns both off by default (every URL probed); explicit values win',
    async (format) => {
      setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
      const make = () => [
        makeJob('fetched', { jobUrlFetchedAt: new Date().toISOString() }),
        makeJob('listed', { jobUrlListedAt: agoIso(5_000) }),
      ];
      const legacy = createController({ produce: make });
      await searchWithLiveness(legacy.controller, format);
      expect(legacy.probed).toEqual([[url('fetched'), url('listed')]]);

      setEnv({ [LIVENESS_TRUST_LISTED_MAX_AGE_ENV]: '600000', [LIVENESS_TRUST_FRESH_FETCH_ENV]: 'true' });
      const explicit = createController({ produce: make });
      const jobs = await searchWithLiveness(explicit.controller, format);
      expect(explicit.liveness.checkBatch).not.toHaveBeenCalled();
      expect(jobs.map((j) => j.liveness?.reason)).toEqual([JOB_LIVENESS_REASON_FRESH_FETCH, JOB_LIVENESS_REASON_LISTED]);
    },
  );

  it.each<Format>(['json', 'ndjson'])(
    '%s: EVER_JOBS_LIVENESS_MAX_URLS counts only the jobs that still need a probe (listed jobs cost none)',
    async (format) => {
      const listedAt = agoIso(5_000);
      const { controller, probed, warn } = createController({
        produce: () => [
          makeJob('l1', { jobUrlListedAt: listedAt }),
          makeJob('a'),
          makeJob('l2', { jobUrlListedAt: listedAt }),
          makeJob('b'),
          makeJob('c'),
        ],
        config: { 'liveness.maxUrls': 2 },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([[url('a'), url('b')]]);
      expect(jobs.map((j) => [j.id, j.liveness?.reason ?? j.liveness?.state ?? null])).toEqual([
        ['l1', 'listed'],
        ['a', 'active'],
        ['l2', 'listed'],
        ['b', 'active'],
        ['c', null],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('probing 2 of 3'));
    },
  );

  it.each<Format>(['json', 'ndjson'])(
    '%s: EVER_JOBS_LIVENESS_ENABLED=false withholds the listed verdict too: no liveness field at all',
    async (format) => {
      const { controller, liveness } = createController({
        produce: () => [makeJob('listed', { jobUrlListedAt: agoIso(5_000) })],
        config: { 'liveness.enabled': false },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(liveness.checkBatch).not.toHaveBeenCalled();
      expect(jobs[0]!.liveness).toBeUndefined();
    },
  );

  it.each<Format>(['json', 'ndjson'])('%s: every job listed — no probe batch runs', async (format) => {
    const listedAt = agoIso(5_000);
    const { controller, liveness } = createController({
      cached: [makeJob('l1', { jobUrlListedAt: listedAt }), makeJob('l2', { jobUrlListedAt: listedAt })],
    });

    const jobs = await searchWithLiveness(controller, format);

    expect(liveness.checkBatch).not.toHaveBeenCalled();
    expect(jobs.every((j) => j.liveness?.reason === JOB_LIVENESS_REASON_LISTED)).toBe(true);
  });
});
