/**
 * E2E test for the Glassdoor scraper.
 *
 * Live network. Spec 1703: the scrape must never come back as a silent zero.
 * Either it returns well-formed rows, or it returns no rows AND says why. From
 * an egress the site challenges, the expected outcome is `blocked` after the
 * single homepage request.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { GlassdoorModule, GlassdoorService } from '@ever-jobs/source-glassdoor';
import { ScraperInputDto, Site, Country, DescriptionFormat } from '@ever-jobs/models';
import { HttpClient } from '@ever-jobs/common';

describe('GlassdoorService (E2E)', () => {
  let service: GlassdoorService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [GlassdoorModule],
    }).compile();

    service = module.get<GlassdoorService>(GlassdoorService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns rows or a reason, never a silent zero, in at most 2 requests', async () => {
    const requests = jest.spyOn(HttpClient.prototype, 'request');
    const input = new ScraperInputDto({
      siteType: [Site.GLASSDOOR],
      searchTerm: 'software engineer',
      resultsWanted: 3,
      country: Country.USA,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(requests.mock.calls.length).toBeLessThanOrEqual(2);

    if (response.jobs.length > 0) {
      for (const job of response.jobs) {
        expect(job.id).toMatch(/^gd-\d+$/);
        expect(job.jobUrl).toContain('/job-listing/j?jl=');
        expect(typeof job.title).toBe('string');
        expect(job.title?.length).toBeGreaterThan(0);
        if (job.datePosted) expect(job.datePostedPrecision).toBe('day');
      }
    } else {
      expect(['blocked', 'fetch_error', 'timeout']).toContain(response.diagnostics?.reason);
    }
  }, 120_000);
});
