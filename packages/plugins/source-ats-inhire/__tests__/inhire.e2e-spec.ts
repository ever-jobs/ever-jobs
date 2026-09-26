/**
 * Network smoke test for the InHire ATS scraper (Spec 1692).
 *
 * Hits the live public job-posts API, so it is **opt-in**: it only runs when
 * `RUN_NETWORK_E2E=1`, keeping CI and local runs deterministic and offline.
 * The fixture-driven coverage lives in `inhire.service.spec.ts` and
 * `inhire.helpers.spec.ts`.
 *
 * Each case makes at most one list call and three detail calls, paced by the
 * plugin. Upstream boards change, so zero jobs is acceptable; the shape
 * assertions only run when jobs come back.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';
import { InhireModule, InhireService } from '@ever-jobs/source-ats-inhire';

const SITE: Site = Site.INHIRE;

// Public InHire tenant (verified live 2026-09-24, 19 open roles).
const KNOWN_TENANT = 'olist';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const describeNetwork = process.env.RUN_NETWORK_E2E ? describe : describe.skip;

describeNetwork('InhireService (network E2E)', () => {
  let service: InhireService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [InhireModule],
    }).compile();

    service = module.get<InhireService>(InhireService);
  });

  it('returns well-formed jobs for a known tenant', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [SITE],
        companySlug: KNOWN_TENANT,
        resultsWanted: 3,
        descriptionFormat: DescriptionFormat.MARKDOWN,
      }),
    );

    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(3);
    for (const job of response.jobs) {
      expect(job.site).toBe(SITE);
      expect(job.atsType).toBe('inhire');
      expect(job.atsId).toMatch(UUID_RE);
      expect(job.id).toBe(`inhire-${job.atsId}`);
      expect(typeof job.title).toBe('string');
      expect(job.title.length).toBeGreaterThan(0);
      expect(new URL(job.jobUrl).hostname).toMatch(/\.inhire\.com\.br$|\.inhire\.app$/);
      expect(typeof job.isRemote).toBe('boolean');
      if (job.datePosted != null) expect(String(job.datePosted)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 60_000);

  it('returns bad_input without any request when no tenant is given', async () => {
    const response = await service.scrape(new ScraperInputDto({ siteType: [SITE], resultsWanted: 3 }));
    expect(response.jobs).toEqual([]);
    expect(response.diagnostics?.reason).toBe('bad_input');
  });

  it('resolves the tenant from a companyUrl', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [SITE],
        companyUrl: `https://${KNOWN_TENANT}.inhire.app/vagas`,
        resultsWanted: 1,
      }),
    );
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs.length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('handles an unknown tenant without throwing', async () => {
    const response = await service.scrape(
      new ScraperInputDto({
        siteType: [SITE],
        companySlug: 'this-tenant-does-not-exist-xyz-99999',
        resultsWanted: 3,
      }),
    );
    expect(Array.isArray(response.jobs)).toBe(true);
    expect(response.jobs).toEqual([]);
  }, 60_000);
});
