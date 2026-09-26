/**
 * Live E2E for the RemoteOK source (Spec 1707).
 *
 * Uses the public JSON feed (no auth). At most four live requests in total,
 * with an honest User-Agent and at least the site's 1 s crawl delay between
 * scrapes. Assertions tolerate an empty board, as the sibling suites do.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RemoteOkModule, RemoteOkService } from '@ever-jobs/source-remoteok';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

const HONEST_UA = 'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';
const MOJIBAKE = /[\xC2-\xF4][\x80-\xBF]/;
const LIVE_TIMEOUT_MS = 120_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RemoteOkService (E2E)', () => {
  let service: RemoteOkService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [RemoteOkModule],
    }).compile();

    service = module.get<RemoteOkService>(RemoteOkService);
  });

  // Each scrape builds its own client, so space the scrapes here.
  afterEach(() => pause(1500));

  it(
    'returns repaired board jobs without a search term',
    async () => {
      const response = await service.scrape(
        new ScraperInputDto({
          siteType: [Site.REMOTEOK],
          resultsWanted: 3,
          userAgent: HONEST_UA,
          descriptionFormat: DescriptionFormat.PLAIN,
        }),
      );

      expect(response.diagnostics).toBeUndefined();
      expect(response.jobs.length).toBeLessThanOrEqual(3);
      for (const job of response.jobs) {
        expect(job.id).toMatch(/^remoteok-\d+$/);
        expect(job.site).toBe(Site.REMOTEOK);
        expect(job.jobUrl.startsWith('https://remoteok.com/remote-jobs/')).toBe(true);
        expect(job.isRemote).toBe(true);
        for (const text of [job.title, job.companyName, job.location?.city, job.location?.state]) {
          if (typeof text === 'string') expect(text).not.toMatch(MOJIBAKE);
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'finds python jobs through the tag feed',
    async () => {
      const response = await service.scrape(
        new ScraperInputDto({
          siteType: [Site.REMOTEOK],
          searchTerm: 'python',
          resultsWanted: 3,
          userAgent: HONEST_UA,
          descriptionFormat: DescriptionFormat.PLAIN,
        }),
      );

      expect(response.diagnostics?.reason).not.toBe('blocked');
      if (response.jobs.length > 0) {
        for (const job of response.jobs) {
          const text = [job.title, job.description ?? '', ...(job.skills ?? [])].join(' \n ').toLowerCase();
          expect(text).toMatch(/(?<![a-z0-9])python(?![a-z0-9])/);
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'honours hoursOld',
    async () => {
      const response = await service.scrape(
        new ScraperInputDto({
          siteType: [Site.REMOTEOK],
          hoursOld: 336,
          resultsWanted: 3,
          userAgent: HONEST_UA,
        }),
      );

      const earliest = Date.now() - 15 * 24 * 3600 * 1000;
      for (const job of response.jobs) {
        if (typeof job.datePosted === 'string') {
          expect(Date.parse(`${job.datePosted}T23:59:59Z`)).toBeGreaterThanOrEqual(earliest);
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
