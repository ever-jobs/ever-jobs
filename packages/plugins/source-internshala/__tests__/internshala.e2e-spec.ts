/**
 * E2E test for the Internshala scraper (live; Spec 1706).
 *
 * Kept small on purpose: `descriptionDepth: 'board'` and at most 3 results, so
 * each test makes at most two listing requests and no detail request. When the
 * board is unreachable the scraper must say why (diagnostics), never return a
 * silent empty list.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InternshalaModule, InternshalaService } from '@ever-jobs/source-internshala';
import { ScraperInputDto, Site, DescriptionFormat, JobType, JobPostDto } from '@ever-jobs/models';

const mentions = (job: JobPostDto, needle: string, withDescription = false): boolean =>
  [job.title, ...(job.skills ?? []), withDescription ? job.description : null].some((text) =>
    (text ?? '').toLowerCase().includes(needle),
  );

describe('InternshalaService (E2E)', () => {
  let service: InternshalaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [InternshalaModule],
    }).compile();

    service = module.get<InternshalaService>(InternshalaService);
  });

  it('should return filtered job and internship results for a keyword search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.INTERNSHALA],
      searchTerm: 'python',
      resultsWanted: 3,
      descriptionDepth: 'board',
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length > 0 || response.diagnostics !== undefined).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    if (response.jobs.length > 0) {
      const ids = response.jobs.map((j) => j.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const job of response.jobs) {
        expect(typeof job.title).toBe('string');
        expect(job.id).toMatch(/^is-\d+$/);
        expect(['job', 'internship']).toContain(job.listingType);
        if (job.compensation) expect(job.compensation.currency).toBe('INR');
      }
      // the search term is applied (the unfiltered feed would not match)
      expect(response.jobs.some((j) => mentions(j, 'python'))).toBe(true);
    }
  }, 90_000);

  it('should encode a multi-word keyword for an internship-only search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.INTERNSHALA],
      searchTerm: 'data science',
      jobType: JobType.INTERNSHIP,
      resultsWanted: 3,
      descriptionDepth: 'board',
    });

    const response = await service.scrape(input);

    expect(response.jobs.length > 0 || response.diagnostics !== undefined).toBe(true);
    if (response.jobs.length > 0) {
      for (const job of response.jobs) {
        expect(job.jobUrl).toContain('/internship/detail/');
      }
      // The listing is ordered by relevance over the whole posting, so the top
      // cards may name the keyword only in their responsibilities snippet.
      expect(response.jobs.some((j) => mentions(j, 'data', true))).toBe(true);
    }
  }, 90_000);
});
