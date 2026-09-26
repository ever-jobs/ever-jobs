/**
 * Network smoke test for the Bayt scraper (Spec 1710).
 *
 * Hits the live bayt.com listing (robots.txt allows the listing URLs the
 * plugin builds), so it runs in the CI source-e2e shards, which tolerate
 * failures. The fixture-driven coverage lives in `bayt.parse.spec.ts` and
 * `bayt.service.spec.ts`.
 *
 * The site challenges many networks. A `blocked` diagnostic is an honest
 * outcome and passes; zero jobs with no diagnostic - the silent empty result
 * Spec 1710 removed - fails.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BaytModule, BaytService } from '@ever-jobs/source-bayt';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

describe('BaytService (network E2E)', () => {
  let service: BaytService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [BaytModule],
    }).compile();

    service = module.get<BaytService>(BaytService);
  });

  it('returns well-formed jobs, or says it was blocked', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.BAYT],
      searchTerm: 'engineer',
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(Array.isArray(response.jobs)).toBe(true);
    if (response.jobs.length > 0) {
      for (const job of response.jobs) {
        expect(job.id).toMatch(/^bayt-\d+$/);
        expect(job.jobUrl.startsWith('https://www.bayt.com/en/')).toBe(true);
        expect(job.jobUrl).not.toContain('?');
        expect(job.site).toBe(Site.BAYT);
        expect(typeof job.title).toBe('string');
        expect(job.title.length).toBeGreaterThan(0);
      }
    } else {
      expect(response.diagnostics?.reason).toBe('blocked');
    }
  }, 60000);
});
