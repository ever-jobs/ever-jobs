/**
 * E2E test for the Indeed scraper.
 *
 * NOTE: This test hits the live Indeed website and may be rate-limited
 * or blocked depending on your network/IP. Run sparingly.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { IndeedModule, IndeedService } from '@ever-jobs/source-indeed';
import {
  ScraperInputDto,
  Site,
  Country,
  DescriptionFormat,
  DatePostedPrecision,
  JobResponseDto,
} from '@ever-jobs/models';

const logger = new Logger('IndeedE2E');

/** The endpoint's edge blocks some egress outright; that must not fail CI. */
function blocked(response: JobResponseDto): boolean {
  if (response.jobs.length === 0 && response.diagnostics?.reason === 'blocked') {
    logger.warn(`Indeed blocked this egress: ${response.diagnostics.detail ?? '(no detail)'}`);
    return true;
  }
  return false;
}

describe('IndeedService (E2E)', () => {
  let service: IndeedService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [IndeedModule],
    }).compile();

    service = module.get<IndeedService>(IndeedService);
  });

  it('should return job results for a basic search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.INDEED],
      searchTerm: 'software engineer',
      location: 'New York',
      resultsWanted: 3,
      country: Country.USA,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    // We may get 0 results if blocked, but should not throw
    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(job.title).toBeDefined();
      expect(typeof job.title).toBe('string');
    }
  });

  // Spec 1702: a zero-job answer always says why, and the mapped fields keep their contract.
  it('never returns a silent empty result, and maps workplace and posted time', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.INDEED],
      searchTerm: 'software engineer',
      isRemote: true,
      resultsWanted: 3,
      country: Country.USA,
    });

    const response = await service.scrape(input);
    if (blocked(response)) return;

    if (response.jobs.length === 0) {
      logger.warn(`Indeed returned no jobs: ${JSON.stringify(response.diagnostics)}`);
      expect(response.diagnostics?.reason).toBeDefined();
      return;
    }

    for (const job of response.jobs) {
      expect(typeof job.isRemote).toBe('boolean');
      if (job.workFromHomeType !== undefined) {
        expect(['Remote', 'Hybrid']).toContain(job.workFromHomeType);
        expect(job.isRemote).toBe(job.workFromHomeType === 'Remote');
      }
      if (job.datePosted !== null && job.datePosted !== undefined) {
        expect(String(job.datePosted)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      if (job.datePostedAt) {
        expect(job.datePostedPrecision).toBe(DatePostedPrecision.EXACT);
        expect(Number.isFinite(Date.parse(job.datePostedAt))).toBe(true);
      }
    }
  });
});
