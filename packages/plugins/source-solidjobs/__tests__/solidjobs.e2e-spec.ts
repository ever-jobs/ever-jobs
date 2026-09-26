/**
 * E2E test for the Solid.Jobs scraper.
 *
 * solid.jobs is a Polish job board with mandatory salary transparency.
 * Uses a free public JSON API -- no authentication required (the
 * `campaign` query parameter is mandatory and fixed to `api`).
 *
 * Spec 1709: kept small (at most 3 results, about 1-2 requests per test).
 * The server answers in roughly 9-10 s per request, hence the 60 s timeouts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Country, ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';
import { SolidJobsModule } from '../src/solidjobs.module';
import { SolidJobsService } from '../src/solidjobs.service';
import { foldText } from '../src/solidjobs.filters';

describe('SolidJobsService (E2E)', () => {
  let service: SolidJobsService;
  const savedDivisions = process.env.SOLIDJOBS_DIVISIONS;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [SolidJobsModule],
    }).compile();

    service = module.get<SolidJobsService>(SolidJobsService);
  });

  afterEach(() => {
    if (savedDivisions === undefined) delete process.env.SOLIDJOBS_DIVISIONS;
    else process.env.SOLIDJOBS_DIVISIONS = savedDivisions;
  });

  it('should return job results', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.SOLIDJOBS],
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);

    for (const job of response.jobs) {
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.SOLIDJOBS);
      expect(job.id).toMatch(/^solidjobs-/);
      expect(job.jobUrl).toContain('solid.jobs/o/');
      expect(String(job.datePosted)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(job.location?.country).toBe(Country.POLAND);
      expect(job.countryCode).toBe('PL');
      if (job.companyLogo !== null && job.companyLogo !== undefined) {
        expect(job.companyLogo.startsWith('https://')).toBe(true);
      }
    }
  }, 60000);

  it('should respect resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.SOLIDJOBS],
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 60000);

  it('should match every token of a multi-word search term', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.SOLIDJOBS],
      searchTerm: 'java developer',
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    for (const job of response.jobs) {
      // The DTO has no sub-category, so the description stands in for it.
      const haystack = foldText(
        [
          job.title,
          job.companyName,
          job.jobFunction,
          job.jobLevel,
          ...(job.skills ?? []),
          job.description,
        ].join(' '),
      ).replace(/\s+/g, '');
      expect(haystack).toContain('java');
      expect(haystack).toContain('developer');
    }
  }, 60000);

  it('should scan a non-IT division when configured', async () => {
    process.env.SOLIDJOBS_DIVISIONS = 'sales';
    const input = new ScraperInputDto({
      siteType: [Site.SOLIDJOBS],
      resultsWanted: 2,
    });

    const response = await service.scrape(input);

    expect(response.jobs.length).toBeLessThanOrEqual(2);
    for (const job of response.jobs) {
      expect(job.jobFunction).toBeTruthy();
      expect(job.jobUrl).toContain('solid.jobs/o/');
    }
  }, 60000);
});
