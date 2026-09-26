import 'reflect-metadata';
import { CrawlPolicyDto, JobPostDto, ScraperInputDto } from '@ever-jobs/models';
import { ScrapeContext, getScrapeContext } from '@ever-jobs/common';
import { DEFAULT_LIVENESS_DEADLINE_MS, LIVENESS_DEADLINE_ENV, livenessDeadlineMs } from '../crawl-policy.mapping';
import { JobsController, LIVENESS_CRAWL_SITE } from '../jobs.controller';
import { SEARCH_CACHE_ENDPOINT } from '../search-cache';

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
  return { controller, liveness, cache, seen };
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

  it('includes crawl in the search cache key', async () => {
    const { controller, cache } = createController();
    const crawl = Object.assign(new CrawlPolicyDto(), { discovery: 'sitemap' as const });

    await controller.searchJobs(new ScraperInputDto({ searchTerm: 'x', crawl }));

    expect(cache.get.mock.calls[0][0]).toMatchObject({ endpoint: SEARCH_CACHE_ENDPOINT, crawl: { discovery: 'sitemap' } });
  });
});
