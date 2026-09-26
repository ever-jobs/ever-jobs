/**
 * Live E2E for the Simplify lists (Spec 1694).
 *
 * Reads the real published feeds, so it runs only when `RUN_NETWORK_E2E=1`,
 * keeping CI and local runs deterministic and offline. The service caches the
 * compacted rows and shares in-flight downloads, so the whole suite costs at
 * most one robots.txt read and two feed downloads (~2 MB each, compressed).
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { SimplifyJobsModule, SimplifyJobsService } from '@ever-jobs/source-simplifyjobs';

const SITE: Site = Site.SIMPLIFYJOBS;

const describeNetwork = process.env.RUN_NETWORK_E2E ? describe : describe.skip;

describeNetwork('SimplifyJobsService (E2E, live)', () => {
  let service: SimplifyJobsService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [SimplifyJobsModule],
    }).compile();
    service = moduleRef.get(SimplifyJobsService);
  });

  it('returns well-formed jobs from both lists', async () => {
    const response = await service.scrape(new ScraperInputDto({ siteType: [SITE], resultsWanted: 3 }));

    // Both lists always hold thousands of live rows: an empty or failed
    // result is a real failure here, not a quiet pass.
    expect(response.diagnostics).toBeUndefined();
    expect(response.jobs).toHaveLength(3);
    for (const job of response.jobs) {
      expect(job.id).toMatch(/^simplifyjobs-[0-9a-f-]{36}$/);
      expect(job.jobUrl).toMatch(/^https?:\/\//);
      expect(job.site).toBe(SITE);
      expect(job.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(job.description).toBeNull();
    }
  }, 120_000);

  it('returns only internships for jobType INTERNSHIP', async () => {
    const response = await service.scrape(
      new ScraperInputDto({ siteType: [SITE], jobType: JobType.INTERNSHIP, resultsWanted: 3 }),
    );

    expect(response.diagnostics).toBeUndefined();
    expect(response.jobs).toHaveLength(3);
    for (const job of response.jobs) {
      expect(job.jobType).toContain(JobType.INTERNSHIP);
    }
  }, 120_000);
});
