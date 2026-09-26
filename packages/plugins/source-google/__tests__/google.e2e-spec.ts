/**
 * E2E test for the Google scraper.
 *
 * Hits live Google, so it is **opt-in**: it only runs when `RUN_NETWORK_E2E=1`,
 * keeping CI and local runs deterministic and offline (Spec 1704). It stays
 * opt-in for a second reason: Google's robots.txt disallows `/search`, the
 * path this plugin reads, so CI never requests it on its own (see
 * docs/questions.md Q-099). The
 * deterministic, fixture-driven coverage lives in `google.service.spec.ts` and
 * `google.parser.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { GoogleModule, GoogleService } from '@ever-jobs/source-google';
import { ScraperInputDto, Site, Country, DescriptionFormat } from '@ever-jobs/models';

const describeNetwork = process.env.RUN_NETWORK_E2E ? describe : describe.skip;

describeNetwork('GoogleService (E2E)', () => {
  let service: GoogleService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [GoogleModule],
    }).compile();

    service = module.get<GoogleService>(GoogleService);
  });

  it('should return job results for a basic search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.GOOGLE],
      searchTerm: 'devops engineer',
      location: 'Chicago',
      resultsWanted: 3,
      country: Country.USA,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    if (response.jobs.length === 0) {
      // A zero-row answer always says why (blocked, unknown, fetch_error, ...).
      expect(response.diagnostics?.reason).toBeDefined();
    }
    for (const job of response.jobs) {
      expect(typeof job.title).toBe('string');
      expect(job.id).toMatch(/^go-/);
      expect(job.jobUrl).toMatch(/^https?:\/\//);
      expect(job.jobUrl).not.toContain('google.com/search');
    }
  }, 120_000);
});
