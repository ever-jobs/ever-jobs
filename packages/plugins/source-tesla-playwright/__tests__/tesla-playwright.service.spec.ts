import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';
import {
  TESLA_PLAYWRIGHT_BASE_URL,
  TESLA_PLAYWRIGHT_BOARD_PATH,
  TESLA_PLAYWRIGHT_CAREERS_PAGE,
  TESLA_PLAYWRIGHT_DEFAULT_DESCRIPTION_DEPTH,
  TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET,
  TESLA_PLAYWRIGHT_GOTO_TIMEOUT_MS,
  TESLA_PLAYWRIGHT_LAUNCH_ARGS,
  TeslaPlaywrightBoardResponse,
  TeslaPlaywrightJobDetail,
  TeslaPlaywrightModule,
  TeslaPlaywrightService,
} from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const BOARD_FIXTURE: TeslaPlaywrightBoardResponse = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tesla-playwright-board.json'), 'utf8'),
);
const DETAIL_FULL: TeslaPlaywrightJobDetail = JSON.parse(
  fs.readFileSync(
    path.join(FIXTURE_DIR, 'tesla-playwright-job-300001.json'),
    'utf8',
  ),
);
const DETAIL_PARTIAL: TeslaPlaywrightJobDetail = JSON.parse(
  fs.readFileSync(
    path.join(FIXTURE_DIR, 'tesla-playwright-job-300002.json'),
    'utf8',
  ),
);
const DETAIL_SINGLE: TeslaPlaywrightJobDetail = JSON.parse(
  fs.readFileSync(
    path.join(FIXTURE_DIR, 'tesla-playwright-job-300003.json'),
    'utf8',
  ),
);
const DETAIL_MISSING: TeslaPlaywrightJobDetail = JSON.parse(
  fs.readFileSync(
    path.join(FIXTURE_DIR, 'tesla-playwright-job-missing.json'),
    'utf8',
  ),
);

const BOARD_LISTING_COUNT = 10;

/**
 * Build a freshly-stubbed `playwright` module shape — `chromium.launch`
 * yielding a fake browser whose `newPage()` returns a fake page. Tests
 * inject this module into `TeslaPlaywrightService.loadPlaywright()` via
 * `jest.spyOn(service as any, 'loadPlaywright')` so the real
 * `Function('s','return import(s)')('playwright')` indirection is
 * bypassed cleanly without paying the ts-jest static-resolution
 * friction the production service is designed to avoid.
 *
 * Why bypass `loadPlaywright` instead of `jest.mock('playwright', …,
 * { virtual: true })`? The service deliberately uses the
 * `Function('s','return import(s)')(specifier)` trick to defeat
 * ts-jest's compile-time module resolution (so an operator without
 * `playwright` installed still gets a clean compile + runtime sentinel
 * rather than a build error). That same trick ALSO defeats Jest's
 * module-mocking system, which intercepts at the require/import call
 * site — Function-wrapped imports run in a fresh global scope outside
 * Jest's instrumented loader. Spying on the lazy-loader method itself
 * (one boundary closer to where the module is consumed) gives us full
 * control without fighting the indirection.
 */
function buildStubbedPlaywright(opts: {
  goto?: jest.Mock;
  evaluate?: jest.Mock;
  newPage?: jest.Mock;
  close?: jest.Mock;
  launch?: jest.Mock;
}): {
  module: { chromium: { launch: jest.Mock } };
  goto: jest.Mock;
  evaluate: jest.Mock;
  newPage: jest.Mock;
  close: jest.Mock;
  launch: jest.Mock;
} {
  const goto = opts.goto ?? jest.fn().mockResolvedValue(undefined);
  const evaluate = opts.evaluate ?? jest.fn();
  const close = opts.close ?? jest.fn().mockResolvedValue(undefined);
  const page = { goto, evaluate };
  const browser = {
    newPage: opts.newPage ?? jest.fn().mockResolvedValue(page),
    close,
  };
  const launch = opts.launch ?? jest.fn().mockResolvedValue(browser);
  return {
    module: { chromium: { launch } },
    goto,
    evaluate,
    newPage: browser.newPage as jest.Mock,
    close,
    launch,
  };
}

/**
 * Build a `TeslaPlaywrightService` instance whose `loadPlaywright()`
 * returns the supplied stub module AND whose `sleep()` is a no-op
 * (so the 5 s settle window doesn't slow tests down). Returns the
 * service plus the stub harness for assertions.
 */
function buildServiceWithStub(opts: Parameters<typeof buildStubbedPlaywright>[0] = {}): {
  service: TeslaPlaywrightService;
  stub: ReturnType<typeof buildStubbedPlaywright>;
} {
  const stub = buildStubbedPlaywright(opts);
  const service = new TeslaPlaywrightService();
  jest.spyOn(service as unknown as { loadPlaywright: () => Promise<unknown> }, 'loadPlaywright')
    .mockResolvedValue(stub.module);
  jest.spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
    .mockResolvedValue(undefined);
  return { service, stub };
}

/**
 * Spec 013 / T09 + T10 — `TeslaPlaywrightService` registration smoke +
 * full behavioural sweep against the stubbed Playwright surface.
 *
 * T09 cases (carry-over from run #52 — registration + missing-dep
 * sentinel + constants pinning):
 *   1. Registration — DI resolves TeslaPlaywrightService via
 *      TeslaPlaywrightModule (opt-in import path; module is NOT in
 *      `ALL_SOURCE_MODULES`).
 *   2. Site enum literal-string assertion (`Site.TESLA_PLAYWRIGHT ===
 *      'tesla_playwright'`).
 *   3. Description-budget map exposes the documented three keys
 *      (board=0, detail-25=25, detail-all=Infinity) AND default key
 *      is `'detail-25'`.
 *   4. `TESLA_PLAYWRIGHT_LAUNCH_ARGS` exports the
 *      `--disable-blink-features=AutomationControlled` flag (the
 *      load-bearing one for Akamai bypass).
 *   5. Missing-`playwright` real-failure path — exercises the genuine
 *      `Function('s','return import(s)')('playwright')` lazy import
 *      against the workspace's actual dependency graph (which does NOT
 *      declare `playwright`), so `ERR_MODULE_NOT_FOUND` surfaces and
 *      the service returns an empty `JobResponseDto`. NO mocking — the
 *      most load-bearing branch in the whole package.
 *
 * T10 cases (this run, ≥ 4 per tasks.md acceptance line):
 *   6. **Happy path with stubbed `playwright` module.** 10-listing
 *      board capped to first 5 via `resultsWanted: 5`. Listings
 *      300001..300003 get populated detail envelopes (full-4 /
 *      partial-2 / single-1 fields respectively); listing 300004's
 *      detail returns the missing-all-four envelope so
 *      composeDescription resolves to null; listing 300005's
 *      `page.evaluate` returns null (simulates the in-page fetch
 *      returning a non-JSON / HTTP-failure surface). Asserts: 5
 *      JobPostDto rows, first 3 have `description !== null`, last
 *      2 have `description === null`. First-row mapping pin (id /
 *      title / companyName / atsId / atsType / site=TESLA_PLAYWRIGHT
 *      per Q-032 / location / isRemote / department / jobUrl) plus
 *      remote-detection branch on listing 300002 (`Remote, United
 *      States`). Asserts `browser.close()` invoked exactly once
 *      (finally-block contract).
 *   7. **Akamai bypass succeeds — wire-format pin.** Asserts
 *      `chromium.launch` invoked with `headless: true` AND `args[]`
 *      containing the anti-automation flag (the load-bearing flag
 *      for Akamai's bot detection). Asserts `page.goto` invoked with
 *      the careers-search URL AND `{ waitUntil: 'networkidle',
 *      timeout: 60000 }` matching upstream Python's settings.
 *      Asserts in-page board fetch URL is exactly
 *      `${TESLA_PLAYWRIGHT_BASE_URL}${TESLA_PLAYWRIGHT_BOARD_PATH}`.
 *   8. **Page navigation timeout.** `page.goto` rejects with a
 *      Playwright-shape `TimeoutError`. Asserts: empty
 *      JobResponseDto, NO in-page fetches issued (the detail loop
 *      never runs because the navigation guard short-circuits
 *      before the board fetch), browser still closed in `finally`.
 *      Pins the `ERR_TESLA_PLAYWRIGHT_NAV_FAILED` code path.
 *   9. **descriptionDepth='board' — budget=0 skips detail loop.**
 *      Issues exactly one in-page `evaluate()` call (board only);
 *      every emitted job has `description === null`; mirrors the
 *      default `source-tesla` plugin's analogous case 13 in T08.
 *  10. **resultsWanted cap pre-detail-fetch (FR-11).** 10-listing
 *      board capped to 2 jobs; exactly 1 board fetch + 2 detail
 *      fetches = 3 total `page.evaluate()` calls; result has
 *      exactly 2 jobs in board order. Mirrors source-tesla T08's
 *      analogous case 12.
 */
describe('TeslaPlaywrightService (Spec 013 / T09 + T10 — opt-in lazy-Playwright)', () => {
  // ────────────── T09 carry-over: registration + smoke ──────────────

  it('resolves through TeslaPlaywrightModule via NestJS DI (opt-in import path)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TeslaPlaywrightModule],
    }).compile();

    const service = moduleRef.get(TeslaPlaywrightService);
    expect(service).toBeInstanceOf(TeslaPlaywrightService);
    await moduleRef.close();
  });

  it('exports the Site.TESLA_PLAYWRIGHT = "tesla_playwright" enum value', () => {
    expect(Site.TESLA_PLAYWRIGHT).toBe('tesla_playwright');
  });

  it('exports the descriptionDepth budget map matching the default source-tesla plugin', () => {
    expect(TESLA_PLAYWRIGHT_DEFAULT_DESCRIPTION_DEPTH).toBe('detail-25');
    expect(TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET.board).toBe(0);
    expect(TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET['detail-25']).toBe(25);
    expect(TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET['detail-all']).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('exports the documented anti-automation Chromium flag', () => {
    expect(TESLA_PLAYWRIGHT_LAUNCH_ARGS).toContain(
      '--disable-blink-features=AutomationControlled',
    );
  });

  it('returns an empty JobResponseDto when `playwright` is not installed (ERR_TESLA_PLAYWRIGHT_UNAVAILABLE)', async () => {
    // The workspace's root package.json does NOT depend on `playwright`,
    // and this package declares it as peerDependenciesMeta.optional —
    // so `await import('playwright')` (via the Function('s','return
    // import(s)')(...) indirection) inside scrape() will fail with
    // ERR_MODULE_NOT_FOUND. We exercise that real failure path here
    // WITHOUT mocking — covers the most load-bearing branch in the
    // whole package since 99% of operators run without the optional
    // dep installed.
    const service = new TeslaPlaywrightService();
    const input: ScraperInputDto = {
      siteType: [Site.TESLA_PLAYWRIGHT],
    } as ScraperInputDto;

    const result = await service.scrape(input);
    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toEqual([]);
  });

  // ────────────── T10 behavioural sweep (stubbed Playwright) ──────────────

  describe('happy path — stubbed playwright + board + detail fetches', () => {
    it('emits 5 jobs (resultsWanted=5); first 3 have descriptions; mapping pinned on first + remote rows; browser closed in finally', async () => {
      const evaluate = jest
        .fn()
        .mockResolvedValueOnce(BOARD_FIXTURE) // board fetch
        .mockResolvedValueOnce(DETAIL_FULL) // detail 300001 — full 4-field
        .mockResolvedValueOnce(DETAIL_PARTIAL) // detail 300002 — partial 2-field
        .mockResolvedValueOnce(DETAIL_SINGLE) // detail 300003 — single 1-field
        .mockResolvedValueOnce(DETAIL_MISSING) // detail 300004 — composeDescription returns null
        .mockResolvedValueOnce(null); // detail 300005 — fetchInPage returns null (e.g. non-JSON body)

      const { service, stub } = buildServiceWithStub({ evaluate });

      const input: ScraperInputDto = {
        siteType: [Site.TESLA_PLAYWRIGHT],
        resultsWanted: 5,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toHaveLength(5);

      // 1 board + 5 detail evaluates = 6 total `page.evaluate()` calls.
      expect(stub.evaluate).toHaveBeenCalledTimes(6);

      // First-row mapping pin (listing 300001).
      const first = result.jobs[0];
      expect(first.id).toBe('tesla-300001');
      expect(first.title).toBe('Senior Software Engineer, Vehicle Firmware');
      expect(first.companyName).toBe('Tesla');
      expect(first.atsId).toBe('300001');
      expect(first.atsType).toBe('tesla');
      // Q-032 default: emit Site.TESLA_PLAYWRIGHT (NOT Site.TESLA) so
      // dedup-engine's per-source breaker can track the two plugins
      // independently; cross-plugin dedup runs via the hash strategy.
      expect(first.site).toBe(Site.TESLA_PLAYWRIGHT);
      expect(first.location?.city).toBe('Palo Alto');
      expect(first.isRemote).toBe(false);
      expect(first.department).toBe('Software & IT');
      expect(first.jobUrl).toBe(
        `${TESLA_PLAYWRIGHT_BASE_URL}/careers/search/job/senior-software-engineer-vehicle-firmware-300001`,
      );

      // Remote-detection branch on listing 300002 (`Remote, United States`).
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
      // Listing 300002's detail omits Requirements + Compensation.
      expect(second.description).not.toContain('Requirements:');
      expect(second.description).not.toContain('Compensation & Benefits:');

      const third = result.jobs[2];
      expect(third.description).not.toBeNull();
      expect(third.description).toContain('Compensation & Benefits:');
      // Listing 300003's detail omits the other three fields entirely.
      expect(third.description).not.toContain('Description:');
      expect(third.description).not.toContain('Responsibilities:');
      expect(third.description).not.toContain('Requirements:');

      // Remainder (4th + 5th) have description === null.
      // 4th: missing-all-four envelope ⇒ composeDescription returns null.
      // 5th: page.evaluate returned null ⇒ fetchDetailDescription returns null.
      expect(result.jobs[3].description).toBeNull();
      expect(result.jobs[4].description).toBeNull();

      // Browser always closed in `finally` (FR-13).
      expect(stub.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('Akamai bypass succeeds — wire-format pin', () => {
    it('launches Chromium with the anti-automation flag and navigates with networkidle + 60s timeout', async () => {
      const evaluate = jest
        .fn()
        .mockResolvedValueOnce({
          listings: [
            { id: '300001', t: 'Test Engineer', l: 'loc-x', d: 'dep-x', r: 'reg-x' },
          ],
          lookup: {
            locations: { 'loc-x': 'Boise, ID' },
            departments: { 'dep-x': 'Engineering' },
            regions: { 'reg-x': 'Americas' },
          },
        })
        .mockResolvedValueOnce(DETAIL_FULL);

      const { service, stub } = buildServiceWithStub({ evaluate });

      const input: ScraperInputDto = {
        siteType: [Site.TESLA_PLAYWRIGHT],
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(1);
      // Anti-automation Chromium launch — pinned exactly per FR-13.
      expect(stub.launch).toHaveBeenCalledWith({
        headless: true,
        args: expect.arrayContaining([
          '--disable-blink-features=AutomationControlled',
        ]),
      });
      // Careers-page navigation pinned to upstream Python's settings.
      expect(stub.goto).toHaveBeenCalledWith(TESLA_PLAYWRIGHT_CAREERS_PAGE, {
        waitUntil: 'networkidle',
        timeout: TESLA_PLAYWRIGHT_GOTO_TIMEOUT_MS,
      });
      // First evaluate is the board fetch — pin the URL exactly.
      const firstEvalCall = stub.evaluate.mock.calls[0];
      expect(firstEvalCall?.[1]).toBe(
        `${TESLA_PLAYWRIGHT_BASE_URL}${TESLA_PLAYWRIGHT_BOARD_PATH}`,
      );
      // Browser still closed.
      expect(stub.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('page.goto rejects with TimeoutError — ERR_TESLA_PLAYWRIGHT_NAV_FAILED', () => {
    it('returns empty JobResponseDto, never enters detail loop, still closes browser in finally', async () => {
      // Shape mirrors Playwright's actual TimeoutError stringification.
      const timeoutErr = Object.assign(
        new Error('page.goto: Timeout 60000ms exceeded.'),
        { name: 'TimeoutError' },
      );
      const goto = jest.fn().mockRejectedValueOnce(timeoutErr);
      const evaluate = jest.fn();

      const { service, stub } = buildServiceWithStub({ goto, evaluate });

      const input: ScraperInputDto = {
        siteType: [Site.TESLA_PLAYWRIGHT],
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
      // Navigation failed BEFORE the board fetch could run ⇒ no
      // page.evaluate calls at all.
      expect(stub.evaluate).not.toHaveBeenCalled();
      // Browser still closed in finally.
      expect(stub.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("descriptionDepth='board' — budget=0 skips detail loop", () => {
    it('issues exactly one page.evaluate call (board only); every job has description === null', async () => {
      const evaluate = jest.fn().mockResolvedValueOnce(BOARD_FIXTURE);

      const { service, stub } = buildServiceWithStub({ evaluate });

      const input: ScraperInputDto = {
        siteType: [Site.TESLA_PLAYWRIGHT],
        descriptionDepth: 'board',
        resultsWanted: BOARD_LISTING_COUNT,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(BOARD_LISTING_COUNT);
      expect(result.jobs.every((j) => j.description === null)).toBe(true);
      // Board GET only; budget=0 ⇒ detail loop entry never executes a fetch.
      expect(stub.evaluate).toHaveBeenCalledTimes(1);
    });
  });

  describe('resultsWanted cap pre-detail-fetch (FR-11)', () => {
    it('caps the 10-listing board to 2 jobs AND issues only 2 detail evaluates (1 board + 2 details = 3 total)', async () => {
      const evaluate = jest
        .fn()
        .mockResolvedValueOnce(BOARD_FIXTURE)
        .mockResolvedValueOnce(DETAIL_FULL)
        .mockResolvedValueOnce(DETAIL_PARTIAL);

      const { service, stub } = buildServiceWithStub({ evaluate });

      const input: ScraperInputDto = {
        siteType: [Site.TESLA_PLAYWRIGHT],
        resultsWanted: 2,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result.jobs).toHaveLength(2);
      // Sanity: fixture has 10 listings — the cap is what trimmed it to 2.
      expect(BOARD_FIXTURE.listings?.length).toBe(BOARD_LISTING_COUNT);
      // 1 board + 2 details = 3 total evaluate calls.
      expect(stub.evaluate).toHaveBeenCalledTimes(3);
      expect(result.jobs[0].id).toBe('tesla-300001');
      expect(result.jobs[1].id).toBe('tesla-300002');
    });
  });
});
