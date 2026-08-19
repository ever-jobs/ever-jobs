import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  TESLA_PLAYWRIGHT_BASE_URL,
  TESLA_PLAYWRIGHT_BOARD_PATH,
  TESLA_PLAYWRIGHT_CAREERS_PAGE,
  TESLA_PLAYWRIGHT_DEFAULT_DESCRIPTION_DEPTH,
  TESLA_PLAYWRIGHT_DEFAULT_RESULTS_WANTED,
  TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET,
  TESLA_PLAYWRIGHT_DETAIL_PATH_TEMPLATE,
  TESLA_PLAYWRIGHT_ERR_FETCH_FAILED,
  TESLA_PLAYWRIGHT_ERR_NAV_FAILED,
  TESLA_PLAYWRIGHT_ERR_UNAVAILABLE,
  TESLA_PLAYWRIGHT_GOTO_TIMEOUT_MS,
  TESLA_PLAYWRIGHT_LAUNCH_ARGS,
  TESLA_PLAYWRIGHT_PUBLIC_JOB_BASE,
  TESLA_PLAYWRIGHT_SETTLE_MS,
} from './tesla-playwright.constants';
import {
  TeslaPlaywrightBoardListing,
  TeslaPlaywrightBoardLookup,
  TeslaPlaywrightBoardResponse,
  TeslaPlaywrightJobDetail,
} from './tesla-playwright.types';

/**
 * Spec 013 / T09 — Tesla-Playwright OPTIONAL companion scraper.
 *
 * Operators opt in by manually importing `TeslaPlaywrightModule`
 * alongside their preferred set in their `JobsModule` — this plugin
 * is NOT auto-registered via `ALL_SOURCE_MODULES` per Q-028 / FR-13.
 * The `playwright` dependency is declared as a `peerDependency` +
 * `peerDependenciesMeta.optional` on this package's `package.json`,
 * so an `npm install` without the operator-driven `npm i playwright`
 * still resolves clean.
 *
 * Lazy-import semantics (FR-13):
 *   - The `await import('playwright')` happens INSIDE `scrape()`, not
 *     at module-load time. A workspace that has not installed
 *     `playwright` boots cleanly; the failure surfaces only when the
 *     operator actually invokes the scraper.
 *   - `ERR_MODULE_NOT_FOUND` (or any module-resolution error) is
 *     caught and surfaced via `ERR_TESLA_PLAYWRIGHT_UNAVAILABLE`.
 *   - `scrape()` always resolves — never throws — per `AGENTS.md §10`.
 *
 * Akamai-bypass flow (mirrors upstream Python
 * `OTHERS/Ats-scrapers/tesla/main.py`):
 *   1. Launch headless Chromium with anti-automation flags
 *      (`--disable-blink-features=AutomationControlled` is the
 *      load-bearing one).
 *   2. Navigate to `https://www.tesla.com/careers/search/`; wait for
 *      `networkidle` with a 60 s timeout.
 *   3. Settle 5 seconds to let Akamai's challenge JS resolve fully.
 *   4. In-page `fetch()` for the board endpoint, parsed as JSON.
 *   5. In-page `fetch()` for per-job detail endpoints (budgeted by
 *      `descriptionDepth`).
 *   6. Map listings → `JobPostDto[]` using the same shape as the
 *      default `source-tesla` plugin so cross-plugin dedup via
 *      `(site, externalId)` collapses rows when both plugins are
 *      enabled (per Q-032 default).
 *   7. Always close the browser in a `finally` block.
 *
 * Site emit: `Site.TESLA_PLAYWRIGHT` (NOT `Site.TESLA`) so the
 * dedup-engine's per-source breaker policy (Spec 005 / FR-1) can
 * track the two plugins independently. Cross-site dedup happens via
 * `dedup-hybrid`'s hash strategy (Spec 003 / FR-3).
 */
@SourcePlugin({
  site: Site.TESLA_PLAYWRIGHT,
  name: 'Tesla (Playwright)',
  category: 'company',
  isAts: false,
})
@Injectable()
export class TeslaPlaywrightService implements IScraper {
  private readonly logger = new Logger(TeslaPlaywrightService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const playwrightModule = await this.loadPlaywright();
    if (!playwrightModule) {
      return new JobResponseDto([]);
    }

    const resultsWanted =
      input.resultsWanted ?? TESLA_PLAYWRIGHT_DEFAULT_RESULTS_WANTED;
    const depthKey = this.resolveDepth(input.descriptionDepth);
    const detailBudget = TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET[depthKey];

    let browser: any = null;
    try {
      browser = await playwrightModule.chromium.launch({
        headless: true,
        args: [...TESLA_PLAYWRIGHT_LAUNCH_ARGS],
      });
      const page = await browser.newPage();

      const navOk = await this.openCareersPage(page);
      if (!navOk) {
        return new JobResponseDto([]);
      }

      const board = await this.fetchInPage<TeslaPlaywrightBoardResponse>(
        page,
        `${TESLA_PLAYWRIGHT_BASE_URL}${TESLA_PLAYWRIGHT_BOARD_PATH}`,
      );
      if (!board || !Array.isArray(board.listings)) {
        this.logger.warn(
          `TeslaPlaywrightService: ${TESLA_PLAYWRIGHT_ERR_FETCH_FAILED} — board response missing listings[]`,
        );
        return new JobResponseDto([]);
      }

      const listings = board.listings.slice(0, resultsWanted);
      const lookup = board.lookup ?? {};
      const detailFetchCount = Math.min(
        listings.length,
        Number.isFinite(detailBudget) ? detailBudget : listings.length,
      );

      const jobs: JobPostDto[] = [];
      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        const description =
          i < detailFetchCount
            ? await this.fetchDetailDescription(page, listing.id)
            : null;
        jobs.push(this.toJobPost(listing, lookup, description));
      }

      this.logger.log(
        `TeslaPlaywrightService: ${jobs.length} jobs (descriptionDepth=${depthKey}, detailFetched=${detailFetchCount}, resultsWanted=${resultsWanted})`,
      );
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.warn(
        `TeslaPlaywrightService: ${TESLA_PLAYWRIGHT_ERR_FETCH_FAILED} — unexpected error during scrape: ${err?.message ?? err}`,
      );
      return new JobResponseDto([], classifyScrapeError(err));
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr: any) {
          this.logger.debug(
            `TeslaPlaywrightService: browser close failed (non-fatal): ${closeErr?.message ?? closeErr}`,
          );
        }
      }
    }
  }

  /**
   * Resolve `input.descriptionDepth` against the documented enum,
   * defaulting to `'detail-25'` per Q-031 when undefined or invalid.
   */
  private resolveDepth(raw: string | undefined): string {
    if (raw && raw in TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET) {
      return raw;
    }
    return TESLA_PLAYWRIGHT_DEFAULT_DESCRIPTION_DEPTH;
  }

  /**
   * Lazy-load the `playwright` module. Returns `null` (with a
   * sentinel logged) when the dep is not installed — operators see
   * the `ERR_TESLA_PLAYWRIGHT_UNAVAILABLE` line in their logs.
   */
  private async loadPlaywright(): Promise<any | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return await Function(
        'specifier',
        'return import(specifier)',
      )('playwright');
    } catch (err: any) {
      this.logger.warn(
        `TeslaPlaywrightService: ${TESLA_PLAYWRIGHT_ERR_UNAVAILABLE} — \`playwright\` not installed (${err?.message ?? err}). Run \`npm install playwright\` and \`npx playwright install chromium\` to enable.`,
      );
      return null;
    }
  }

  /**
   * Navigate to the careers-search landing page and settle long
   * enough for Akamai's challenge JS to resolve. Returns `true` on
   * success, `false` when navigation fails.
   */
  private async openCareersPage(page: any): Promise<boolean> {
    try {
      await page.goto(TESLA_PLAYWRIGHT_CAREERS_PAGE, {
        waitUntil: 'networkidle',
        timeout: TESLA_PLAYWRIGHT_GOTO_TIMEOUT_MS,
      });
      await this.sleep(TESLA_PLAYWRIGHT_SETTLE_MS);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `TeslaPlaywrightService: ${TESLA_PLAYWRIGHT_ERR_NAV_FAILED} — careers-page navigation failed: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  /**
   * Issue an in-page `fetch()` through the established Playwright
   * session and parse the response as JSON. Errors return `null`
   * (caller decides how to surface).
   */
  private async fetchInPage<T>(page: any, url: string): Promise<T | null> {
    try {
      const json = await page.evaluate(async (u: string) => {
        const r = await fetch(u, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) {
          return { __status: r.status };
        }
        const txt = await r.text();
        try {
          return JSON.parse(txt);
        } catch {
          return { __nonJson: txt.slice(0, 200) };
        }
      }, url);

      if (json && typeof json === 'object' && '__status' in json) {
        this.logger.debug(
          `TeslaPlaywrightService: in-page fetch ${url} → HTTP ${(json as any).__status}`,
        );
        return null;
      }
      if (json && typeof json === 'object' && '__nonJson' in json) {
        this.logger.debug(
          `TeslaPlaywrightService: in-page fetch ${url} → non-JSON body (truncated): ${(json as any).__nonJson}`,
        );
        return null;
      }
      return json as T;
    } catch (err: any) {
      this.logger.debug(
        `TeslaPlaywrightService: in-page fetch ${url} threw: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Fetch a single detail envelope and compose its description.
   * Failures swallow silently — the affected listing keeps
   * `description: null`, but still emits as a `JobPostDto`.
   */
  private async fetchDetailDescription(
    page: any,
    jobId: string,
  ): Promise<string | null> {
    const url = `${TESLA_PLAYWRIGHT_BASE_URL}${TESLA_PLAYWRIGHT_DETAIL_PATH_TEMPLATE.replace('{id}', jobId)}`;
    const detail = await this.fetchInPage<TeslaPlaywrightJobDetail>(page, url);
    if (!detail) return null;
    return this.composeDescription(detail);
  }

  /**
   * Build the canonical `description` string by concatenating the
   * four documented detail fields with `\n\n` separators (matches
   * upstream Python's join pattern AND the default `source-tesla`
   * package's compose logic — kept duplicated per the no-peer-import
   * rule).
   */
  private composeDescription(
    detail: TeslaPlaywrightJobDetail,
  ): string | null {
    const parts: string[] = [];
    if (detail.jobDescription) {
      parts.push(`Description:\n${detail.jobDescription}`);
    }
    if (detail.jobResponsibilities) {
      parts.push(`Responsibilities:\n${detail.jobResponsibilities}`);
    }
    if (detail.jobRequirements) {
      parts.push(`Requirements:\n${detail.jobRequirements}`);
    }
    if (detail.jobCompensationAndBenefits) {
      parts.push(`Compensation & Benefits:\n${detail.jobCompensationAndBenefits}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  /** Map a single board listing into the canonical `JobPostDto`. */
  private toJobPost(
    listing: TeslaPlaywrightBoardListing,
    lookup: TeslaPlaywrightBoardLookup,
    description: string | null,
  ): JobPostDto {
    const locationStr = lookup.locations?.[listing.l ?? ''] ?? null;
    const departmentStr = lookup.departments?.[listing.d ?? ''] ?? null;

    const location = locationStr
      ? new LocationDto({ city: locationStr })
      : null;
    const isRemote =
      locationStr?.toLowerCase().includes('remote') ?? false;

    return new JobPostDto({
      id: `tesla-${listing.id}`,
      title: listing.t,
      companyName: 'Tesla',
      jobUrl: this.buildJobUrl(listing.id, listing.t),
      location,
      isRemote,
      site: Site.TESLA_PLAYWRIGHT,
      atsId: listing.id,
      atsType: 'tesla',
      department: departmentStr,
      description,
    });
  }

  /**
   * Build the public-facing careers URL. Shared shape with the
   * default `source-tesla` plugin so dedup-engine's hash strategy
   * collapses cross-plugin duplicates correctly.
   */
  private buildJobUrl(jobId: string, title: string): string {
    const slug = this.slugify(title);
    return `${TESLA_PLAYWRIGHT_PUBLIC_JOB_BASE}/${slug}-${jobId}`;
  }

  /** Convert a title to a kebab-case slug (alphanumerics + hyphens). */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Promise-shaped setTimeout. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
