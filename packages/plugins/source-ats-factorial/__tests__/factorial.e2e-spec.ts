/**
 * E2E test for the Factorial ATS scraper.
 *
 * No authentication required — Factorial tenant career pages are publicly
 * accessible at `https://{slug}.factorial.com` (legacy `factorialhr.com`
 * sub-domains 301 to the canonical apex). Tests run against the known
 * tenant `jobs-tendencys` but tolerate upstream changes / WAF gating by
 * treating zero results as acceptable; shape assertions only run when jobs are
 * actually returned.
 *
 * Verified tenant (2026-10-10):
 *   https://jobs-tendencys.factorial.com  — open positions listed
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FactorialModule, FactorialService } from '@ever-jobs/source-ats-factorial';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

describe('FactorialService (E2E)', () => {
  let service: FactorialService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [FactorialModule],
    }).compile();

    service = module.get<FactorialService>(FactorialService);
  });

  it('should return job results for a known Factorial tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FACTORIAL],
      companySlug: 'jobs-tendencys',
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.FACTORIAL);
      expect(job.atsType).toBe('factorial');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toBeDefined();
      // Board domains rebrand (factorialhr.com → factorial.com) and tenants
      // may use custom domains — assert the path shape, not the host.
      expect(new URL(job.jobUrl as string).pathname.startsWith('/job_posting/')).toBe(true);
    }
  }, 60000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FACTORIAL],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should handle an unknown tenant gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FACTORIAL],
      companySlug: 'this-tenant-definitely-does-not-exist-xyz-99999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FACTORIAL],
      companySlug: 'jobs-tendencys',
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 60000);
});
