import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

/**
 * Mock the `@ever-jobs/common.createHttpClient` factory so the service
 * hits a controlled test pipeline instead of the live Tesla host. Same
 * pattern as Oracle T04 / Mercor T05.
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
  TESLA_BASE_URL,
  TESLA_BOARD_PATH,
  TESLA_DEFAULT_DESCRIPTION_DEPTH,
  TESLA_DESCRIPTION_BUDGET,
  TESLA_HEADERS,
  TeslaBoardResponse,
  TeslaJobDetail,
  TeslaModule,
  TeslaService,
} from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const BOARD_FIXTURE: TeslaBoardResponse = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tesla-board.json'), 'utf8'),
);
const DETAIL_200001: TeslaJobDetail = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tesla-job-200001.json'), 'utf8'),
);
const DETAIL_200002: TeslaJobDetail = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tesla-job-200002.json'), 'utf8'),
);
const DETAIL_200003: TeslaJobDetail = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tesla-job-200003.json'), 'utf8'),
);
const DETAIL_MISSING: TeslaJobDetail = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tesla-job-missing.json'), 'utf8'),
);

const BOARD_LISTING_COUNT = 50;

/**
 * Spec 013 / T07 + T08 — `TeslaService` registration smoke + full
 * behavioural sweep.
 *
 * T07 cases (carry-over from run #50 — registration / wire-format /
 * envelope-guard / Akamai-guard / HTTP-failure):
 *   1. Registration — DI resolves TeslaService via TeslaModule.
 *   2. Site enum literal-string assertion (`Site.TESLA === 'tesla'`).
 *   3. Description-budget map exposes the documented three keys
 *      (board=0, detail-25=25, detail-all=Infinity).
 *   4. Wire-format pin — board GET hits
 *      `${TESLA_BASE_URL}${TESLA_BOARD_PATH}` with `TESLA_HEADERS`.
 *   5. Akamai 403 sentinel — board GET rejecting with HTTP 403 ⇒
 *      empty JobResponseDto + ERR_TESLA_AKAMAI_CHALLENGE logged.
 *   6. HTML body Akamai surface — board GET resolving with a string
 *      payload ⇒ empty JobResponseDto + ERR_TESLA_AKAMAI_CHALLENGE.
 *   7. Non-Akamai HTTP 500 — board GET rejecting with HTTP 500 ⇒
 *      empty JobResponseDto + ERR_TESLA_FETCH_FAILED logged.
 *
 * T08 cases (this run, ≥ 6 per tasks.md acceptance line):
 *   8. Happy path with detail fetches — 50-listing board capped to
 *      first 5 via `resultsWanted: 5`. Listings 200001..200003 get
 *      populated detail envelopes (full-4 / partial-2 / single-1
 *      fields respectively); listing 200004's detail returns the
 *      missing-all-four envelope so composeDescription resolves to
 *      null; listing 200005's detail GET rejects with 404 so
 *      fetchDetail silently swallows and returns null. Asserts
 *      first 3 have `description !== null` and remainder
 *      `description === null` per the spec acceptance line, plus
 *      first-row mapping (id / title / companyName / atsId / atsType /
 *      site / location / isRemote / department / jobUrl) and the
 *      remote-detection / lookup.locations-resolution branches on
 *      listing 200002 (`Remote, United States`).
 *   9. Empty listings[] — board returns `{listings:[], lookup:{}}`
 *      ⇒ empty JobResponseDto, NO detail fetches issued.
 *  10. HTTP 500 (T08-flavoured) — board rejecting with HTTP 500 ⇒
 *      empty JobResponseDto, NO detail fetches issued (same code
 *      path as case 7 but documents the no-detail-fetch invariant).
 *  11. Akamai 503 sentinel — board rejecting with HTTP 503 ⇒
 *      empty JobResponseDto + ERR_TESLA_AKAMAI_CHALLENGE; NO
 *      detail fetches issued.
 *  12. resultsWanted cap pre-detail-fetch — 50-listing board with
 *      `resultsWanted: 2` ⇒ exactly 2 JobPostDto rows AND exactly
 *      2 detail GETs (1 board + 2 details = 3 total mockGet calls).
 *      Pins the cap is applied to `listings[]` BEFORE the detail
 *      loop runs (per FR-11 / TeslaService.scrape `slice(0, resultsWanted)`).
 *  13. descriptionDepth='board' skips details entirely — budget=0
 *      path means every job emits with `description === null` and
 *      mockGet is called exactly once (board only). Pins the
 *      board-only operating mode for operators who want catalogue
 *      latency without per-job follow-ups.
 *  14. Lookup-key null fallbacks — listing 200049 has `d: null` so
 *      `department === null`; listing 200050 has `l: null` so
 *      `location === null` AND `isRemote === false`. Pins the
 *      missing-`l` / missing-`d` defensive paths in `toJobPost()`.
 */
describe('TeslaService (Spec 013 / T07 + T08 — pure-HTTP board + detail)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  // ────────────── T07 carry-over: registration + smoke ──────────────

  it('resolves through TeslaModule via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TeslaModule],
    }).compile();

    const service = moduleRef.get(TeslaService);
    expect(service).toBeInstanceOf(TeslaService);
    await moduleRef.close();
  });

  it('exports the Site.TESLA = "tesla" enum value', () => {
    expect(Site.TESLA).toBe('tesla');
  });

  it('exports the documented descriptionDepth budget map (board=0, detail-25=25, detail-all=Infinity)', () => {
    expect(TESLA_DEFAULT_DESCRIPTION_DEPTH).toBe('detail-25');
    expect(TESLA_DESCRIPTION_BUDGET.board).toBe(0);
    expect(TESLA_DESCRIPTION_BUDGET['detail-25']).toBe(25);
    expect(TESLA_DESCRIPTION_BUDGET['detail-all']).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('issues a board GET to `${TESLA_BASE_URL}${TESLA_BOARD_PATH}` with the documented headers', async () => {
    mockGet.mockResolvedValueOnce({
      data: { listings: [], lookup: {} },
    });

    const service = new TeslaService();
    const input: ScraperInputDto = {
      siteType: [Site.TESLA],
    } as ScraperInputDto;

    await service.scrape(input);

    expect(mockGet).toHaveBeenCalledWith(`${TESLA_BASE_URL}${TESLA_BOARD_PATH}`);
    expect(mockSetHeaders).toHaveBeenCalledWith(TESLA_HEADERS);
  });

  it('returns empty JobResponseDto when board responds with HTTP 403 (ERR_TESLA_AKAMAI_CHALLENGE)', async () => {
    mockGet.mockRejectedValueOnce({
      message: 'Request failed with status 403',
      response: { status: 403 },
    });

    const service = new TeslaService();
    const input: ScraperInputDto = {
      siteType: [Site.TESLA],
    } as ScraperInputDto;

    const result = await service.scrape(input);
    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toEqual([]);
  });

  it('returns empty JobResponseDto when board responds with HTML body (Akamai challenge surface)', async () => {
    mockGet.mockResolvedValueOnce({
      data: '<!DOCTYPE html><html><body>Pardon Our Interruption</body></html>',
    });

    const service = new TeslaService();
    const input: ScraperInputDto = {
      siteType: [Site.TESLA],
    } as ScraperInputDto;

    const result = await service.scrape(input);
    expect(result.jobs).toEqual([]);
  });

  it('returns empty JobResponseDto on non-Akamai HTTP failure (ERR_TESLA_FETCH_FAILED)', async () => {
    mockGet.mockRejectedValueOnce({
      message: 'Request failed with status 500',
      response: { status: 500 },
    });

    const service = new TeslaService();
    const input: ScraperInputDto = {
      siteType: [Site.TESLA],
    } as ScraperInputDto;

    const result = await service.scrape(input);
    expect(result.jobs).toEqual([]);
  });

  // ────────────── T08 behavioural sweep ──────────────

  describe('happy path — detail fetches with mixed populated / null branches', () => {
    it('emits 5 jobs; first 3 have `description !== null`, remainder `description === null`; mapping pinned on first row + remote row', async () => {
      mockGet
        .mockResolvedValueOnce({ data: BOARD_FIXTURE })
        .mockResolvedValueOnce({ data: DETAIL_200001 })
        .mockResolvedValueOnce({ data: DETAIL_200002 })
        .mockResolvedValueOnce({ data: DETAIL_200003 })
        .mockResolvedValueOnce({ data: DETAIL_MISSING })
        .mockRejectedValueOnce({
          message: 'Request failed with status 404',
          response: { status: 404 },
        });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
        resultsWanted: 5,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toHaveLength(5);

      // 1 board + 5 detail GETs.
      expect(mockGet).toHaveBeenCalledTimes(6);
      expect(mockGet).toHaveBeenNthCalledWith(
        1,
        `${TESLA_BASE_URL}${TESLA_BOARD_PATH}`,
      );
      expect(mockGet).toHaveBeenNthCalledWith(
        2,
        `${TESLA_BASE_URL}/cua-api/careers/job/200001`,
      );
      expect(mockGet).toHaveBeenNthCalledWith(
        6,
        `${TESLA_BASE_URL}/cua-api/careers/job/200005`,
      );

      // First-row mapping pin (listing 200001).
      const first = result.jobs[0];
      expect(first.id).toBe('tesla-200001');
      expect(first.title).toBe('Senior Software Engineer, Vehicle Firmware');
      expect(first.companyName).toBe('Tesla');
      expect(first.atsId).toBe('200001');
      expect(first.atsType).toBe('tesla');
      expect(first.site).toBe(Site.TESLA);
      expect(first.location?.city).toBe('Palo Alto');
      expect(first.isRemote).toBe(false);
      expect(first.department).toBe('Software & IT');
      expect(first.jobUrl).toBe(
        `${TESLA_BASE_URL}/careers/search/job/senior-software-engineer-vehicle-firmware-200001`,
      );

      // Remote-detection branch on listing 200002 (`Remote, United States`).
      const second = result.jobs[1];
      expect(second.location?.city).toBeUndefined();
      expect(second.isRemote).toBe(true);
      expect(second.department).toBe('Software & IT');

      // First 3 have non-null composed descriptions.
      expect(first.description).not.toBeNull();
      expect(first.description).toContain('Description:');
      expect(first.description).toContain('Responsibilities:');
      expect(first.description).toContain('Requirements:');
      expect(first.description).toContain('Compensation & Benefits:');

      expect(second.description).not.toBeNull();
      expect(second.description).toContain('Description:');
      expect(second.description).toContain('Responsibilities:');
      // Listing 200002 detail omits Requirements + Compensation entirely.
      expect(second.description).not.toContain('Requirements:');
      expect(second.description).not.toContain('Compensation & Benefits:');

      const third = result.jobs[2];
      expect(third.description).not.toBeNull();
      expect(third.description).toContain('Compensation & Benefits:');
      // Listing 200003 detail omits the other three fields entirely.
      expect(third.description).not.toContain('Description:');
      expect(third.description).not.toContain('Responsibilities:');
      expect(third.description).not.toContain('Requirements:');

      // Remainder (4th + 5th) have description === null.
      // 4th: missing-all-four envelope ⇒ composeDescription returns null.
      // 5th: HTTP 404 silently swallowed ⇒ fetchDetail returns null.
      expect(result.jobs[3].description).toBeNull();
      expect(result.jobs[4].description).toBeNull();
    });
  });

  describe('empty listings[] — no detail fetches issued', () => {
    it('returns empty JobResponseDto and skips the detail loop entirely', async () => {
      mockGet.mockResolvedValueOnce({
        data: { listings: [], lookup: {} },
      });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-Akamai HTTP 500 (T08-flavoured) — no detail fetches issued', () => {
    it('emits empty JobResponseDto and never enters the detail loop', async () => {
      mockGet.mockRejectedValueOnce({
        message: 'Request failed with status 500',
        response: { status: 500 },
      });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
        resultsWanted: 25,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toEqual([]);
      // Only the board GET fires; the detail loop never runs.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('Akamai 503 sentinel — no detail fetches issued', () => {
    it('emits empty JobResponseDto and the detail loop never runs', async () => {
      mockGet.mockRejectedValueOnce({
        message: 'Request failed with status 503',
        response: { status: 503 },
      });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
        resultsWanted: 25,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toEqual([]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('resultsWanted cap pre-detail-fetch (FR-11)', () => {
    it('caps the 50-listing board to 2 jobs AND issues only 2 detail GETs (1 board + 2 details = 3 total)', async () => {
      mockGet
        .mockResolvedValueOnce({ data: BOARD_FIXTURE })
        .mockResolvedValueOnce({ data: DETAIL_200001 })
        .mockResolvedValueOnce({ data: DETAIL_200002 });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
        resultsWanted: 2,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(2);
      // Sanity: fixture has 50 listings — the cap is what trimmed it to 2.
      expect(BOARD_FIXTURE.listings?.length).toBe(BOARD_LISTING_COUNT);
      // 1 board + 2 details = 3 total mockGet calls.
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(result.jobs[0].id).toBe('tesla-200001');
      expect(result.jobs[1].id).toBe('tesla-200002');
    });
  });

  describe("descriptionDepth='board' — budget=0 skips detail loop", () => {
    it('emits all 5 jobs with `description === null` and issues exactly one GET (board only)', async () => {
      mockGet.mockResolvedValueOnce({ data: BOARD_FIXTURE });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
        descriptionDepth: 'board',
        resultsWanted: 5,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(5);
      expect(result.jobs.every((j) => j.description === null)).toBe(true);
      // Board GET only; budget=0 ⇒ detail loop entry never executes a fetch.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('lookup-key null fallbacks (toJobPost defensive paths)', () => {
    it('emits department === null when listing.d is null and location === null + isRemote === false when listing.l is null', async () => {
      mockGet.mockResolvedValueOnce({ data: BOARD_FIXTURE });

      const service = new TeslaService();
      const input: ScraperInputDto = {
        siteType: [Site.TESLA],
        descriptionDepth: 'board',
        resultsWanted: 50,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(BOARD_LISTING_COUNT);

      // Listing 200049 has `d: null` ⇒ department === null but location resolves.
      const noDeptRow = result.jobs.find((j) => j.id === 'tesla-200049');
      expect(noDeptRow).toBeDefined();
      expect(noDeptRow?.department).toBeNull();
      expect(noDeptRow?.location?.city).toBe('Palo Alto');
      expect(noDeptRow?.isRemote).toBe(false);

      // Listing 200050 has `l: null` ⇒ location === null AND isRemote === false.
      const noLocRow = result.jobs.find((j) => j.id === 'tesla-200050');
      expect(noLocRow).toBeDefined();
      expect(noLocRow?.location).toBeNull();
      expect(noLocRow?.isRemote).toBe(false);
      // department resolves normally even when location does not.
      expect(noLocRow?.department).toBe('Engineering');
    });
  });
});
