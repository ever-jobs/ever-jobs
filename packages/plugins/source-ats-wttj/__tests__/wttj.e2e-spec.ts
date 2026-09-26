/**
 * E2E test for the Welcome to the Jungle (WTTJ) ATS scraper.
 *
 * No authentication required — WTTJ companies publish a public candidate-facing jobs page
 * at `https://www.welcometothejungle.com/{lang}/companies/{slug}/jobs`, powered by a
 * public, anonymous Algolia search index (`wttj_jobs_production_en` / `_fr`, app
 * `CSEKHVMS53`, with search-only credentials embedded in the WTTJ front-end). The adapter
 * queries that index directly with a `facetFilters` of `["organization.slug:{slug}"]` and
 * maps each hit; each hit's `reference` guid + `slug` build the canonical detail / apply
 * URLs (`/{lang}/companies/{org.slug}/jobs/{job.slug}`). The adapter resolves the company
 * from a `companySlug` (e.g. `groupe-partnaire`) or a full `companyUrl`. Tests run against
 * a known WTTJ company but tolerate upstream changes / empty boards by treating zero
 * results as acceptable; the shape assertions only run when jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { WelcomeToTheJungleModule, WelcomeToTheJungleService } from '@ever-jobs/source-ats-wttj';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public WTTJ company (Groupe Partnaire — confirmed live 2026-06-03, 48 open roles).
const KNOWN_COMPANY = 'groupe-partnaire';

describe('WelcomeToTheJungleService (E2E)', () => {
  let service: WelcomeToTheJungleService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [WelcomeToTheJungleModule],
    }).compile();

    service = module.get<WelcomeToTheJungleService>(WelcomeToTheJungleService);
  });

  it('should return job results for a known WelcomeToTheJungle company', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      companySlug: KNOWN_COMPANY,
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.WTTJ);
      expect(job.atsType).toBe('wttj');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toBeDefined();
    }
  }, 30000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should resolve a company from a full companyUrl', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      companyUrl: `https://www.welcometothejungle.com/en/companies/${KNOWN_COMPANY}/jobs`,
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should handle an unknown company gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      companySlug: 'this-company-definitely-does-not-exist-xyz-99999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBe(0);
  }, 30000);

  // Spec 1705: with no company but a search criterion, the same registration searches the
  // whole board. Tolerant like the cases above: zero results are accepted.
  it('should search the whole board when a search term is given without a company', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      searchTerm: 'data',
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    for (const job of response.jobs) {
      expect(job.site).toBe(Site.WTTJ);
      expect(job.jobUrl).toMatch(/welcometothejungle\.com\/(en|fr|es|cs|sk)\/companies\/[^/]+\/jobs\//);
      expect(typeof job.isRemote).toBe('boolean');
    }
  }, 30000);

  it('should return only fully remote roles for a remote board search', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      searchTerm: 'engineer',
      isRemote: true,
      hoursOld: 168,
      resultsWanted: 3,
    });

    const response = await service.scrapeBoard(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    for (const job of response.jobs) {
      expect(job.isRemote).toBe(true);
    }
  }, 30000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.WTTJ],
      companySlug: KNOWN_COMPANY,
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 30000);
});
