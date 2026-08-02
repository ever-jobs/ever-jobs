/**
 * E2E test for the Jobvite scraper.
 *
 * Exercises the live public board over the network (server-rendered
 * `/{slug}/jobs` list + per-role JSON-LD detail). Network-dependent, so it
 * asserts shape rather than exact counts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { JobviteModule, JobviteService } from '@ever-jobs/source-ats-jobvite';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

describe('JobviteService (E2E)', () => {
  let service: JobviteService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JobviteModule],
    }).compile();

    service = module.get<JobviteService>(JobviteService);
  });

  it('should return job results from a live public board', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.JOBVITE],
      companySlug: 'nuscale-power',
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(job.title).toBeDefined();
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.JOBVITE);
      expect(job.atsType).toBe('jobvite');
      expect(job.jobUrl).toContain('jobs.jobvite.com');
    }
  });

  it('should return empty results for a tenant that has moved off Jobvite', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.JOBVITE],
      companySlug: 'opentrons',
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBe(0);
  });

  it('should return empty results when no companySlug provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.JOBVITE],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });
});
