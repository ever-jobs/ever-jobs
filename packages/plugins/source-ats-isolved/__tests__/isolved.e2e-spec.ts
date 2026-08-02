/**
 * E2E test for the isolved Hire ATS scraper.
 *
 * No authentication required — isolved Hire tenants publish a public candidate-facing
 * career board at `https://{tenant}.isolvedhire.com/`. The adapter reads the board HTML
 * shell for the `domainId`, calls the board's own JSON API
 * (`/core/jobs/{domainId}`) for all open roles with structured fields, then fans out to
 * each `/jobs/{jobId}.html` detail page for the JSON-LD description body. The adapter
 * resolves the tenant from a `companySlug` (the sub-domain label, e.g. `americavotes`)
 * or a full `companyUrl`. Tests run against a known isolved-Hire-powered tenant but
 * tolerate upstream changes / empty boards by treating zero results as acceptable; the
 * shape assertions only run when jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { IsolvedModule, IsolvedService } from '@ever-jobs/source-ats-isolved';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public isolved-Hire-powered career board (America Votes — confirmed live 2026-06-03).
const KNOWN_TENANT = 'americavotes';

describe('IsolvedService (E2E)', () => {
  let service: IsolvedService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [IsolvedModule],
    }).compile();

    service = module.get<IsolvedService>(IsolvedService);
  });

  it('should return job results for a known isolved Hire tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companySlug: KNOWN_TENANT,
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.ISOLVED);
      expect(job.atsType).toBe('isolved');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toBeDefined();
    }
  }, 30000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should resolve a tenant from a full companyUrl', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companyUrl: `https://${KNOWN_TENANT}.isolvedhire.com/jobs/`,
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should handle an unknown tenant gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companySlug: 'this-tenant-definitely-does-not-exist-xyz-99999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBe(0);
  }, 30000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companySlug: KNOWN_TENANT,
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 30000);
});
