/**
 * E2E test for the Hireserve ATS scraper.
 *
 * No authentication required — Hireserve tenants publish a public, server-rendered
 * candidate careers portal via the Oracle PL/SQL "wd_portal" web application,
 * addressed by a host plus a numeric `p_web_site_id`. The adapter enumerates open
 * roles from the public listing
 * `https://{host}/wd/plsql/wd_portal.list?p_web_site_id={id}&p_function=map&p_title=Current+Vacancies`,
 * which lists each role as a canonical vacancy anchor `/vacancy/{slug}-{ID}.html`
 * (where `{ID}` is the stable `p_web_page_id`), then fetches each role's detail page.
 * The adapter resolves the tenant from a `companyUrl` (a portal URL carrying the
 * `p_web_site_id`) or a `companySlug` of the form `{host}:{siteId}`. Tests run
 * against a known Hireserve-powered tenant but tolerate upstream changes / empty
 * feeds by treating zero results as acceptable; the shape assertions only run when
 * jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { HireserveModule, HireserveService } from '@ever-jobs/source-ats-hireserve';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public Hireserve-powered portal (University of Hireserve demo — confirmed live 2026-06-03).
const KNOWN_HOST = 'university.hireserve-projects.com';
const KNOWN_SITE_ID = '2624';
const KNOWN_SLUG = `${KNOWN_HOST}:${KNOWN_SITE_ID}`;
const KNOWN_URL = `https://${KNOWN_HOST}/wd/plsql/wd_portal.list?p_web_site_id=${KNOWN_SITE_ID}&p_function=map&p_title=Current+Vacancies`;

describe('HireserveService (E2E)', () => {
  let service: HireserveService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HireserveModule],
    }).compile();

    service = module.get<HireserveService>(HireserveService);
  });

  it('should return job results for a known Hireserve tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.HIRESERVE],
      companySlug: KNOWN_SLUG,
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.HIRESERVE);
      expect(job.atsType).toBe('hireserve');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toBeDefined();
    }
    // Live site: its responses take seconds each, and since Spec 1690 the detail
    // fetches are paced per host (not fired all at once), so the first (cold) run
    // can exceed 30 s legitimately.
  }, 60000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.HIRESERVE],
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });

  it('should resolve a target from a full companyUrl', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.HIRESERVE],
      companyUrl: KNOWN_URL,
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
  }, 30000);

  it('should return empty for a bare slug with no site id (not self-describing)', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.HIRESERVE],
      companySlug: 'university',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBe(0);
  });

  it('should handle an unknown tenant gracefully', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.HIRESERVE],
      companySlug: 'this-tenant-definitely-does-not-exist-xyz-99999:999999',
      resultsWanted: 5,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBe(0);
  }, 30000);

  it('should respect the resultsWanted limit', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.HIRESERVE],
      companySlug: KNOWN_SLUG,
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.PLAIN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBeLessThanOrEqual(3);
  }, 30000);
});
