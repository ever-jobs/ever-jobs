/**
 * E2E test for the Dover ATS scraper.
 *
 * No authentication required — Dover tenants publish a public, no-code candidate
 * board on `app.dover.com` (addressed by a short slug at `/jobs/{slug}` or by a
 * `/{company}/careers/{uuid}` URL). The boards are client-rendered SPAs backed by
 * a public careers-page JSON feed (`/api/v1/careers-page/{slug}`), with
 * pre-rendered schema.org `JobPosting` JSON-LD as a defensive fallback. The
 * adapter resolves the board slug from a `companySlug` (e.g. `dover`) or a full
 * `companyUrl`. Tests run against a known Dover-powered tenant but tolerate
 * upstream changes / empty feeds by treating zero results as acceptable; the shape
 * assertions only run when jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DoverModule, DoverService } from '@ever-jobs/source-ats-dover';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public Dover-powered candidate board (slug confirmed resolvable 2026-06-28).
const KNOWN_TENANT = 'gradientrobotics';

describe('DoverService (E2E)', () => {
  let service: DoverService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DoverModule],
    }).compile();

    service = module.get<DoverService>(DoverService);
  });

  it('should return job results for a known Dover tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.DOVER],
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
      expect(job.site).toBe(Site.DOVER);
      expect(job.atsType).toBe('dover');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toBeDefined();
    }
  }, 30000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.DOVER],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should resolve a tenant from a full companyUrl', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.DOVER],
      companyUrl: `https://app.dover.com/jobs/${KNOWN_TENANT}`,
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should handle an unknown tenant gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.DOVER],
      companySlug: 'this-tenant-definitely-does-not-exist-xyz-99999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.DOVER],
      companySlug: KNOWN_TENANT,
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 30000);
});
