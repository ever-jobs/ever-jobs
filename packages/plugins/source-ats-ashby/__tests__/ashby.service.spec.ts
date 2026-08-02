import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  CompensationInterval,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      setHeaders: jest.fn(),
    })),
  };
});

import { AshbyModule, AshbyService } from '../src';
import {
  ASHBY_INCLUDE_COMPENSATION_QUERY,
  ASHBY_PUBLIC_MAX_RETRIES,
  ASHBY_RETRY_BACKOFF,
} from '../src/ashby.constants';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const BOARD_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'ashby-jobs.json'), 'utf8'),
);

const SLUG = 'acme';
const EXPECTED_URL = `https://api.ashbyhq.com/posting-api/job-board/${SLUG}?includeCompensation=true`;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function timeoutError(): Error {
  return Object.assign(new Error('timeout of 10000ms exceeded'), {
    code: 'ECONNABORTED',
  });
}

function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

/**
 * Spec 719 — public-path compensation opt-in + retry resilience.
 */
describe('AshbyService — Spec 719', () => {
  const savedBackoff = { ...ASHBY_RETRY_BACKOFF };
  const savedApiKey = process.env.ASHBY_API_KEY;

  beforeAll(() => {
    // Shrink the retry backoff so retry-path tests finish quickly.
    ASHBY_RETRY_BACKOFF.baseDelayMs = 1;
    ASHBY_RETRY_BACKOFF.jitterMaxMs = 0;
  });

  afterAll(() => {
    Object.assign(ASHBY_RETRY_BACKOFF, savedBackoff);
    if (savedApiKey !== undefined) process.env.ASHBY_API_KEY = savedApiKey;
  });

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    // Keep the public path deterministic regardless of the host env.
    delete process.env.ASHBY_API_KEY;
  });

  describe('registration scaffolding', () => {
    it('resolves through AshbyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AshbyModule],
      }).compile();
      const service = moduleRef.get(AshbyService);
      expect(service).toBeInstanceOf(AshbyService);
      await moduleRef.close();
    });
  });

  describe('request URL — includeCompensation opt-in', () => {
    it('public GET URL carries includeCompensation=true', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const calledUrl = mockGet.mock.calls[0][0] as string;
      expect(calledUrl).toBe(EXPECTED_URL);
      expect(calledUrl).toContain(ASHBY_INCLUDE_COMPENSATION_QUERY);
      expect(calledUrl).toContain('includeCompensation=true');
    });

    it('authenticated POST URL carries includeCompensation=true', async () => {
      mockPost.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
        auth: { ashby: { apiKey: 'test-key' } },
      } as ScraperInputDto);

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockGet).not.toHaveBeenCalled();
      const calledUrl = mockPost.mock.calls[0][0] as string;
      expect(calledUrl).toBe(EXPECTED_URL);
      expect(calledUrl).toContain('includeCompensation=true');
      expect(result.jobs).toHaveLength(3);
    });
  });

  describe('happy path mapping', () => {
    it('maps listed fixture jobs and skips unlisted ones', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      const result = (await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto)) as JobResponseDto;

      // Fixture has 4 listings; one is isListed=false.
      expect(BOARD_RAW.jobs).toHaveLength(4);
      expect(result.jobs).toHaveLength(3);
      const job0 = result.jobs[0];
      expect(job0.id).toBe(`ashby-${BOARD_RAW.jobs[0].id}`);
      expect(job0.site).toBe(Site.ASHBY);
      expect(job0.atsType).toBe('ashby');
      expect(job0.companyName).toBe(SLUG);
      expect(result.jobs.map((j) => j.title)).not.toContain(
        'Unlisted Ghost Role',
      );
    });

    it('normalizes duplicate primary and secondary locations through the shared parser', async () => {
      const raw = clone(BOARD_RAW) as any;
      raw.jobs[0].location = 'Mountain View, CA';
      raw.jobs[0].address = null;
      raw.jobs[0].isRemote = false;
      raw.jobs[0].secondaryLocations = [
        { location: 'Mountain View, California, United States' },
        { location: 'Seattle, WA' },
        { location: 'Seattle, WA, United States' },
        { location: 'Remote' },
        { location: 'United States' },
      ];
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.location).toMatchObject({
        city: 'Mountain View, CA; Seattle, WA',
        country: 'United States',
      });
      expect(job?.isRemote).toBe(true);
      expect(job?.workFromHomeType).toBe('Remote');
    });
  });

  // Spec 5026 — structured workplaceType is authoritative over the boolean.
  describe('workplaceType remote detection (Spec 5026)', () => {
    async function mapFirstJob(mutate: (job: any) => void) {
      const raw = clone(BOARD_RAW) as any;
      const target = raw.jobs[0];
      target.location = 'Austin, TX';
      target.address = null;
      target.secondaryLocations = null;
      mutate(target);
      mockGet.mockResolvedValueOnce({ data: raw });

      const result = await new AshbyService().scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);
      return result.jobs.find((j) => j.id === `ashby-${target.id}`);
    }

    it('treats a Hybrid role (isRemote=true) as not remote', async () => {
      const job = await mapFirstJob((j) => {
        j.isRemote = true;
        j.workplaceType = 'Hybrid';
      });
      expect(job?.isRemote).toBe(false);
      expect(job?.workFromHomeType).toBe('Hybrid');
    });

    it('flags a Remote workplaceType as remote', async () => {
      const job = await mapFirstJob((j) => {
        j.isRemote = false;
        j.workplaceType = 'Remote';
      });
      expect(job?.isRemote).toBe(true);
      expect(job?.workFromHomeType).toBe('Remote');
    });

    it('falls back to the boolean when workplaceType is absent', async () => {
      const job = await mapFirstJob((j) => {
        j.isRemote = true;
        delete j.workplaceType;
      });
      expect(job?.isRemote).toBe(true);
    });
  });

  describe('compensation mapping', () => {
    it('maps the tiered shape (compensationComponents[].tiers[]) into CompensationDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.compensation).toBeDefined();
      expect(job?.compensation?.minAmount).toBe(150000);
      expect(job?.compensation?.maxAmount).toBe(190000);
      expect(job?.compensation?.currency).toBe('USD');
      expect(job?.compensation?.interval).toBe(CompensationInterval.YEARLY);
    });

    it('maps the flat public shape (summaryComponents / compensationTiers[].components) into CompensationDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[1].id}`,
      );
      expect(job?.compensation).toBeDefined();
      expect(job?.compensation?.minAmount).toBe(211400);
      expect(job?.compensation?.maxAmount).toBe(290600);
      expect(job?.compensation?.currency).toBe('USD');
      // "1 YEAR" wire interval must normalize to yearly.
      expect(job?.compensation?.interval).toBe(CompensationInterval.YEARLY);
    });

    it('prefers the salary component over equity in the flat shape', async () => {
      const raw = clone(BOARD_RAW) as any;
      // Move equity first so naive "first component" picking would fail.
      raw.jobs[1].compensation.summaryComponents.reverse();
      raw.jobs[1].compensation.compensationTiers[0].components.reverse();
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[1].id}`,
      );
      expect(job?.compensation?.minAmount).toBe(211400);
      expect(job?.compensation?.maxAmount).toBe(290600);
    });

    it('keeps compensation null when the payload has none', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[2].id}`,
      );
      expect(job).toBeDefined();
      expect(job?.compensation ?? null).toBeNull();
    });

    it('falls back to the description salary when structured comp is absent (Spec 5018)', async () => {
      const raw = clone(BOARD_RAW) as any;
      raw.jobs[2].descriptionPlain =
        'Compensation: $120,000 - $160,000 per year plus benefits.';
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[2].id}`,
      );
      expect(job?.compensation?.minAmount).toBe(120000);
      expect(job?.compensation?.maxAmount).toBe(160000);
      expect(job?.compensation?.currency).toBe('USD');
    });

    it('folds many tiers into the overall min-max envelope (Spec 5019)', async () => {
      const raw = clone(BOARD_RAW) as any;
      // SF / NYC / remote bands on the same base-salary component.
      raw.jobs[0].compensation.compensationComponents[0].tiers = [
        { title: 'SF', tierFloor: 180000, tierCeiling: 220000, currency: 'USD', tierType: 'salary', interval: 'YEAR' },
        { title: 'NYC', tierFloor: 170000, tierCeiling: 210000, currency: 'USD', tierType: 'salary', interval: 'YEAR' },
        { title: 'Remote', tierFloor: 150000, tierCeiling: 190000, currency: 'USD', tierType: 'salary', interval: 'YEAR' },
      ];
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.compensation?.minAmount).toBe(150000);
      expect(job?.compensation?.maxAmount).toBe(220000);
      expect(job?.compensation?.currency).toBe('USD');
      expect(job?.compensation?.interval).toBe(CompensationInterval.YEARLY);
    });

    it('folds many flat salary bands into the overall min-max envelope (Spec 5019)', async () => {
      const raw = clone(BOARD_RAW) as any;
      // Multiple per-location salary bands plus an equity row that must stay out.
      raw.jobs[1].compensation.summaryComponents = [
        { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 200000, maxValue: 260000 },
        { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 180000, maxValue: 240000 },
        { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 160000, maxValue: 300000 },
        { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
      ];
      raw.jobs[1].compensation.compensationTiers = [];
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[1].id}`,
      );
      expect(job?.compensation?.minAmount).toBe(160000);
      expect(job?.compensation?.maxAmount).toBe(300000);
      expect(job?.compensation?.currency).toBe('USD');
      expect(job?.compensation?.interval).toBe(CompensationInterval.YEARLY);
    });

    it('prefers structured comp over a description salary (Spec 5018)', async () => {
      const raw = clone(BOARD_RAW) as any;
      raw.jobs[0].descriptionPlain =
        'Body says $10,000 - $20,000 per year but structured wins.';
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.compensation?.minAmount).toBe(150000);
      expect(job?.compensation?.maxAmount).toBe(190000);
    });
  });

  /**
   * Spec 5008 — the public job-board API and the authenticated Posting API use
   * different names for the same fields. The plugin must read both, preferring
   * the public name.
   */
  describe('field-name fallbacks (Spec 5008)', () => {
    it('maps the authenticated-API field names (departmentName/teamName/publishedDate)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });
      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (j) => j.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.department).toBe('Engineering');
      expect(job?.team).toBe('Platform');
      expect(job?.datePosted).toBe('2026-05-20');
    });

    it('maps the public job-board field names (department/team/publishedAt)', async () => {
      const raw = clone(BOARD_RAW) as any;
      const j = raw.jobs[0];
      delete j.departmentName;
      delete j.teamName;
      delete j.publishedDate;
      j.department = 'Hardware';
      j.team = 'Avionics';
      j.publishedAt = '2026-06-04T22:28:52.477+00:00';
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (jb) => jb.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.department).toBe('Hardware');
      expect(job?.team).toBe('Avionics');
      // publishedAt is an ISO timestamp; datePosted is the date part only.
      expect(job?.datePosted).toBe('2026-06-04');
    });

    it('prefers the public names when both are present', async () => {
      const raw = clone(BOARD_RAW) as any;
      const j = raw.jobs[0];
      j.department = 'Hardware';
      j.team = 'Avionics';
      j.publishedAt = '2026-06-04T00:00:00.000+00:00';
      // Authenticated-name values remain but must lose to the public ones.
      j.departmentName = 'Engineering';
      j.teamName = 'Platform';
      j.publishedDate = '2026-05-20';
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      const job = result.jobs.find(
        (jb) => jb.id === `ashby-${BOARD_RAW.jobs[0].id}`,
      );
      expect(job?.department).toBe('Hardware');
      expect(job?.team).toBe('Avionics');
      expect(job?.datePosted).toBe('2026-06-04');
    });
  });

  describe('retry resilience (public GET)', () => {
    it('retries after a timeout and returns jobs on the second attempt', async () => {
      mockGet
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce({ data: clone(BOARD_RAW) });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(3);
    });

    it('retries on HTTP 5xx', async () => {
      mockGet
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValueOnce({ data: clone(BOARD_RAW) });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(3);
    });

    it('does not retry on HTTP 404 — single call, empty result', async () => {
      mockGet.mockRejectedValueOnce(httpError(404));

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs).toEqual([]);
    });

    it('gives up after max retries and returns empty without throwing', async () => {
      mockGet.mockRejectedValue(timeoutError());

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
      } as ScraperInputDto);

      expect(mockGet).toHaveBeenCalledTimes(ASHBY_PUBLIC_MAX_RETRIES + 1);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('guard rails', () => {
    it('returns empty when no companySlug is provided', async () => {
      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('falls back to the public path when the authenticated POST fails', async () => {
      mockPost.mockRejectedValueOnce(httpError(401));
      mockGet.mockResolvedValueOnce({ data: clone(BOARD_RAW) });

      const service = new AshbyService();
      const result = await service.scrape({
        siteType: [Site.ASHBY],
        companySlug: SLUG,
        auth: { ashby: { apiKey: 'bad-key' } },
      } as ScraperInputDto);

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs).toHaveLength(3);
    });
  });
});
