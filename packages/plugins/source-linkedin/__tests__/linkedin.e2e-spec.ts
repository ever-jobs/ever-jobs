/**
 * E2E test for the LinkedIn scraper.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { LinkedInModule, LinkedInService } from '@ever-jobs/source-linkedin';
import { ScraperInputDto, Site, Country, DescriptionFormat } from '@ever-jobs/models';

describe('LinkedInService (E2E)', () => {
  let service: LinkedInService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [LinkedInModule],
    }).compile();

    service = module.get<LinkedInService>(LinkedInService);
  });

  it('should return job results for a basic search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.LINKEDIN],
      searchTerm: 'data scientist',
      location: 'Remote',
      resultsWanted: 5,
      country: Country.USA,
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
    }
  });
});

/**
 * Live checks for Spec 1701 (and the Spec 1696 posted-time marker). Opt-in:
 * they only run when `RUN_NETWORK_E2E=1`. Each case makes a handful of paced,
 * sequential requests; a throttled run (no jobs) passes without asserting.
 */
const describeNetwork = process.env.RUN_NETWORK_E2E ? describe : describe.skip;

describeNetwork('LinkedInService (network E2E, Spec 1701)', () => {
  let service: LinkedInService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [LinkedInModule],
    }).compile();

    service = module.get<LinkedInService>(LinkedInService);
  });

  it('returns stable numeric ids, canonical URLs and clean descriptions', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.LINKEDIN],
        searchTerm: 'software engineer',
        location: 'United States',
        resultsWanted: 3,
        linkedinFetchDescription: true,
        descriptionFormat: DescriptionFormat.MARKDOWN,
      }),
    );
    if (response.jobs.length === 0) return;

    for (const job of response.jobs) {
      expect(job.id).toMatch(/^li-\d+$/);
      expect(job.jobUrl).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/);
      if (job.companyUrl) expect(job.companyUrl).not.toContain('?');
      if (job.description) expect(job.description).not.toMatch(/Show more/);
      if (job.jobType) expect(job.jobType).toHaveLength(1);
    }
  }, 120_000);

  it('reaches the second page (more than 10 unique ids)', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.LINKEDIN],
        searchTerm: 'software engineer',
        location: 'United States',
        resultsWanted: 12,
      }),
    );
    if (response.jobs.length === 0) return;

    expect(new Set(response.jobs.map((job) => job.id)).size).toBeGreaterThan(10);
  }, 120_000);

  it('carries a sub-day posting instant for jobs under a day old', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.LINKEDIN],
        searchTerm: 'software engineer',
        location: 'United States',
        hoursOld: 24,
        resultsWanted: 3,
      }),
    );
    if (response.jobs.length === 0) return;

    for (const job of response.jobs) {
      expect(String(job.datePosted)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const timed = response.jobs.filter((job) => job.datePostedAt);
    expect(timed.length).toBeGreaterThan(0);
    const now = Date.now();
    for (const job of timed) {
      const at = Date.parse(job.datePostedAt!);
      expect(at).toBeLessThanOrEqual(now + 60_000);
      expect(at).toBeGreaterThanOrEqual(now - 26 * 3_600_000);
      expect(['minute', 'hour']).toContain(job.datePostedPrecision);
      expect(job.datePostedBasis).toBe('relative');
    }
  }, 120_000);
});
