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

/**
 * Mock the `@ever-jobs/common.createHttpClient` factory so the service
 * hits a controlled test pipeline instead of the live
 * `aws.api.mercor.com` host. Same pattern as Oracle T04
 * (`packages/plugins/source-ats-oracle/__tests__/oracle.service.spec.ts`).
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
  MERCOR_API_BASE_URL,
  MERCOR_EXPLORE_PATH,
  MERCOR_HEADERS,
  MERCOR_PUBLIC_ORIGIN,
  MercorListingsResponse,
  MercorModule,
  MercorService,
} from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FULL_CATALOGUE: MercorListingsResponse = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'mercor-explore.json'), 'utf8'),
);
const FULL_CATALOGUE_LISTING_COUNT = 50;
const STRIPE_LISTING_COUNT = 8;

/**
 * Spec 013 / T05 + T06 — `MercorService` registration smoke + full
 * behavioural sweep.
 *
 * T05 cases (carry-over from run #48 — registration / wire-format /
 * envelope-guard / HTTP-failure):
 *   1. Registration — DI resolves MercorService via MercorModule.
 *   2. Site enum literal-string assertion (`Site.MERCOR === 'mercor'`).
 *   3. Single GET wire-format pin — URL = MERCOR_API_BASE_URL +
 *      MERCOR_EXPLORE_PATH + headers include literal `Authorization: Bearer`.
 *   4. Envelope guard — response missing `listings[]` ⇒ empty
 *      JobResponseDto + ERR_MERCOR_ENVELOPE logged.
 *   5. HTTP failure — caught ⇒ empty JobResponseDto + ERR_MERCOR_FETCH_FAILED
 *      logged.
 *
 * T06 cases (this run, ≥ 5 per tasks.md acceptance line):
 *   6. Happy path with full catalogue — 50 listings → 50 JobPostDto rows,
 *      first-row mapping checked (id / title / companyName / atsId /
 *      atsType / site / location / isRemote / datePosted / jobUrl /
 *      compensation interval+bounds).
 *   7. Slug post-filter narrows result — `companySlug='stripe'` against
 *      the same 50-listing corpus returns 8 rows (every Stripe row),
 *      no row whose companyName lacks "stripe" leaks through.
 *   8. Empty `listings[]` — response with `listings: []` returns an
 *      empty JobResponseDto without warning (not an envelope error —
 *      the array is present, just empty).
 *   9. resultsWanted cap mid-catalogue — `companySlug='stripe',
 *      resultsWanted=3` against the same corpus returns the FIRST 3
 *      Stripe rows, demonstrating that the cap is applied AFTER the
 *      slug post-filter (FR-7).
 *  10. Compensation null branch — listing whose rateMin/rateMax are
 *      both null surfaces `compensation === null`.
 *  11. Slug post-filter is case-insensitive — `companySlug='STRIPE'`
 *      (upper-case) returns the same 8 Stripe rows.
 */
describe('MercorService (Spec 013 / T05 + T06 — single-GET explore-page)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  // ────────────── T05 carry-over: registration + wire-format ──────────────

  it('resolves through MercorModule via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MercorModule],
    }).compile();

    const service = moduleRef.get(MercorService);
    expect(service).toBeInstanceOf(MercorService);
    await moduleRef.close();
  });

  it('exports the Site.MERCOR = "mercor" enum value', () => {
    expect(Site.MERCOR).toBe('mercor');
  });

  it('issues a single GET to `${MERCOR_API_BASE_URL}${MERCOR_EXPLORE_PATH}` with the documented headers', async () => {
    mockGet.mockResolvedValueOnce({ data: { listings: [] } });

    const service = new MercorService();
    const input: ScraperInputDto = {
      siteType: [Site.MERCOR],
    } as ScraperInputDto;

    await service.scrape(input);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      `${MERCOR_API_BASE_URL}${MERCOR_EXPLORE_PATH}`,
    );
    expect(mockSetHeaders).toHaveBeenCalledWith(MERCOR_HEADERS);
    expect(MERCOR_HEADERS.Authorization).toBe('Bearer');
  });

  it('returns empty JobResponseDto when response lacks listings[] (ERR_MERCOR_ENVELOPE)', async () => {
    mockGet.mockResolvedValueOnce({ data: {} });

    const service = new MercorService();
    const input: ScraperInputDto = {
      siteType: [Site.MERCOR],
    } as ScraperInputDto;

    const result = await service.scrape(input);
    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toEqual([]);
  });

  it('returns empty JobResponseDto on HTTP failure (never throws)', async () => {
    mockGet.mockRejectedValueOnce({
      message: 'Request failed with status 500',
      response: { status: 500 },
    });

    const service = new MercorService();
    const input: ScraperInputDto = {
      siteType: [Site.MERCOR],
    } as ScraperInputDto;

    const result = await service.scrape(input);
    expect(result.jobs).toEqual([]);
  });

  // ────────────── T06 behavioural sweep ──────────────

  describe('happy path — full catalogue mapping', () => {
    it('parses all 50 fixture listings into JobPostDto rows with correct mapping', async () => {
      mockGet.mockResolvedValueOnce({ data: FULL_CATALOGUE });

      const service = new MercorService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCOR],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toHaveLength(FULL_CATALOGUE_LISTING_COUNT);

      const first = result.jobs[0];
      expect(first.id).toBe('mercor-1001');
      expect(first.title).toBe('Senior Backend Engineer');
      expect(first.companyName).toBe('Stripe');
      expect(first.atsId).toBe('1001');
      expect(first.atsType).toBe('mercor');
      expect(first.site).toBe(Site.MERCOR);
      expect(first.location?.city).toBe('San Francisco');
      expect(first.isRemote).toBe(false);
      expect(first.datePosted).toBe('2026-04-20');
      expect(first.jobUrl).toBe(
        `${MERCOR_PUBLIC_ORIGIN}/jobs/1001/senior-backend-engineer`,
      );
      expect(first.compensation?.interval).toBe(CompensationInterval.YEARLY);
      expect(first.compensation?.minAmount).toBe(180000);
      expect(first.compensation?.maxAmount).toBe(240000);
      expect(first.compensation?.currency).toBe('USD');

      // Remote-detection check on listing #2 (`Remote, US`).
      const remoteRow = result.jobs.find((j) => j.id === 'mercor-1002');
      expect(remoteRow?.isRemote).toBe(true);

      // Hourly-interval check on the Coinbase compliance contractor.
      const hourlyRow = result.jobs.find((j) => j.id === 'mercor-1044');
      expect(hourlyRow?.compensation?.interval).toBe(
        CompensationInterval.HOURLY,
      );
      expect(hourlyRow?.compensation?.minAmount).toBe(95);

      // Monthly-interval check on the Airbnb London brand-marketing lead.
      const monthlyRow = result.jobs.find((j) => j.id === 'mercor-1026');
      expect(monthlyRow?.compensation?.interval).toBe(
        CompensationInterval.MONTHLY,
      );
    });
  });

  describe('slug post-filter narrows result (FR-7)', () => {
    it('returns only rows whose companyName contains the slug (case-insensitive)', async () => {
      mockGet.mockResolvedValueOnce({ data: FULL_CATALOGUE });

      const service = new MercorService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCOR],
        companySlug: 'stripe',
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(STRIPE_LISTING_COUNT);
      for (const j of result.jobs) {
        expect(j.companyName?.toLowerCase()).toContain('stripe');
      }
    });

    it('matches case-insensitively when the slug is upper-case', async () => {
      mockGet.mockResolvedValueOnce({ data: FULL_CATALOGUE });

      const service = new MercorService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCOR],
        companySlug: 'STRIPE',
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(STRIPE_LISTING_COUNT);
    });
  });

  describe('empty listings[]', () => {
    it('returns an empty JobResponseDto when the array is present but empty', async () => {
      mockGet.mockResolvedValueOnce({ data: { listings: [] } });

      const service = new MercorService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCOR],
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
      // Single GET; no envelope-error path triggered (array is present).
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('resultsWanted cap mid-catalogue (FR-7 — cap applied AFTER post-filter)', () => {
    it('caps Stripe slice to the first 3 rows, not 3 of the full 50', async () => {
      mockGet.mockResolvedValueOnce({ data: FULL_CATALOGUE });

      const service = new MercorService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCOR],
        companySlug: 'stripe',
        resultsWanted: 3,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      // The cap fires AFTER the slug post-filter, so we get 3 Stripe
      // rows — NOT 3 rows from the full catalogue (which would be 0
      // Stripe rows and 3 unrelated companies).
      expect(result.jobs).toHaveLength(3);
      for (const j of result.jobs) {
        expect(j.companyName).toBe('Stripe');
      }
      // First three Stripe listings in fixture order.
      expect(result.jobs.map((j) => j.id)).toEqual([
        'mercor-1001',
        'mercor-1002',
        'mercor-1003',
      ]);
    });
  });

  describe('compensation null branch', () => {
    it('surfaces compensation === null when both rateMin and rateMax are null', async () => {
      mockGet.mockResolvedValueOnce({ data: FULL_CATALOGUE });

      const service = new MercorService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCOR],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      // Notion's customer-success listing (1021) has null comp fields.
      const noCompRow = result.jobs.find((j) => j.id === 'mercor-1021');
      expect(noCompRow).toBeDefined();
      expect(noCompRow?.compensation).toBeNull();

      // Figma's DevRel listing (1030) also has null comp fields.
      const figmaNoCompRow = result.jobs.find((j) => j.id === 'mercor-1030');
      expect(figmaNoCompRow?.compensation).toBeNull();
    });
  });
});
