import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

/**
 * Mock the `@ever-jobs/common.createHttpClient` factory so the
 * scraper hits a controlled fixture pipeline instead of a real Oracle
 * tenant. Same shape as the Avature spec (Spec 006 / T04) — keeps the
 * test surface uniform across ATS plugins.
 */
const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: mockSetHeaders,
    })),
  };
});

import {
  ORACLE_DEFAULT_FACETS,
  ORACLE_DEFAULT_HOST_SEGMENT,
  ORACLE_DEFAULT_SITE_NUMBER,
  ORACLE_RECORDS_PER_PAGE,
  OracleJobsResponse,
  OracleModule,
  OracleService,
} from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const PAGE_1_FIXTURE: OracleJobsResponse = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'oracle-page-1.json'), 'utf8'),
);

const EMPTY_PAGE: OracleJobsResponse = {
  items: [{ TotalJobsCount: 0, requisitionList: [] }],
};

/**
 * Build a page response with `count` synthetic requisitions whose
 * `Id`s start at `startId`. Used by the resultsWanted-cap test which
 * needs a ≥ 200-job corpus across multiple pages without ballooning
 * the on-disk fixture.
 */
function buildSyntheticPage(
  count: number,
  startId: number,
): OracleJobsResponse {
  const requisitionList = Array.from({ length: count }, (_, i) => ({
    Id: String(startId + i),
    Title: `Synthetic Engineer ${startId + i}`,
    PrimaryLocation: 'Austin, TX, United States',
    PostedDate: '2025-12-01',
    EmployerName: 'Oracle',
    ExternalUrl: null,
    ExternalUrlSeo: null,
    RequisitionNumber: `REQ_${startId + i}`,
  }));
  return {
    items: [
      {
        TotalJobsCount: count,
        requisitionList,
      },
    ],
  };
}

/**
 * Spec 013 / T04 — Oracle behavioural unit-test sweep.
 *
 * Cases (per tasks.md acceptance):
 *   1. Registration — DI resolves OracleService via OracleModule.
 *   2. Bad-tenant guard — neither companyUrl nor companySlug supplied.
 *   3. Site enum literal-string assertion.
 *   4. Constants pin — eight-facet list + CX_45001 default.
 *   5. Happy path — single populated page from fixture.
 *   6. Empty `requisitionList[]` — zero-row first page.
 *   7. HTTP 500 — caught, returns empty JobResponseDto.
 *   8. resultsWanted cap — ≥ 200-job synthetic corpus, cap at 5.
 *   9. companyUrl override — custom-tenant URL used verbatim.
 *  10. Custom `siteNumber` override — appears verbatim in finder URL.
 */
describe('OracleService (Spec 013 / T03 + T04 — REST + finder-string)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  describe('registration scaffolding (carries forward from T02 / T03)', () => {
    it('resolves through OracleModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [OracleModule],
      }).compile();

      const service = moduleRef.get(OracleService);
      expect(service).toBeInstanceOf(OracleService);
      await moduleRef.close();
    });

    it('returns an empty JobResponseDto when neither companyUrl nor companySlug supplied (ERR_ORACLE_BAD_TENANT)', async () => {
      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
      } as ScraperInputDto;
      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('exports the Site.ORACLE = "oracle" enum value', () => {
      expect(Site.ORACLE).toBe('oracle');
    });

    it('exports the documented eight-facet list and the CX_45001 default', () => {
      expect(ORACLE_DEFAULT_SITE_NUMBER).toBe('CX_45001');
      expect([...ORACLE_DEFAULT_FACETS]).toEqual([
        'LOCATIONS',
        'WORK_LOCATIONS',
        'WORKPLACE_TYPES',
        'TITLES',
        'CATEGORIES',
        'ORGANIZATIONS',
        'POSTING_DATES',
        'FLEX_FIELDS',
      ]);
    });
  });

  describe('happy path — single populated page', () => {
    it('parses 5 fixture jobs into JobPostDto rows with correct mapping', async () => {
      mockGet
        .mockResolvedValueOnce({ data: PAGE_1_FIXTURE })
        .mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'eeho-us2',
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toHaveLength(5);

      const first = result.jobs[0];
      expect(first.id).toBe('oracle-320918');
      expect(first.title).toBe('Senior Software Engineer');
      expect(first.companyName).toBe('Oracle');
      expect(first.site).toBe(Site.ORACLE);
      expect(first.atsId).toBe('320918');
      expect(first.atsType).toBe('oracle');
      expect(first.location?.city).toBe('Austin, TX, United States');
      expect(first.datePosted).toBe('2025-12-19');
      expect(first.isRemote).toBe(false);
      // ExternalUrlSeo path used when ExternalUrl is null.
      expect(first.jobUrl).toBe(
        'https://eeho.fa.us2.oraclecloud.com/careers/job/senior-software-engineer-austin',
      );

      // Remote-detection sanity check on the cloud-architect row.
      const remoteJob = result.jobs.find((j) => j.id === 'oracle-319201');
      expect(remoteJob?.isRemote).toBe(true);

      // ExternalUrl override path — used verbatim when set.
      const externalUrlJob = result.jobs.find((j) => j.id === 'oracle-318044');
      expect(externalUrlJob?.jobUrl).toBe(
        'https://oracle.example/job/318044/apply',
      );

      // EmployerName-null fallback to tenant.companyName ("Eeho" from
      // hostname's first segment, title-cased).
      const fallbackNameJob = result.jobs.find((j) => j.id === 'oracle-316777');
      expect(fallbackNameJob?.companyName).toBe('Eeho');
      // No ExternalUrlSeo → falls back to the bare Id in the slug position.
      expect(fallbackNameJob?.jobUrl).toBe(
        'https://eeho.fa.us2.oraclecloud.com/careers/job/316777',
      );
    });
  });

  describe('empty board', () => {
    it('first page empty → returns empty JobResponseDto without further pagination', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'noresults-us2',
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toEqual([]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP failure', () => {
    it('catches a 500 and returns an empty JobResponseDto (never throws)', async () => {
      mockGet.mockRejectedValueOnce({
        message: 'Request failed with status 500',
        response: { status: 500 },
      });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'broken-us2',
      } as ScraperInputDto;

      await expect(service.scrape(input)).resolves.toBeInstanceOf(
        JobResponseDto,
      );
    });
  });

  describe('resultsWanted cap mid-page', () => {
    it('honours resultsWanted=5 against the 200-job synthetic corpus and short-circuits before page 2', async () => {
      // Two full pages of 100 jobs each = 200-row corpus.
      const page1 = buildSyntheticPage(ORACLE_RECORDS_PER_PAGE, 1);
      const page2 = buildSyntheticPage(ORACLE_RECORDS_PER_PAGE, 101);
      mockGet
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'eeho-us2',
        resultsWanted: 5,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(5);
      // Cap fires before the second pagination request would.
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs[0].id).toBe('oracle-1');
      expect(result.jobs[4].id).toBe('oracle-5');
    });
  });

  describe('custom-domain override via companyUrl', () => {
    it('uses companyUrl verbatim and resolves company name from the host', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companyUrl: 'https://careers.acme-corp.com',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(
        calledUrl.startsWith(
          'https://careers.acme-corp.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions',
        ),
      ).toBe(true);
      // Default site number used when not overridden.
      expect(calledUrl).toContain(`siteNumber=${ORACLE_DEFAULT_SITE_NUMBER}`);
    });
  });

  describe('custom siteNumber override', () => {
    it('places the override verbatim in the finder string (replacing CX_45001)', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'eeho-us2',
        siteNumber: 'CX_99999',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('siteNumber=CX_99999');
      expect(calledUrl).not.toContain('siteNumber=CX_45001');
      // Wire-format invariant: comma-separated finder params, not all-semicolon.
      expect(calledUrl).toContain(',facetsList=');
      // First-page request: offset= absent (matches upstream Python).
      expect(calledUrl).not.toContain('offset=');
    });
  });

  describe('colon-slug parsing (Spec 5037)', () => {
    it('full-host colon slug uses host verbatim and extracts siteNumber', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com:CX_1',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(
        'https://fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com/hcmRestApi',
      );
      expect(calledUrl).toContain('siteNumber=CX_1');
      expect(calledUrl).not.toContain(ORACLE_DEFAULT_SITE_NUMBER);
    });

    it('bare-subdomain colon slug composes host with default ocs segment', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'fa-esbv-saasfaprod1:CX_1',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(
        `https://fa-esbv-saasfaprod1.fa.${ORACLE_DEFAULT_HOST_SEGMENT}.oraclecloud.com/hcmRestApi`,
      );
      expect(calledUrl).toContain('siteNumber=CX_1');
    });

    it('region-code full-host slug preserves the real region (us8)', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'ewvl.fa.us8.oraclecloud.com:CX_1',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(
        'https://ewvl.fa.us8.oraclecloud.com/hcmRestApi',
      );
      expect(calledUrl).toContain('siteNumber=CX_1');
    });

    it('input.siteNumber overrides slug-derived siteNumber', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com:CX_1',
        siteNumber: 'CX_OVERRIDE',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('siteNumber=CX_OVERRIDE');
      expect(calledUrl).not.toContain('siteNumber=CX_1');
    });
  });

  describe('siteNumber from companyUrl path (Spec 5037)', () => {
    it('extracts siteNumber from /sites/{CX} in the URL', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY_PAGE });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companyUrl:
          'https://fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs',
      } as ScraperInputDto;

      await service.scrape(input);

      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('siteNumber=CX_1');
      expect(calledUrl).not.toContain(ORACLE_DEFAULT_SITE_NUMBER);
    });
  });

  describe('pagination: short mid-pages (Spec 5037)', () => {
    function buildPage(
      count: number,
      startId: number,
      total: number,
    ): OracleJobsResponse {
      const requisitionList = Array.from({ length: count }, (_, i) => ({
        Id: String(startId + i),
        Title: `Job ${startId + i}`,
        PrimaryLocation: 'Location',
        PostedDate: '2025-12-01',
        EmployerName: 'Acme',
      }));
      return { items: [{ TotalJobsCount: total, requisitionList }] };
    }

    it('does not stop on a short mid-page; paginates to TotalJobsCount', async () => {
      // Simulate Oracle returning 100, 99, 45 (total 244).
      mockGet
        .mockResolvedValueOnce({ data: buildPage(100, 1, 244) })
        .mockResolvedValueOnce({ data: buildPage(99, 101, 244) })
        .mockResolvedValueOnce({ data: buildPage(45, 200, 244) })
        .mockResolvedValueOnce({ data: { items: [{ TotalJobsCount: 244, requisitionList: [] }] } });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'eeho-us2',
        resultsWanted: 9999,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      // 100 + 99 + 45 = 244 total — the third page reaches TotalJobsCount.
      expect(result.jobs).toHaveLength(244);
      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it('old behaviour (short page = stop) would have returned only 199', async () => {
      // Same setup but cap at 199 → proves the fix actually changed behaviour.
      mockGet
        .mockResolvedValueOnce({ data: buildPage(100, 1, 244) })
        .mockResolvedValueOnce({ data: buildPage(99, 101, 244) })
        .mockResolvedValueOnce({ data: buildPage(45, 200, 244) });

      const service = new OracleService();
      const input: ScraperInputDto = {
        siteType: [Site.ORACLE],
        companySlug: 'eeho-us2',
        resultsWanted: 199,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(199);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });
  });
});
