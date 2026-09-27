import 'reflect-metadata';
import { CrawlPolicyDto, JOB_LIVENESS_REASON_FRESH_FETCH, JobPostDto, ScraperInputDto } from '@ever-jobs/models';
import { ScrapeContext, getScrapeContext } from '@ever-jobs/common';
import {
  DEFAULT_LIVENESS_DEADLINE_MS,
  LIVENESS_DEADLINE_ENV,
  LIVENESS_TRUST_FRESH_FETCH_ENV,
  livenessDeadlineMs,
  livenessTrustFreshFetch,
} from '../crawl-policy.mapping';
import { JobsController, LIVENESS_CRAWL_SITE } from '../jobs.controller';

/**
 * Spec 1690 — REST controller plumbing: liveness enrichment runs inside its own
 * scrape context (so its probes obey the global crawl policy), and the search
 * cache key covers the caller's `crawl`.
 */

function makeJob(id: string): JobPostDto {
  return new JobPostDto({ id, title: 'SWE', companyName: 'Acme', jobUrl: `https://jobs.example/${id}` });
}

function createController() {
  const jobs = [makeJob('1'), makeJob('2')];
  const jobsService = { searchJobsWithDiagnostics: jest.fn().mockResolvedValue({ jobs, perSource: [] }) };
  const aggregator = {
    aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({ jobs: raw, rawCount: raw.length, deduped: false })),
  };
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (_key: string, def?: unknown) => def };
  const seen: { ctx?: ScrapeContext } = {};
  const liveness = {
    check: jest.fn(),
    checkBatch: jest.fn(async (urls: string[]) => {
      seen.ctx = getScrapeContext();
      await new Promise((resolve) => setImmediate(resolve));
      return urls.map((url) => ({ url, result: 'active' as const, code: 'apply_control_visible', checkedAt: 'now' }));
    }),
  };
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    {} as any,
    cache as any,
    config as any,
    liveness as any,
  );
  return { controller, liveness, cache, seen, jobsService };
}

/** positional: input, format, paginate, page, pageSize, dedup, liveness */
const withLiveness = (controller: JobsController, input: ScraperInputDto) =>
  controller.searchJobs(input, undefined, undefined, undefined, undefined, undefined, 'true');

describe('JobsController — crawl policy plumbing (Spec 1690)', () => {
  it(`runs liveness probes inside a "${LIVENESS_CRAWL_SITE}" scrape context`, async () => {
    const { controller, liveness, seen } = createController();

    const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as {
      jobs: JobPostDto[];
    };

    expect(LIVENESS_CRAWL_SITE).toBe('liveness-http');
    expect(liveness.checkBatch).toHaveBeenCalledWith(['https://jobs.example/1', 'https://jobs.example/2']);
    // `proxyPin`: every scrape context carries its own per-scrape proxy pin.
    expect(seen.ctx).toEqual({ site: 'liveness-http', signal: expect.any(AbortSignal), proxyPin: expect.any(Object) });
    expect(result.jobs.every((j) => j.liveness?.state === 'active')).toBe(true);
    // The context does not leak past the enrichment.
    expect(getScrapeContext()).toBeUndefined();
  });

  it("does not apply the search caller's crawl to liveness probes", async () => {
    const { controller, seen } = createController();
    const input = new ScraperInputDto({
      searchTerm: 'x',
      retries: 5,
      crawl: Object.assign(new CrawlPolicyDto(), { retries: 5, maxConcurrentPerHost: 1 }),
    });

    await withLiveness(controller, input);

    expect(seen.ctx?.site).toBe('liveness-http');
    expect(seen.ctx?.caller).toBeUndefined();
  });

  describe(`liveness batch deadline (${LIVENESS_DEADLINE_ENV})`, () => {
    const saved = process.env[LIVENESS_DEADLINE_ENV];
    afterEach(() => {
      if (saved === undefined) delete process.env[LIVENESS_DEADLINE_ENV];
      else process.env[LIVENESS_DEADLINE_ENV] = saved;
    });

    it('bounds the probes with an AbortSignal that fires at the deadline', async () => {
      process.env[LIVENESS_DEADLINE_ENV] = '30';
      const { controller, seen } = createController();

      await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }));
      const signal = seen.ctx!.signal!;
      expect(signal.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(signal.aborted).toBe(true);
    });

    it('0 = no deadline (no signal)', async () => {
      process.env[LIVENESS_DEADLINE_ENV] = '0';
      const { controller, seen } = createController();

      await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }));

      expect(seen.ctx).toEqual({ site: 'liveness-http', proxyPin: expect.any(Object) });
    });

    it('livenessDeadlineMs: default 60 s, invalid values ignored', () => {
      expect(livenessDeadlineMs({})).toBe(DEFAULT_LIVENESS_DEADLINE_MS);
      expect(DEFAULT_LIVENESS_DEADLINE_MS).toBe(60_000);
      expect(livenessDeadlineMs({ [LIVENESS_DEADLINE_ENV]: '5000' })).toBe(5000);
      expect(livenessDeadlineMs({ [LIVENESS_DEADLINE_ENV]: '-1' })).toBe(DEFAULT_LIVENESS_DEADLINE_MS);
      expect(livenessDeadlineMs({ [LIVENESS_DEADLINE_ENV]: 'soon' })).toBe(DEFAULT_LIVENESS_DEADLINE_MS);
    });

    it('a probe queued behind a cooling-down host is released at the deadline (reported uncertain)', async () => {
      process.env[LIVENESS_DEADLINE_ENV] = '50';
      const { controller, liveness } = createController();
      (liveness.checkBatch as jest.Mock).mockImplementation(async (urls: string[]) => {
        const signal = getScrapeContext()!.signal!;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return urls.map((url) => ({ url, result: 'uncertain' as const, code: 'aborted', checkedAt: 'now' }));
      });

      const started = Date.now();
      const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as { jobs: JobPostDto[] };

      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.jobs.every((j) => j.liveness?.state === 'uncertain')).toBe(true);
    });
  });

  /**
   * Spec 1714 FR-16 (audit G4, G28) — a job whose plugin fetched `jobUrl` during this
   * request (`jobUrlFetchedAt` ≥ the request start) is marked live without a second GET.
   *
   * Red control of the key test: set {@link TRUST_FRESH_FETCH_FOR_KEY_TEST} to `'false'`
   * → all 3 URLs are probed (test goes red).
   */
  describe(`liveness trusts a fresh plugin fetch (${LIVENESS_TRUST_FRESH_FETCH_ENV})`, () => {
    const TRUST_FRESH_FETCH_FOR_KEY_TEST: string | undefined = undefined;
    const saved = process.env[LIVENESS_TRUST_FRESH_FETCH_ENV];
    const setTrust = (value: string | undefined) => {
      if (value === undefined) delete process.env[LIVENESS_TRUST_FRESH_FETCH_ENV];
      else process.env[LIVENESS_TRUST_FRESH_FETCH_ENV] = value;
    };
    afterEach(() => setTrust(saved));

    const STALE = new Date(Date.now() - 3_600_000).toISOString();

    /** fresh (fetched by the "plugin" during the search), stale, none — in that order. */
    function threeJobs(fetchedAt = new Date().toISOString()): JobPostDto[] {
      return [
        new JobPostDto({ ...makeJob('fresh'), jobUrlFetchedAt: fetchedAt }),
        new JobPostDto({ ...makeJob('stale'), jobUrlFetchedAt: STALE }),
        makeJob('none'),
      ];
    }

    function controllerReturning(produce: () => JobPostDto[], cached?: JobPostDto[]) {
      const made = createController();
      // Built when the fan-out runs, i.e. after the controller took its request start.
      made.jobsService.searchJobsWithDiagnostics.mockImplementation(async () => ({ jobs: produce(), perSource: [] }));
      if (cached) made.cache.get.mockResolvedValue(cached);
      return made;
    }

    it('skips the freshly fetched job and probes the others in order (key test)', async () => {
      setTrust(TRUST_FRESH_FETCH_FOR_KEY_TEST);
      let fetchedAt = '';
      const { controller, liveness } = controllerReturning(() => {
        fetchedAt = new Date().toISOString();
        return threeJobs(fetchedAt);
      });

      const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as { jobs: JobPostDto[] };

      expect(liveness.checkBatch).toHaveBeenCalledTimes(1);
      expect(liveness.checkBatch).toHaveBeenCalledWith(['https://jobs.example/stale', 'https://jobs.example/none']);
      const byId = Object.fromEntries(result.jobs.map((j) => [j.id, j.liveness]));
      expect(byId.fresh).toEqual({ state: 'active', checkedAt: fetchedAt, reason: JOB_LIVENESS_REASON_FRESH_FETCH });
      expect(JOB_LIVENESS_REASON_FRESH_FETCH).toBe('fresh-fetch');
      // Probe verdicts keep their pre-1714 shape (no reason).
      expect(byId.stale).toEqual({ state: 'active', checkedAt: 'now' });
      expect(byId.none).toEqual({ state: 'active', checkedAt: 'now' });
    });

    it('a search-cache hit never counts as fresh: every URL is probed', async () => {
      const cachedJobs = threeJobs(new Date(Date.now() + 60_000).toISOString());
      const { controller, liveness } = controllerReturning(() => [], cachedJobs);

      const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as {
        jobs: JobPostDto[];
        cached: boolean;
      };

      expect(result.cached).toBe(true);
      expect(liveness.checkBatch).toHaveBeenCalledWith([
        'https://jobs.example/fresh',
        'https://jobs.example/stale',
        'https://jobs.example/none',
      ]);
      expect(result.jobs.every((j) => j.liveness?.reason === undefined)).toBe(true);
    });

    it('when every job is fresh no probe batch runs at all', async () => {
      const { controller, liveness } = controllerReturning(() => [
        new JobPostDto({ ...makeJob('a'), jobUrlFetchedAt: new Date().toISOString() }),
        new JobPostDto({ ...makeJob('b'), jobUrlFetchedAt: new Date().toISOString() }),
      ]);

      const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as { jobs: JobPostDto[] };

      expect(liveness.checkBatch).not.toHaveBeenCalled();
      expect(result.jobs.every((j) => j.liveness?.reason === 'fresh-fetch')).toBe(true);
    });

    it('an unparseable jobUrlFetchedAt is probed', async () => {
      const { controller, liveness } = controllerReturning(() => [
        new JobPostDto({ ...makeJob('bad'), jobUrlFetchedAt: 'yesterday-ish' }),
      ]);
      await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }));
      expect(liveness.checkBatch).toHaveBeenCalledWith(['https://jobs.example/bad']);
    });

    it('a failing probe batch degrades only the probed jobs; the fresh one stays active', async () => {
      const { controller, liveness } = controllerReturning(() => threeJobs());
      liveness.checkBatch.mockRejectedValue(new Error('pool exploded'));

      const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as { jobs: JobPostDto[] };

      expect(result.jobs.map((j) => [j.id, j.liveness?.state])).toEqual([
        ['fresh', 'active'],
        ['stale', 'uncertain'],
        ['none', 'uncertain'],
      ]);
    });

    it(`${LIVENESS_TRUST_FRESH_FETCH_ENV}=false restores the pre-1714 behaviour: every URL is probed`, async () => {
      setTrust('false');
      const { controller, liveness } = controllerReturning(() => threeJobs());

      const result = (await withLiveness(controller, new ScraperInputDto({ searchTerm: 'x' }))) as { jobs: JobPostDto[] };

      expect(liveness.checkBatch).toHaveBeenCalledWith([
        'https://jobs.example/fresh',
        'https://jobs.example/stale',
        'https://jobs.example/none',
      ]);
      expect(result.jobs.every((j) => j.liveness?.reason === undefined)).toBe(true);
    });

    it('livenessTrustFreshFetch: default true, false/0/no/off turn it off, invalid keeps the default', () => {
      expect(livenessTrustFreshFetch({})).toBe(true);
      expect(livenessTrustFreshFetch({ [LIVENESS_TRUST_FRESH_FETCH_ENV]: 'false' })).toBe(false);
      expect(livenessTrustFreshFetch({ [LIVENESS_TRUST_FRESH_FETCH_ENV]: 'OFF' })).toBe(false);
      expect(livenessTrustFreshFetch({ [LIVENESS_TRUST_FRESH_FETCH_ENV]: '1' })).toBe(true);
      expect(livenessTrustFreshFetch({ [LIVENESS_TRUST_FRESH_FETCH_ENV]: 'perhaps' })).toBe(true);
    });
  });

  it('includes crawl in the search cache key', async () => {
    const { controller, cache } = createController();
    const crawl = Object.assign(new CrawlPolicyDto(), { discovery: 'sitemap' as const });

    await controller.searchJobs(new ScraperInputDto({ searchTerm: 'x', crawl }));

    expect(cache.get.mock.calls[0][0]).toMatchObject({ endpoint: 'search', crawl: { discovery: 'sitemap' } });
  });
});
