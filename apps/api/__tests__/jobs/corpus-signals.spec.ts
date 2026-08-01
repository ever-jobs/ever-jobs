import { JobsController } from '../../src/jobs/jobs.controller';
import { LegitimacyDetectorService } from '@ever-jobs/legitimacy-detector';
import type { JobPostDto, ScraperInputDto } from '@ever-jobs/models';

/**
 * Spec 740 — controller enrichment: liveness + legitimacy are opt-in (query flags) and absent on
 * the default path. Uses the real (pure) legitimacy detector and a stub liveness checker.
 */

function makeRawJobs(): JobPostDto[] {
  return [
    {
      title: 'Senior Backend Engineer',
      jobUrl: 'https://example.com/jobs/1',
      compensation: null,
      description: 'short',
      companyLogo: null,
      atsType: null,
    } as unknown as JobPostDto,
  ];
}

function makeController(): JobsController {
  const jobsService = { searchJobs: async () => makeRawJobs() } as never;
  const aggregator = {
    aggregateRaw: async (jobs: JobPostDto[]) => ({
      jobs,
      rawCount: jobs.length,
      deduped: 0,
      dedupMetrics: {},
    }),
  } as never;
  const analytics = {} as never;
  const cache = { get: async () => null, set: async () => undefined } as never;
  const liveness = {
    check: async () => ({ url: 'x', result: 'active', code: 'apply_control_visible', checkedAt: '2026-06-15T00:00:00Z' }),
    checkBatch: async (urls: string[]) =>
      urls.map((url) => ({ url, result: 'active' as const, code: 'apply_control_visible' as const, checkedAt: '2026-06-15T00:00:00Z' })),
  } as never;
  const legitimacy = new LegitimacyDetectorService();
  // Spec 5024 — ConfigService seam; returning the caller's default keeps the
  // historical `persist: true` behaviour these cases were written against.
  const config = { get: (_key: string, def?: unknown) => def } as never;
  return new JobsController(
    jobsService,
    aggregator,
    analytics,
    cache,
    config,
    liveness,
    legitimacy,
  );
}

const INPUT = { searchTerm: 'engineer' } as ScraperInputDto;

describe('JobsController — corpus signals (Spec 740)', () => {
  it('does NOT attach liveness/legitimacy on the default path', async () => {
    const result = (await makeController().searchJobs(INPUT)) as { jobs: JobPostDto[] };
    expect(result.jobs[0]!.liveness == null).toBe(true);
    expect(result.jobs[0]!.legitimacy == null).toBe(true);
  });

  it('attaches legitimacy when ?legitimacy=true', async () => {
    // positional: input, format, paginate, page, pageSize, dedup, liveness, legitimacy
    const result = (await makeController().searchJobs(
      INPUT,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    )) as { jobs: JobPostDto[] };
    expect(result.jobs[0]!.legitimacy).toBeDefined();
    expect(['verified', 'likely', 'uncertain']).toContain(result.jobs[0]!.legitimacy!.state);
    expect(result.jobs[0]!.liveness == null).toBe(true);
  });

  it('attaches liveness when ?liveness=true', async () => {
    const result = (await makeController().searchJobs(
      INPUT,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    )) as { jobs: JobPostDto[] };
    expect(result.jobs[0]!.liveness).toBeDefined();
    expect(result.jobs[0]!.liveness!.state).toBe('active');
  });

  // --------------------------------------------------------------------------
  // Spec 5025 — enrichment is scoped to the RETURNED window, not the corpus.
  // --------------------------------------------------------------------------

  describe('enrichment scope (Spec 5025)', () => {
    /**
     * Controller over a `size`-job corpus whose liveness checker records every
     * URL it was asked about, so a test can assert how many probes were issued.
     */
    function makeCountingController(size: number) {
      const corpus = Array.from(
        { length: size },
        (_, i) =>
          ({
            title: `Job ${i}`,
            jobUrl: `https://example.com/jobs/${i}`,
            compensation: null,
            description: 'short',
            companyLogo: null,
            atsType: null,
          }) as unknown as JobPostDto,
      );
      const probed: string[] = [];
      const jobsService = { searchJobs: async () => corpus } as never;
      const aggregator = {
        aggregateRaw: async (jobs: JobPostDto[]) => ({
          jobs,
          rawCount: jobs.length,
          deduped: 0,
          dedupMetrics: {},
        }),
      } as never;
      const analytics = {} as never;
      const cache = { get: async () => null, set: async () => undefined } as never;
      const liveness = {
        check: async () => ({
          url: 'x',
          result: 'active',
          code: 'apply_control_visible',
          checkedAt: '2026-06-15T00:00:00Z',
        }),
        checkBatch: async (urls: string[]) => {
          probed.push(...urls);
          return urls.map((url) => ({
            url,
            result: 'active' as const,
            code: 'apply_control_visible' as const,
            checkedAt: '2026-06-15T00:00:00Z',
          }));
        },
      } as never;
      const legitimacy = new LegitimacyDetectorService();
      // Spec 5024 ConfigService seam — returning the caller's default keeps
      // `store.persistSearch` at `true`, which is what these cases assume.
      const config = { get: (_key: string, def?: unknown) => def } as never;
      const controller = new JobsController(
        jobsService,
        aggregator,
        analytics,
        cache,
        config,
        liveness,
        legitimacy,
      );
      return { controller, probed, corpus };
    }

    it('probes only the requested page, not the whole corpus', async () => {
      const { controller, probed } = makeCountingController(500);

      const result = (await controller.searchJobs(
        INPUT,
        undefined,
        'true', // paginate
        '2', // page
        '25', // page_size
        undefined, // dedup
        'true', // liveness
      )) as { jobs: JobPostDto[]; count: number };

      // The regression this spec exists for: pre-5025 this was 500.
      expect(probed).toHaveLength(25);
      expect(result.jobs).toHaveLength(25);
      // `count` still reports the full corpus size — pagination metadata is
      // unchanged, only the enrichment scope moved.
      expect(result.count).toBe(500);
    });

    it('enriches exactly the page that is returned (page 2, not page 1)', async () => {
      const { controller, probed } = makeCountingController(100);

      const result = (await controller.searchJobs(
        INPUT,
        undefined,
        'true',
        '2',
        '10',
        undefined,
        'true',
        'true', // legitimacy too
      )) as { jobs: JobPostDto[] };

      expect(probed).toEqual(
        Array.from({ length: 10 }, (_, i) => `https://example.com/jobs/${10 + i}`),
      );
      for (const job of result.jobs) {
        expect(job.liveness!.state).toBe('active');
        expect(job.legitimacy).toBeDefined();
      }
    });

    it('still enriches the full set when pagination is not requested', async () => {
      const { controller, probed } = makeCountingController(30);

      const result = (await controller.searchJobs(
        INPUT,
        undefined,
        undefined, // no pagination
        undefined,
        undefined,
        undefined,
        'true',
      )) as { jobs: JobPostDto[] };

      expect(probed).toHaveLength(30);
      expect(result.jobs).toHaveLength(30);
    });

    it('CSV export keeps the full-corpus window (the whole set is returned)', async () => {
      const { controller, probed } = makeCountingController(40);
      const res = { setHeader: () => undefined };

      await controller.searchJobs(
        INPUT,
        'csv',
        'true', // paginate is ignored for CSV — the full set is exported
        '2',
        '10',
        undefined,
        'true',
        undefined,
        res as never,
      );

      expect(probed).toHaveLength(40);
    });
  });
});
