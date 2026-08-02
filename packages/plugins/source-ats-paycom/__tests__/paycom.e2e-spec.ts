/**
 * E2E test for the Paycom ATS scraper.
 *
 * No authentication required — Paycom serves a public, clientkey-addressed
 * careers board from `paycomonline.net`
 * (`/v4/ats/web.php/portal/{KEY}/career-page`). The board is a client-rendered
 * React app that boots a public bearer (`configsFromHost.sessionJWT`) the
 * adapter reads to call the applicant-tracking JSON API: a search endpoint
 * (`/api/ats/job-posting-previews/search`, full `filtersForQuery`) enumerates
 * roles and a detail endpoint (`/api/ats/job-postings/{id}`) returns each role
 * (with a `googleJobJson` schema.org node for the date / canonical URL). The
 * adapter resolves the tenant from a `companySlug` (the bare `clientkey`) or a
 * board `companyUrl`. Tests run against a known Paycom-powered tenant but
 * tolerate upstream changes / empty feeds by treating zero results as
 * acceptable; shape assertions only run when jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PaycomModule, PaycomService } from '@ever-jobs/source-ats-paycom';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public Paycom-powered careers board (Club Champion — confirmed 2026-06-03).
const KNOWN_CLIENTKEY = '03A0C40668106F27C234F910C58A5717';

describe('PaycomService (E2E)', () => {
  let service: PaycomService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PaycomModule],
    }).compile();

    service = module.get<PaycomService>(PaycomService);
  });

  it('should return job results for a known Paycom tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.PAYCOM],
      companySlug: KNOWN_CLIENTKEY,
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.PAYCOM);
      expect(job.atsType).toBe('paycom');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toBeDefined();
    }
  }, 30000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.PAYCOM],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should resolve a tenant from a full board companyUrl', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.PAYCOM],
      companyUrl: `https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=${KNOWN_CLIENTKEY}`,
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should handle an unknown tenant gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.PAYCOM],
      companySlug: 'THISTENANTDEFINITELYDOESNOTEXISTXYZ99999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.PAYCOM],
      companySlug: KNOWN_CLIENTKEY,
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 30000);
});
