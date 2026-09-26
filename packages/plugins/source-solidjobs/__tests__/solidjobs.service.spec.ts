import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CompensationInterval,
  Country,
  DescriptionFormat,
  JobResponseDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

const API = 'https://solid.jobs/public-api/offers';
/** An empty page: what every division not routed by a test returns. */
const EMPTY_PAGE = { data: { jobs: [], totalCount: 0, totalPages: 0 } };

import { SolidJobsModule } from '../src/solidjobs.module';
import { SolidJobsService } from '../src/solidjobs.service';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'solidjobs-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Rewrite every jobOfferKey so a second division serves distinct offers. */
function rekey(page: any, suffix: string): any {
  const copy = clone(page);
  for (const job of copy.jobs) job.jobOfferKey = `${job.jobOfferKey}-${suffix}`;
  return copy;
}

/**
 * Spec 718 / T06 — `SolidJobsService` unit tests (fixture of 3 real
 * offers captured from the live `it` division on 2026-06-11). Updated by
 * Spec 1709: every division is scanned by default, requests carry
 * `pageSize`/`pageIndex`, and unrouted divisions answer an empty page.
 */
describe('SolidJobsService — Spec 718 / T06', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(EMPTY_PAGE);
    delete process.env.SOLIDJOBS_DIVISIONS;
  });

  afterAll(() => {
    delete process.env.SOLIDJOBS_DIVISIONS;
  });

  describe('registration scaffolding', () => {
    it('resolves through SolidJobsModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SolidJobsModule],
      }).compile();
      const service = moduleRef.get(SolidJobsService);
      expect(service).toBeInstanceOf(SolidJobsService);
      await moduleRef.close();
    });

    it('exports Site.SOLIDJOBS = "solidjobs", distinct from Site.SOLIDES', () => {
      expect(Site.SOLIDJOBS).toBe('solidjobs');
      expect(Site.SOLIDES).toBe('solides');
      expect(Site.SOLIDJOBS).not.toBe(Site.SOLIDES);
    });
  });

  describe('happy path', () => {
    it('maps all fixture offers to JobPostDto and hits the campaign URL', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      for (let i = 0; i < dto.jobs.length; i++) {
        const wire = JOBS_PAGE_RAW.jobs[i];
        const job = dto.jobs[i];
        expect(job.id).toBe(`solidjobs-${wire.jobOfferKey}`);
        expect(job.title).toBe(wire.title);
        expect(job.jobUrl).toBe(wire.url);
        expect(job.jobUrl).toContain('https://solid.jobs/o/');
        expect(job.companyName).toBe(wire.company);
        expect(job.site).toBe(Site.SOLIDJOBS);
        expect(job.location?.city).toBe(wire.locations[0]);
        expect(job.location?.state ?? null).toBeNull();
        // Spec 1709: the board-level country (every offer is in Poland).
        expect(job.location?.country).toBe(Country.POLAND);
        expect(job.isRemote).toBe(wire.isRemote === true);
      }

      // Spec 1709: `it` first, sized to the request; the 3-offer page cannot
      // fill 100, so the other seven divisions follow.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(`${API}/it?campaign=api&pageSize=100&pageIndex=0`);
      expect(calledUrls).toHaveLength(8);
      expect(calledUrls).toEqual(
        expect.arrayContaining(
          ['sales', 'marketing', 'logistics', 'finances', 'engineering', 'other', 'hr'].map(
            (d) => `${API}/${d}?campaign=api&pageSize=100&pageIndex=0`,
          ),
        ),
      );
      expect(dto.diagnostics).toBeUndefined();
    });
  });

  describe('salary mapping', () => {
    it('maps the salary object to a monthly PLN CompensationDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);

      const wire = JOBS_PAGE_RAW.jobs[0];
      const job = result.jobs.find(
        (j) => j.id === `solidjobs-${wire.jobOfferKey}`,
      );
      expect(job?.compensation).toBeDefined();
      expect(job?.compensation?.minAmount).toBe(wire.salary.from);
      expect(job?.compensation?.maxAmount).toBe(wire.salary.to);
      expect(job?.compensation?.currency).toBe('PLN');
      expect(job?.compensation?.interval).toBe(CompensationInterval.MONTHLY);
    });

    it('maps a null salary to no compensation while still emitting the job', async () => {
      const page = clone(JOBS_PAGE_RAW) as any;
      page.jobs[0].salary = null;
      mockGet.mockResolvedValueOnce({ data: page });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(3);
      const job = result.jobs.find(
        (j) => j.id === `solidjobs-${JOBS_PAGE_RAW.jobs[0].jobOfferKey}`,
      );
      expect(job).toBeDefined();
      expect(job?.compensation ?? null).toBeNull();
    });
  });

  describe('jobType mapping', () => {
    it('resolves full_time and part_time contractTime values', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);

      for (let i = 0; i < result.jobs.length; i++) {
        const wire = JOBS_PAGE_RAW.jobs[i];
        const expected =
          wire.contractTime === 'part_time'
            ? JobType.PART_TIME
            : JobType.FULL_TIME;
        expect(result.jobs[i].jobType).toEqual([expected]);
      }
      // Fixture guarantees both branches are exercised.
      expect(
        JOBS_PAGE_RAW.jobs.some((j: any) => j.contractTime === 'part_time'),
      ).toBe(true);
      expect(
        JOBS_PAGE_RAW.jobs.some((j: any) => j.contractTime === 'full_time'),
      ).toBe(true);
    });
  });

  describe('descriptionFormat', () => {
    it('converts HTML to plain text by default', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);

      const job = result.jobs[0];
      expect(job.description).toBeTruthy();
      expect(job.description).not.toContain('<div');
      expect(job.description).not.toContain('<p>');
      expect(job.description).not.toContain('<li>');
    });

    it('passes raw HTML through when DescriptionFormat.HTML is requested', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        descriptionFormat: DescriptionFormat.HTML,
      } as ScraperInputDto);

      const job = result.jobs[0];
      expect(job.description).toBe(JOBS_PAGE_RAW.jobs[0].description);
      expect(job.description).toContain('<');
    });

    it('converts HTML to markdown when DescriptionFormat.MARKDOWN is requested', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        descriptionFormat: DescriptionFormat.MARKDOWN,
      } as ScraperInputDto);

      const job = result.jobs[0];
      expect(job.description).toBeTruthy();
      // Fixture description carries <strong> headings → markdown bold.
      expect(job.description).toContain('**');
      expect(job.description).not.toContain('<div');
      expect(job.description).not.toContain('<li>');
    });
  });

  describe('searchTerm filter', () => {
    it('matches case-insensitively on title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidJobsService();
      const term = String(JOBS_PAGE_RAW.jobs[0].title).toLowerCase();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      expect(result.jobs.map((j) => j.id)).toContain(
        `solidjobs-${JOBS_PAGE_RAW.jobs[0].jobOfferKey}`,
      );
    });

    it('matches on subCategory', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidJobsService();
      const term = String(JOBS_PAGE_RAW.jobs[1].subCategory).toUpperCase();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.map((j) => j.id)).toContain(
        `solidjobs-${JOBS_PAGE_RAW.jobs[1].jobOfferKey}`,
      );
    });

    it('matches on skill names', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidJobsService();
      const skillOffer = JOBS_PAGE_RAW.jobs.find(
        (j: any) => (j.skills ?? []).length > 0,
      );
      const term = String(skillOffer.skills[0].name).toLowerCase();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.map((j) => j.id)).toContain(
        `solidjobs-${skillOffer.jobOfferKey}`,
      );
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-offer page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('SOLIDJOBS_DIVISIONS override', () => {
    it('fans out one request per configured division and concatenates results', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it, engineering';
      mockGet.mockImplementation(async (url: string) =>
        url.includes('/engineering?')
          ? { data: rekey(JOBS_PAGE_RAW, 'eng') }
          : { data: clone(JOBS_PAGE_RAW) },
      );

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        resultsWanted: 100,
      } as ScraperInputDto);

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls).toEqual([
        `${API}/it?campaign=api&pageSize=100&pageIndex=0`,
        `${API}/engineering?campaign=api&pageSize=100&pageIndex=0`,
      ]);
      expect(result.jobs).toHaveLength(6);
      // Division order, not completion order.
      expect(result.jobs.slice(0, 3).map((j) => j.id)).toEqual(
        JOBS_PAGE_RAW.jobs.map((j: any) => `solidjobs-${j.jobOfferKey}`),
      );
    });

    it('de-duplicates an offer served by two divisions (Spec 1709)', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it, engineering';
      mockGet.mockResolvedValue({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
        resultsWanted: 100,
      } as ScraperInputDto);

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(3);
      expect(new Set(result.jobs.map((j) => j.id)).size).toBe(3);
    });

    it('keeps the batch alive when one division request fails', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it,engineering';
      mockGet
        .mockRejectedValueOnce(new Error('Request failed with status 500'))
        .mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(3);
      // Spec 1709: 3 < 100 wanted, so the failure is reported (the fan-out infers partial).
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(result.diagnostics?.detail).toContain('it');
    });
  });

  describe('error handling', () => {
    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });

    it('returns empty for an invalid payload shape', async () => {
      mockGet.mockResolvedValueOnce({ data: { unexpected: true } });
      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      // Spec 1709: an invalid payload is a failure, not an empty board.
      expect(result.diagnostics?.reason).toBe('unknown');
      expect(result.diagnostics?.detail).toContain('invalid payload');
    });

    it('catches an HTTP failure → empty JobResponseDto, never throws', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('reports fetch_error when every default division fails (Spec 1709)', async () => {
      mockGet.mockRejectedValue(new Error('Request failed with status 500'));
      const service = new SolidJobsService();
      const result = await service.scrape({
        siteType: [Site.SOLIDJOBS],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).toHaveBeenCalledTimes(8);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('skips a malformed offer (missing title) with a Logger.warn while mapping siblings', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const page = clone(JOBS_PAGE_RAW) as any;
        page.jobs[0].title = '';
        mockGet.mockResolvedValueOnce({ data: page });

        const service = new SolidJobsService();
        const result = await service.scrape({
          siteType: [Site.SOLIDJOBS],
        } as ScraperInputDto);

        expect(result.jobs).toHaveLength(2);
        expect(result.jobs.map((j) => j.id)).not.toContain(
          `solidjobs-${JOBS_PAGE_RAW.jobs[0].jobOfferKey}`,
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(JOBS_PAGE_RAW.jobs[0].jobOfferKey),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
