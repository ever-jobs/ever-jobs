/**
 * E2E test for the Flatchr ATS scraper.
 *
 * No authentication is required — Flatchr career sites expose a public,
 * anonymous JSON vacancy listing at
 * `GET https://careers.flatchr.io/company/{slug}.json`. Tests run against a
 * known Flatchr-powered tenant but tolerate upstream changes or WAF gating by
 * treating zero results as acceptable; shape assertions only run when jobs are
 * actually returned.
 *
 * Known live tenants used for testing (verified 2026-06-03):
 *   - `companySlug: 'flatchr'`     — Flatchr itself (3 published vacancies)
 *   - `companySlug: 'groupeaudeo'` — Groupe Audeo (2 published vacancies)
 *
 * Timeouts: the HTTP client uses a 60s per-request timeout and does not retry
 * a timeout -- a timeout carries no `error.response.status`, so the retry loop
 * rethrows after a single attempt. The network tests below must therefore
 * outlast one full client timeout. At 30s jest killed them first, so upstream
 * slowness surfaced as a red shard instead of the service catching the error
 * and returning an empty result with a diagnostic.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FlatchrModule, FlatchrService } from '@ever-jobs/source-ats-flatchr';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

describe('FlatchrService (E2E)', () => {
  let service: FlatchrService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [FlatchrModule],
    }).compile();

    service = module.get<FlatchrService>(FlatchrService);
  });

  it('should return job results for a known Flatchr tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FLATCHR],
      companySlug: 'flatchr',
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect((job.title ?? '').length).toBeGreaterThan(0);
      expect(job.site).toBe(Site.FLATCHR);
      expect(job.atsType).toBe('flatchr');
      expect(job.atsId).toBeDefined();
      expect((job.atsId ?? '').length).toBeGreaterThan(0);
      expect(job.jobUrl).toBeDefined();
    }
  }, 120000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FLATCHR],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should handle an unknown tenant gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FLATCHR],
      companySlug: 'this-tenant-definitely-does-not-exist-xyz-99999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBe(0);
  }, 120000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.FLATCHR],
      companySlug: 'flatchr',
      resultsWanted: 2,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(2);
  }, 120000);
});
