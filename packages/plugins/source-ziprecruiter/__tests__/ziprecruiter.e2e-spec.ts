/**
 * E2E test for the ZipRecruiter scraper.
 *
 * The live case hits the real endpoint, so it is opt-in: it only runs when
 * `RUN_NETWORK_E2E=1`. From an egress outside North America the endpoint
 * answers HTTP 403 `forbidden cf-waf`, which must surface as a `blocked`
 * diagnostic rather than a bare zero (Spec 1713). It stays opt-in for a
 * second reason: robots.txt on `api.ziprecruiter.com` disallows every path,
 * so CI never requests it on its own (see docs/questions.md Q-099). The
 * deterministic, fixture-driven coverage lives in `ziprecruiter.service.spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ZipRecruiterModule, ZipRecruiterService } from '@ever-jobs/source-ziprecruiter';
import { ScraperInputDto, Site, Country, DescriptionFormat } from '@ever-jobs/models';

const describeNetwork = process.env.RUN_NETWORK_E2E ? describe : describe.skip;

async function createService(): Promise<ZipRecruiterService> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [ZipRecruiterModule],
  }).compile();

  return module.get<ZipRecruiterService>(ZipRecruiterService);
}

describe('ZipRecruiterService (E2E, offline)', () => {
  it('returns bad_input for a country the board does not serve, without a request', async () => {
    const service = await createService();
    const input = new ScraperInputDto({
      siteType: [Site.ZIP_RECRUITER],
      searchTerm: 'software engineer',
      location: 'Berlin',
      resultsWanted: 3,
      country: Country.GERMANY,
    });

    const started = Date.now();
    const response = await service.scrape(input);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.jobs).toEqual([]);
    expect(response.diagnostics?.reason).toBe('bad_input');
    expect(response.diagnostics?.detail).toMatch(/US\/Canada/);
  });
});

describeNetwork('ZipRecruiterService (network E2E)', () => {
  let service: ZipRecruiterService;

  beforeAll(async () => {
    service = await createService();
  });

  it('returns jobs or an explanation, never a bare zero', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.ZIP_RECRUITER],
      searchTerm: 'software engineer',
      location: 'Austin, TX',
      resultsWanted: 3,
      country: Country.USA,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length > 0 || response.diagnostics !== undefined).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.id).toMatch(/^zr-/);
      expect(job.jobUrl).toMatch(/\/jobs\/\/j\?lvk=/);
      expect(job.site).toBe(Site.ZIP_RECRUITER);
    } else if (/cf-waf/.test(response.diagnostics?.detail ?? '')) {
      // Egress outside North America (e.g. our EU fleet).
      expect(response.diagnostics?.reason).toBe('blocked');
    }
  }, 60000);
});
