/**
 * E2E test for the Level (jobsbylevel.com) scraper — Spec 1693.
 *
 * Level rates every listing with an "AI Level" from 1 to 4 (how central AI is
 * to the work). The plugin reads the operator's key-less MCP server; neither
 * test reads a detail, so the whole suite costs two requests to the host.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';
import { JobsByLevelModule, JobsByLevelService } from '@ever-jobs/source-jobsbylevel';
import { JobsByLevelJobPost } from '../src/jobsbylevel.types';

describe('JobsByLevelService (E2E)', () => {
  let service: JobsByLevelService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JobsByLevelModule],
    }).compile();

    service = module.get<JobsByLevelService>(JobsByLevelService);
  });

  it('returns rated listings with canonical Level links', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.JOBSBYLEVEL],
        resultsWanted: 3,
        descriptionFormat: DescriptionFormat.PLAIN,
        descriptionDepth: 'board',
      }),
    );

    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    // A clean run on a board of ~70k listings must return something; an empty
    // result has to come with a diagnostic saying why.
    if (!response.diagnostics) expect(response.jobs.length).toBeGreaterThan(0);
    for (const job of response.jobs as JobsByLevelJobPost[]) {
      expect(job.id).toMatch(/^jobsbylevel-/);
      expect(job.jobUrl).toContain('jobsbylevel.com/jobs/');
      expect(job.site).toBe(Site.JOBSBYLEVEL);
      expect(typeof job.title).toBe('string');
      if (job.aiLevel !== undefined && job.aiLevel !== null) {
        expect([1, 2, 3, 4]).toContain(job.aiLevel);
      }
    }
  }, 60000);

  it('searches remote roles', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.JOBSBYLEVEL],
        searchTerm: 'engineer',
        isRemote: true,
        resultsWanted: 3,
        descriptionDepth: 'board',
      }),
    );

    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    if (!response.diagnostics) expect(response.jobs.length).toBeGreaterThan(0);
    for (const job of response.jobs) {
      expect(job.isRemote).toBe(true);
    }
  }, 60000);
});
