import 'reflect-metadata';
import { BrowserPool } from '@ever-jobs/common';
import { JobPostDto, JobResponseDto, ScraperInputDto } from '@ever-jobs/models';
import { DiceService } from '@ever-jobs/source-dice';
import { SimplyHiredService } from '@ever-jobs/source-simplyhired';
import { StepStoneService } from '@ever-jobs/source-stepstone';
import { TikTokService } from '@ever-jobs/source-company-tiktok';
import { DesktopmetalService } from '@ever-jobs/source-company-desktopmetal';

/**
 * Live check that browser-backed sources get a working Chromium and scrape
 * through it.
 *
 * Opt-in: the `*.browser-spec.ts` suffix is outside jest's default
 * `testMatch`, so plain `jest` and CI never pick it up. Run it with
 * `npm run test:browser` (needs `npx playwright install chromium` and network).
 *
 * What is asserted, per source:
 *   - the source actually asked {@link BrowserPool} for a page, and every
 *     launch succeeded. Several sources swallow Playwright errors and return
 *     `[]`, so a missing browser is otherwise indistinguishable from "no jobs";
 *   - the source did not report `browser_unavailable`.
 * Job counts and other reasons (`blocked`, `empty`) depend on the live site,
 * so they are reported in a table rather than failed on — except that at least
 * one source must return jobs, proving extraction works end to end.
 *
 * Desktop Metal requests a headful browser, so a Chrome window opens briefly.
 * Set `EVER_JOBS_BROWSER_HEADFUL=false` to force headless.
 */

const LIVE_TIMEOUT_MS = 240_000;

interface BrowserSourceCase {
  name: string;
  /** Run the source's browser-backed path. */
  run: (input: ScraperInputDto) => Promise<JobResponseDto>;
  input: Partial<ScraperInputDto>;
}

/** Private Playwright fallback shared by sources that try HTTP first. */
interface PlaywrightFallbackSeam {
  scrapeWithPlaywright(input: ScraperInputDto, resultsWanted: number): Promise<JobPostDto[]>;
}

/**
 * Dice and SimplyHired only reach Playwright after their HTTP paths come back
 * empty, so `scrape()` may never launch a browser. Call the fallback directly.
 */
function viaPlaywrightFallback(service: object): BrowserSourceCase['run'] {
  const seam = service as unknown as PlaywrightFallbackSeam;
  return async (input) =>
    new JobResponseDto(await seam.scrapeWithPlaywright(input, input.resultsWanted ?? 5));
}

const CASES: BrowserSourceCase[] = [
  {
    name: 'tiktok',
    run: (input) => new TikTokService().scrape(input),
    input: { searchTerm: 'software engineer' },
  },
  {
    name: 'stepstone',
    run: (input) => new StepStoneService().scrape(input),
    input: { searchTerm: 'software engineer' },
  },
  {
    name: 'dice (playwright fallback)',
    run: viaPlaywrightFallback(new DiceService()),
    input: { searchTerm: 'java developer', location: 'New York, NY' },
  },
  {
    name: 'simplyhired (playwright fallback)',
    run: viaPlaywrightFallback(new SimplyHiredService()),
    input: { searchTerm: 'java developer', location: 'New York, NY' },
  },
  {
    name: 'desktopmetal (stealth, headful)',
    run: (input) => new DesktopmetalService().scrape(input),
    input: {},
  },
];

interface ReportRow {
  source: string;
  pageLaunches: number;
  launchFailures: number;
  jobs: number;
  reason: string;
}

describe('browser-backed sources (live)', () => {
  const report: ReportRow[] = [];
  let getPageSpy: jest.SpyInstance;

  beforeEach(() => {
    // Calls through to the real pool; only records what each call returned.
    getPageSpy = jest.spyOn(BrowserPool, 'getPage');
  });

  afterEach(() => {
    getPageSpy.mockRestore();
  });

  afterAll(async () => {
    await BrowserPool.close();
    console.table(report);
  });

  it.each(CASES)(
    '$name launches a browser page and scrapes through it',
    async ({ name, run, input }) => {
      const response = await run(
        Object.assign(new ScraperInputDto(), { resultsWanted: 5, requestTimeout: 60, ...input }),
      );

      const launches = await Promise.allSettled(
        getPageSpy.mock.results.map((r) =>
          r.type === 'throw' ? Promise.reject(r.value) : r.value,
        ),
      );
      const failures = launches
        .filter((l): l is PromiseRejectedResult => l.status === 'rejected')
        .map((l) => String(l.reason?.message ?? l.reason));

      report.push({
        source: name,
        pageLaunches: launches.length,
        launchFailures: failures.length,
        jobs: response.jobs.length,
        reason: response.diagnostics?.reason ?? (response.jobs.length ? 'ok' : 'empty'),
      });

      expect(launches.length).toBeGreaterThan(0);
      expect(failures).toEqual([]);
      expect(response.diagnostics?.reason).not.toBe('browser_unavailable');
    },
    LIVE_TIMEOUT_MS,
  );

  it('at least one browser-backed source returned jobs', () => {
    expect(report.some((row) => row.jobs > 0)).toBe(true);
  });
});
