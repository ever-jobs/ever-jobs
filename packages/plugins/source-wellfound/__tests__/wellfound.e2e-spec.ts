/**
 * Network smoke test for the Wellfound aggregator search (Spec 1708).
 *
 * Hits the live, robots-allowed role landing pages over plain HTTP, so it is
 * **opt-in**: it only runs when `RUN_NETWORK_E2E=1`. The deterministic,
 * fixture-driven coverage lives in `wellfound.parser.spec.ts` and
 * `wellfound.service.spec.ts`.
 *
 * Blocking depends on the egress IP's reputation, so a `blocked` diagnostic is
 * an accepted outcome. A silent empty result is not: it fails the test rather
 * than passing by absence.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { WellfoundModule, WellfoundService } from '@ever-jobs/source-wellfound';
import { DescriptionFormat, JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

const describeNetwork = process.env.RUN_NETWORK_E2E ? describe : describe.skip;

function expectJobsOrBlocked(response: JobResponseDto): boolean {
  if (response.jobs.length === 0) {
    expect(response.diagnostics?.reason).toBe('blocked');
    return false;
  }
  return true;
}

describeNetwork('WellfoundService (network E2E)', () => {
  let service: WellfoundService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [WellfoundModule],
    }).compile();
    service = module.get<WellfoundService>(WellfoundService);
  });

  it('returns software engineering jobs from the role landing page', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.WELLFOUND],
        searchTerm: 'software engineer',
        resultsWanted: 3,
        descriptionFormat: DescriptionFormat.MARKDOWN,
      }),
    );

    if (!expectJobsOrBlocked(response)) return;
    expect(response.jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of response.jobs) {
      expect(job.id).toMatch(/^wellfound-\d+$/);
      expect(job.jobUrl).toMatch(/^https:\/\/wellfound\.com\/jobs\/\d+-[a-z0-9-]+$/);
      expect(job.companyName).toBeTruthy();
      expect(job.site).toBe(Site.WELLFOUND);
      expect(String(job.datePosted)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(job.datePosted) > '2015-01-01').toBe(true);
    }
  }, 60000);

  it('returns only remote-eligible jobs for isRemote', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.WELLFOUND],
        searchTerm: 'software engineer',
        isRemote: true,
        resultsWanted: 2,
      }),
    );

    if (!expectJobsOrBlocked(response)) return;
    expect(response.jobs.every((job) => job.isRemote === true)).toBe(true);
  }, 60000);
});
