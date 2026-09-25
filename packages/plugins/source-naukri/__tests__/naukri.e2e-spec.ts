/**
 * E2E test for the Naukri scraper.
 *
 * Spec 1712: the board gates automated clients (406 "recaptcha required", or
 * an edge that never answers), so a live run passes only when it either
 * returns well-formed jobs or says why it returned none (`blocked` /
 * `timeout`). Zero jobs with no diagnostic fails: that is the silent outcome
 * this test used to accept.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NaukriModule, NaukriService } from '@ever-jobs/source-naukri';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

describe('NaukriService (E2E)', () => {
  let service: NaukriService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [NaukriModule],
    }).compile();

    service = module.get<NaukriService>(NaukriService);
  });

  it('should return job results for a basic search, or report why it cannot', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.NAUKRI],
      searchTerm: 'developer',
      resultsWanted: 3,
      requestTimeout: 20,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      for (const job of response.jobs) {
        expect(typeof job.title).toBe('string');
        expect(job.title.length).toBeGreaterThan(0);
        expect(job.jobUrl.startsWith('https://www.naukri.com/')).toBe(true);
        expect(job.site).toBe(Site.NAUKRI);
        expect(Array.isArray(job.locations)).toBe(true);
      }
    } else {
      expect(['blocked', 'timeout']).toContain(response.diagnostics?.reason);
    }
  }, 90_000);
});
