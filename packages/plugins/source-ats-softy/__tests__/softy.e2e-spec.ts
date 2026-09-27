/**
 * E2E test for the Softy (softy.pro) ATS scraper.
 *
 * No authentication required — Softy tenants publish a public, server-rendered
 * careers board (`https://{tenant}.softy.pro/offers?page=N`) and a `/sitemap.xml`
 * listing every open offer (`/offers/{ID}` with `<lastmod>`). The adapter resolves the
 * tenant from a `companySlug` (the sub-domain label, e.g. `ensio`) or a full
 * `companyUrl`.
 *
 * LIVE requests are opt-in (Spec 1715 FR-19, audit G26/G30): Softy's operator asked us
 * to be gentle, so the two live tests run only when `EVER_JOBS_LIVE_SOFTY=1` — which
 * CI sets on its weekly `schedule` and on a manual `workflow_dispatch` (or through the
 * `EVER_JOBS_LIVE_SOFTY` repository variable), never on a push or pull request. Without
 * it they are skipped under a title that says why, and the offline test still runs.
 *
 * When live, at most two tests touch the network, each with `resultsWanted <= 3` (the
 * first reads the sitemap plus at most three detail pages, one at a time — and asserts
 * the sitemap was the FIRST request, so a silent regression to list pages fails; the
 * second reads a single listing page). Everything else — discovery modes, pagination,
 * legacy markup, caching, failure handling, pacing — is covered offline by
 * `softy.service.spec.ts`, `softy.policy.spec.ts` and `softy.integration.spec.ts`.
 * Tests tolerate upstream changes / empty boards by treating zero results as
 * acceptable; the shape assertions only run when jobs are actually returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { HttpClient } from '@ever-jobs/common';
import { SoftyModule, SoftyService } from '@ever-jobs/source-ats-softy';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

// Public Softy-powered careers board (ENSIO — verified live 2026-09-24, Spec 1691).
const KNOWN_TENANT = 'ensio';

/** `EVER_JOBS_LIVE_SOFTY=1` runs the live tests (CI: schedule / workflow_dispatch). */
const LIVE_SOFTY_ENV = 'EVER_JOBS_LIVE_SOFTY';
const LIVE = process.env[LIVE_SOFTY_ENV] === '1';
const describeLive = LIVE ? describe : describe.skip;
const LIVE_TITLE = LIVE
  ? 'SoftyService (E2E, live)'
  : `live Softy e2e — skipped: set ${LIVE_SOFTY_ENV}=1 (CI: schedule / workflow_dispatch)`;

describe('SoftyService (E2E)', () => {
  let service: SoftyService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [SoftyModule],
    }).compile();

    service = module.get<SoftyService>(SoftyService);
  });

  describeLive(LIVE_TITLE, () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return at most resultsWanted jobs for a known Softy tenant, reading the sitemap first', async () => {
      const request = jest.spyOn(HttpClient.prototype, 'request');
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

      // Sitemap-first for real (G26): the first request of the scrape is /sitemap.xml.
      expect(request).toHaveBeenCalled();
      const first = request.mock.calls[0][0] as { url?: string };
      expect(String(first.url)).toMatch(/\/sitemap\.xml$/);

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
  });

  it('should return empty results when neither companySlug nor companyUrl is provided (offline)', async () => {
    const request = jest.spyOn(HttpClient.prototype, 'request');
    const input = new ScraperInputDto({
      siteType: [Site.SOFTY],
      resultsWanted: 3,
    });

    const response = await service.scrape(input);

    expect(response).toBeDefined();
    expect(response.jobs.length).toBe(0);
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });
});
