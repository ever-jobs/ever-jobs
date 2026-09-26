/**
 * E2E test for the BDJobs scraper.
 *
 * Live: one search request plus at most two details requests. Since Spec 1711
 * the assertions are unconditional: the previous `if (jobs.length > 0)` guard
 * let this pass on zero results, which is how a dead endpoint went unnoticed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BDJobsModule, BDJobsService } from '@ever-jobs/source-bdjobs';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

describe('BDJobsService (E2E)', () => {
  let service: BDJobsService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [BDJobsModule],
    }).compile();

    service = module.get<BDJobsService>(BDJobsService);
  });

  it('should return job results for a basic search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.BDJOBS],
      searchTerm: 'developer',
      resultsWanted: 2,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.diagnostics?.reason ?? 'ok').not.toMatch(/blocked|fetch_error|unknown/);
    expect(response.jobs.length).toBeGreaterThan(0);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    for (const job of response.jobs) {
      expect(typeof job.title).toBe('string');
      expect(job.id).toMatch(/^\d+$/);
      expect(job.jobUrl.startsWith('https://bdjobs.com/h/details/')).toBe(true);
      expect(String(job.datePosted)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(job.datePosted) <= tomorrow).toBe(true);
      expect(job.location?.country).toBe('Bangladesh');
      expect(job.site).toBe('bdjobs');
    }
    expect(response.jobs.some((job) => (job.description ?? '').trim().length > 0)).toBe(true);
  }, 60_000);
});
