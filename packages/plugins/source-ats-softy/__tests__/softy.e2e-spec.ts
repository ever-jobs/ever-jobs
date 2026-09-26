/**
 * E2E test for the Softy (softy.pro) ATS scraper.
 *
 * No authentication required — Softy tenants publish a public, server-rendered
 * careers board (`https://{tenant}.softy.pro/offers?page=N`) and a `/sitemap.xml`
 * listing every open offer (`/offers/{ID}` with `<lastmod>`). The adapter resolves the
 * tenant from a `companySlug` (the sub-domain label, e.g. `ensio`) or a full
 * `companyUrl`.
 *
 * Kept deliberately small (Spec 1691): Softy's operator asked us to be gentle, and
 * this spec runs against the live site in CI. At most two tests touch the network,
 * each with `resultsWanted <= 3` (the first reads the sitemap plus at most three
 * detail pages, one at a time; the second reads a single listing page). Everything
 * else — discovery modes, pagination, legacy markup, caching, failure handling — is
 * covered offline by `softy.service.spec.ts` against synthetic fixtures. Tests
 * tolerate upstream changes / empty boards by treating zero results as acceptable;
 * the shape assertions only run when jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SoftyModule, SoftyService } from '@ever-jobs/source-ats-softy';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public Softy-powered careers board (ENSIO — verified live 2026-09-24, Spec 1691).
const KNOWN_TENANT = 'ensio';

describe('SoftyService (E2E)', () => {
  let service: SoftyService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [SoftyModule],
    }).compile();

    service = module.get<SoftyService>(SoftyService);
  });

  it('should return at most resultsWanted jobs for a known Softy tenant', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.SOFTY],
      companySlug: KNOWN_TENANT,
      resultsWanted: 3,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);

    if (response.jobs.length > 0) {
      const job = response.jobs[0];
      expect(typeof job.title).toBe('string');
      expect(job.site).toBe(Site.SOFTY);
      expect(job.atsType).toBe('softy');
      expect(job.atsId).toBeDefined();
      expect(job.jobUrl).toMatch(/^https:\/\/ensio\.softy\.pro\/offers\/\d+$/);
    }
  }, 60000);

  it('should resolve a tenant from a full companyUrl (one listing page, no detail pages)', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.SOFTY],
      companyUrl: `https://${KNOWN_TENANT}.softy.pro/offers`,
      resultsWanted: 1,
      descriptionDepth: 'board',
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(1);
  }, 30000);

  it('should return empty results when neither companySlug nor companyUrl is provided', async () => {
    const input = new ScraperInputDto({
      siteType: [Site.SOFTY],
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
  });
});
