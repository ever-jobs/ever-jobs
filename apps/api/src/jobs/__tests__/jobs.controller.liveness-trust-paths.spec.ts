import 'reflect-metadata';
import { EventEmitter } from 'events';
import { StreamableFile } from '@nestjs/common';
import { JOB_LIVENESS_REASON_FRESH_FETCH, JobPostDto, ScraperInputDto } from '@ever-jobs/models';
import { LIVENESS_TRUST_FRESH_FETCH_ENV } from '../crawl-policy.mapping';
import { JobsController } from '../jobs.controller';
import { SEARCH_CACHE_ENDPOINT } from '../search-cache';
import { COMPLETE_SEARCH } from '../search-completeness';

/**
 * Spec 1714 FR-16 (liveness trusts a fresh plugin fetch) meets Specs 1721 and 1723
 * (the NDJSON stream and the `EVER_JOBS_LIVENESS_MAX_URLS` cap). Both came from
 * different branches; this suite pins how they combine:
 *
 * 1. The NDJSON path trusts `jobUrlFetchedAt` exactly like JSON: from the stream's
 *    start (taken before the cache lookup), never on a search-cache hit.
 * 2. The cap counts only the jobs that still need a probe: a job marked active from
 *    a fresh fetch costs no request, so it does not use up a probe slot.
 * 3. The server gate (`EVER_JOBS_LIVENESS_ENABLED=false`) still means "no `liveness`
 *    field": the fresh-fetch verdict is withheld too.
 *
 * `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` restores the pre-1714 behaviour on both
 * paths: every URL is probed and the cap takes the first N jobs in output order. (These
 * jobs carry no `jobUrlListedAt`; a recently LISTED job is trusted on its own switch,
 * `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` — see jobs.controller.liveness-listed.spec.ts.)
 *
 * Red controls (each run once by mutating `jobs.controller.ts`, then reverted):
 * - NDJSON call site `applyCorpusSignals(jobs, …)` without its trust argument → the
 *   first test probes `fresh` and goes red.
 * - NDJSON call site passing `startedAt` also on a cache hit → the cache-hit test
 *   marks the future-dated cached job `fresh-fetch` and goes red.
 * - The cap applied to `jobs` before `markFreshlyFetched` → the cap tests probe only
 *   `a` and leave `b` without liveness, and go red.
 * - `markFreshlyFetched` called ahead of the server gate in `applyCorpusSignals` → the
 *   gate tests find a `fresh-fetch` verdict and go red.
 */

type Format = 'json' | 'ndjson';

const PROBE_CHECKED_AT = '2026-09-24T00:00:00Z';
const STALE = new Date(Date.now() - 3_600_000).toISOString();

function makeJob(id: string, extra: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({ id, title: `SWE ${id}`, companyName: 'Acme', jobUrl: `https://jobs.example/${id}`, ...extra });
}

/**
 * A controller whose fan-out builds its jobs when it runs — after the controller took
 * its request start — so a `jobUrlFetchedAt` of "now" is fresh. `cached` is served as
 * a search-cache hit (with a completeness record, so NDJSON accepts it too).
 */
function createController(opts: {
  produce: () => JobPostDto[];
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
      jobs: opts.produce(),
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
  jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);
  return { controller, liveness, probed, warn, jobsService };
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

const livenessById = (jobs: JobPostDto[]) => Object.fromEntries(jobs.map((j) => [j.id, j.liveness]));

describe('JobsController — fresh-fetch liveness trust across the JSON / NDJSON paths and the probe cap', () => {
  const saved = process.env[LIVENESS_TRUST_FRESH_FETCH_ENV];
  const setTrust = (value: string | undefined) => {
    if (value === undefined) delete process.env[LIVENESS_TRUST_FRESH_FETCH_ENV];
    else process.env[LIVENESS_TRUST_FRESH_FETCH_ENV] = value;
  };
  beforeEach(() => setTrust(undefined));
  afterAll(() => setTrust(saved));

  it.each<Format>(['ndjson', 'json'])(
    '%s: a job fetched during this request is marked active without a probe; the others are probed in order',
    async (format) => {
      let fetchedAt = '';
      const { controller, probed } = createController({
        produce: () => {
          fetchedAt = new Date().toISOString();
          return [makeJob('fresh', { jobUrlFetchedAt: fetchedAt }), makeJob('stale', { jobUrlFetchedAt: STALE }), makeJob('none')];
        },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([['https://jobs.example/stale', 'https://jobs.example/none']]);
      const byId = livenessById(jobs);
      expect(byId.fresh).toEqual({ state: 'active', checkedAt: fetchedAt, reason: JOB_LIVENESS_REASON_FRESH_FETCH });
      expect(byId.stale).toEqual({ state: 'active', checkedAt: PROBE_CHECKED_AT });
      expect(byId.none).toEqual({ state: 'active', checkedAt: PROBE_CHECKED_AT });
    },
  );

  it.each<Format>(['ndjson', 'json'])('%s: a search-cache hit trusts nothing — every URL is probed', async (format) => {
    // Dated in the future: trusted by any request start if the cache hit were not excluded.
    const future = new Date(Date.now() + 60_000).toISOString();
    const { controller, probed, jobsService } = createController({
      produce: () => [],
      cached: [makeJob('fresh', { jobUrlFetchedAt: future }), makeJob('none')],
    });

    const jobs = await searchWithLiveness(controller, format);

    expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
    expect(probed).toEqual([['https://jobs.example/fresh', 'https://jobs.example/none']]);
    expect(jobs.every((j) => j.liveness?.reason === undefined)).toBe(true);
  });

  it.each<Format>(['ndjson', 'json'])(
    '%s: EVER_JOBS_LIVENESS_MAX_URLS counts only the jobs that still need a probe',
    async (format) => {
      const now = () => new Date().toISOString();
      const { controller, probed, warn } = createController({
        produce: () => [
          makeJob('fresh1', { jobUrlFetchedAt: now() }),
          makeJob('a'),
          makeJob('fresh2', { jobUrlFetchedAt: now() }),
          makeJob('b'),
          makeJob('c'),
        ],
        config: { 'liveness.maxUrls': 2 },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([['https://jobs.example/a', 'https://jobs.example/b']]);
      expect(jobs.map((j) => [j.id, j.liveness?.reason ?? j.liveness?.state ?? null])).toEqual([
        ['fresh1', 'fresh-fetch'],
        ['a', 'active'],
        ['fresh2', 'fresh-fetch'],
        ['b', 'active'],
        ['c', null],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('probing 2 of 3'));
    },
  );

  it.each<Format>(['ndjson', 'json'])(
    `%s: ${LIVENESS_TRUST_FRESH_FETCH_ENV}=false (pre-1714) probes every URL and caps the first N in output order`,
    async (format) => {
      setTrust('false');
      const now = () => new Date().toISOString();
      const { controller, probed, warn } = createController({
        produce: () => [makeJob('fresh1', { jobUrlFetchedAt: now() }), makeJob('a'), makeJob('b')],
        config: { 'liveness.maxUrls': 2 },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(probed).toEqual([['https://jobs.example/fresh1', 'https://jobs.example/a']]);
      expect(jobs.map((j) => j.liveness ?? null)).toEqual([
        { state: 'active', checkedAt: PROBE_CHECKED_AT },
        { state: 'active', checkedAt: PROBE_CHECKED_AT },
        null,
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('probing 2 of 3'));
    },
  );

  it.each<Format>(['ndjson', 'json'])(
    '%s: EVER_JOBS_LIVENESS_ENABLED=false (Spec 1723) also withholds the fresh-fetch verdict: no liveness field at all',
    async (format) => {
      const { controller, liveness } = createController({
        produce: () => [makeJob('fresh', { jobUrlFetchedAt: new Date().toISOString() }), makeJob('none')],
        config: { 'liveness.enabled': false },
      });

      const jobs = await searchWithLiveness(controller, format);

      expect(liveness.checkBatch).not.toHaveBeenCalled();
      expect(jobs.map((j) => j.liveness)).toEqual([undefined, undefined]);
    },
  );

  it.each<Format>(['ndjson', 'json'])('%s: every job fresh — no probe batch runs, even with a cap', async (format) => {
    const now = () => new Date().toISOString();
    const { controller, liveness } = createController({
      produce: () => [makeJob('f1', { jobUrlFetchedAt: now() }), makeJob('f2', { jobUrlFetchedAt: now() })],
      config: { 'liveness.maxUrls': 1 },
    });

    const jobs = await searchWithLiveness(controller, format);

    expect(liveness.checkBatch).not.toHaveBeenCalled();
    expect(jobs.every((j) => j.liveness?.reason === JOB_LIVENESS_REASON_FRESH_FETCH)).toBe(true);
  });
});
