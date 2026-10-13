import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  attachRawCapture,
  createHttpClient,
  parseLocationList,
} from '@ever-jobs/common';
import {
  TESLA_AKAMAI_STATUS_CODES,
  TESLA_BASE_URL,
  TESLA_BOARD_PATH,
  TESLA_BOARD_RETRY_MS,
  TESLA_CAREERS_PAGE,
  TESLA_DEFAULT_DESCRIPTION_DEPTH,
  TESLA_DEFAULT_RESULTS_WANTED,
  TESLA_DESCRIPTION_BUDGET,
  TESLA_DETAIL_PATH_TEMPLATE,
  TESLA_ERR_AKAMAI_CHALLENGE,
  TESLA_ERR_BROWSER_FETCH_FAILED,
  TESLA_ERR_BROWSER_NAV,
  TESLA_ERR_BROWSER_UNAVAILABLE,
  TESLA_ERR_FETCH_FAILED,
  TESLA_GOTO_TIMEOUT_MS,
  TESLA_HEADERS,
  TESLA_LAUNCH_ARGS,
  TESLA_PUBLIC_JOB_BASE,
  TESLA_SETTLE_MS,
} from './tesla.constants';
import {
  TeslaBoardListing,
  TeslaBoardLookup,
  TeslaBoardResponse,
  TeslaJobDetail,
} from './tesla.types';

/**
 * Spec 013 / T07 — Tesla single-tenant pure-HTTP scraper.
 *
 * Tesla is a single-tenant scraper — `companyUrl` and `companySlug`
 * inputs are ignored. The board endpoint
 * `https://www.tesla.com/cua-api/apps/careers/state` returns the
 * entire current job catalogue in one GET; per-job description
 * population requires follow-up GETs to `/cua-api/careers/job/{id}`,
 * budgeted by `input.descriptionDepth` per Q-031 / FR-11:
 *
 *   - `'board'` (default; 0 follow-ups) — descriptions stay null.
 *   - `'detail-25'` (25 follow-ups) — first 25 jobs (by
 *     board-emit order) get descriptions, remainder stay null.
 *   - `'detail-all'` (∞ follow-ups) — every job gets a description;
 *     opt-in only because it is ~8k+ sequential requests (Spec 5167).
 *
 * Akamai handling (FR-12):
 *   - Board GET returning HTTP 403 / 503 → empty `JobResponseDto`
 *     with sentinel `ERR_TESLA_AKAMAI_CHALLENGE` logged.
 *   - Board GET returning a body that is NOT a JSON object
 *     (typically an HTML challenge page) → same sentinel.
 *   - Other HTTP failures → `ERR_TESLA_FETCH_FAILED` sentinel
 *     (added during implementation; symmetric with the Mercor /
 *     Oracle two-sentinel pattern).
 *   - Detail-fetch failures are SILENTLY swallowed (logged at
 *     `debug`) — the corresponding listing keeps `description: null`
 *     but still emits as a `JobPostDto`. We do not let one bad
 *     detail-page poison the whole catalogue.
 *
 * **HTTP-first with a lazy browser fallback** (Spec 5167). When the plain
 * board GET fails for any reason (4xx/5xx, non-JSON body, network error),
 * `scrape()` re-runs the same flow through an in-page `fetch()` inside a
 * lazily imported Chromium session — the browser carries real cookies/TLS,
 * then the same cua-api JSON endpoints are consumed. `playwright` is
 * imported lazily inside the fallback only (no module-scope import), so
 * installs without it still boot clean; `source-tesla-playwright` remains
 * for operators who want browser-first.
 */
@SourcePlugin({
  site: Site.TESLA,
  name: 'Tesla',
  category: 'company',
  isAts: false,
})
@Injectable()
export class TeslaService implements IScraper {
  private readonly logger = new Logger(TeslaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted =
      input.resultsWanted ?? TESLA_DEFAULT_RESULTS_WANTED;
    const depthKey = this.resolveDepth(input.descriptionDepth);
    const detailBudget = TESLA_DESCRIPTION_BUDGET[depthKey];

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout,
    });
    client.setHeaders(TESLA_HEADERS);

    const board = await this.fetchBoard(client);
    if (board === null) {
      // Plain HTTP failed — retry the identical flow through a real
      // browser so the site's cookie/TLS gating resolves first.
      return this.scrapeViaBrowser(depthKey, resultsWanted, detailBudget);
    }

    const listings = (board.listings ?? []).slice(0, resultsWanted);
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
          ? await this.fetchDetail(client, listing.id)
          : null;
      jobs.push(this.toJobPost(listing, lookup, description));
    }

    this.logger.log(
      `TeslaService: ${jobs.length} jobs (descriptionDepth=${depthKey}, detailFetched=${detailFetchCount}, resultsWanted=${resultsWanted})`,
    );
    return new JobResponseDto(jobs);
  }

  /**
   * Resolve `input.descriptionDepth` against the documented enum,
   * defaulting to `'board'` per Spec 5167 when undefined or invalid.
   */
  private resolveDepth(raw: string | undefined): string {
    if (raw && raw in TESLA_DESCRIPTION_BUDGET) {
      return raw;
    }
    return TESLA_DEFAULT_DESCRIPTION_DEPTH;
  }

  /**
   * Fetch the board endpoint. Returns the parsed envelope on success,
   * `null` on any failure (sentinel logged via `Logger.warn`).
   */
  private async fetchBoard(client: any): Promise<TeslaBoardResponse | null> {
    const url = `${TESLA_BASE_URL}${TESLA_BOARD_PATH}`;
    try {
      const response = await client.get(url);
      const data = response?.data;

      if (this.looksLikeAkamaiHtml(data)) {
        this.logger.warn(
          `TeslaService: ${TESLA_ERR_AKAMAI_CHALLENGE} — board returned HTML body (Akamai challenge)`,
        );
        return null;
      }

      return (data ?? {}) as TeslaBoardResponse;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && TESLA_AKAMAI_STATUS_CODES.has(status)) {
        this.logger.warn(
          `TeslaService: ${TESLA_ERR_AKAMAI_CHALLENGE} — board returned HTTP ${status}`,
        );
      } else {
        this.logger.warn(
          `TeslaService: ${TESLA_ERR_FETCH_FAILED} — board fetch failed (status=${status ?? 'n/a'}): ${err?.message ?? err}`,
        );
      }
      return null;
    }
  }

  /**
   * Fetch a single job's detail envelope. Failures are swallowed and
   * surface as `description: null` on the corresponding listing —
   * we don't let a single bad detail page poison the whole batch.
   */
  private async fetchDetail(
    client: any,
    jobId: string,
  ): Promise<string | null> {
    const url = `${TESLA_BASE_URL}${TESLA_DETAIL_PATH_TEMPLATE.replace('{id}', jobId)}`;
    try {
      const response = await client.get(url);
      const detail = (response?.data ?? {}) as TeslaJobDetail;
      return this.composeDescription(detail);
    } catch (err: any) {
      this.logger.debug(
        `TeslaService: detail fetch failed for jobId=${jobId} (status=${err?.response?.status ?? 'n/a'}); description left null`,
      );
      return null;
    }
  }

  /**
   * Spec 5167 — browser fallback. Runs the identical board+detail flow
   * through an in-page `fetch()` inside a real Chromium session after the
   * plain HTTP board GET failed. Emits `Site.TESLA` like the fast path so
   * identity/dedup are indifferent to which path produced the jobs.
   *
   * Headless first, headed once (observed live: a headless session can be
   * denied at the edge — "Access Denied", zero cookies — while a headed
   * window loads the page and the in-page board fetch returns the full
   * JSON). The fallback tries headless first — cheaper — and escalates to
   * a headed window exactly once when the headless session still cannot
   * read the board. A headed launch without a display throws instantly
   * and degrades to the same empty DTO.
   * Always resolves with a `JobResponseDto` — never throws.
   */
  private async scrapeViaBrowser(
    depthKey: string,
    resultsWanted: number,
    detailBudget: number,
  ): Promise<JobResponseDto> {
    const playwrightModule = await this.loadPlaywright();
    if (!playwrightModule) {
      return new JobResponseDto([]);
    }

    for (const headless of [true, false]) {
      const result = await this.browserAttempt(
        playwrightModule,
        headless,
        depthKey,
        resultsWanted,
        detailBudget,
      );
      if (result !== null) {
        return result;
      }
      if (headless) {
        this.logger.debug(
          'TeslaService: headless session could not read the board — retrying with a headed window',
        );
      }
    }
    this.logger.warn(
      `TeslaService: ${TESLA_ERR_BROWSER_FETCH_FAILED} — browser fallback exhausted (headless + headed)`,
    );
    return new JobResponseDto([]);
  }

  /**
   * One browser attempt: launch (headless or headed) → open the careers
   * page → in-page board fetch → in-page detail fetches per budget.
   * Returns `null` on ANY failure so the caller can escalate headless →
   * headed; an empty `listings[]` returns an empty DTO (a genuinely empty
   * board is a result, not a challenge).
   */
  private async browserAttempt(
    playwrightModule: any,
    headless: boolean,
    depthKey: string,
    resultsWanted: number,
    detailBudget: number,
  ): Promise<JobResponseDto | null> {
    let browser: any = null;
    try {
      browser = await playwrightModule.chromium.launch({
        headless,
        args: [...TESLA_LAUNCH_ARGS],
      });
      const page = await browser.newPage();
      attachRawCapture(page);

      if (!(await this.openCareersPage(page))) {
        return null;
      }

      // The site's protection JS can still be resolving after the settle —
      // poll the board fetch a few times in the same page before giving
      // this mode up for a relaunch.
      let board: TeslaBoardResponse | null = null;
      for (let i = 0; i < 3; i++) {
        board = await this.fetchInPage<TeslaBoardResponse>(
          page,
          `${TESLA_BASE_URL}${TESLA_BOARD_PATH}`,
        );
        if (board && Array.isArray(board.listings)) break;
        board = null;
        if (i < 2) await this.sleep(TESLA_BOARD_RETRY_MS);
      }
      if (!board) {
        return null;
      }

      const listings = (board.listings ?? []).slice(0, resultsWanted);
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
            ? await this.fetchDetailInPage(page, listing.id)
            : null;
        jobs.push(this.toJobPost(listing, lookup, description));
      }

      this.logger.log(
        `TeslaService: ${jobs.length} jobs via browser fallback (${headless ? 'headless' : 'headed'}, descriptionDepth=${depthKey}, detailFetched=${detailFetchCount}, resultsWanted=${resultsWanted})`,
      );
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.debug(
        `TeslaService: browser attempt (${headless ? 'headless' : 'headed'}) failed: ${err?.message ?? err}`,
      );
      return null;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr: any) {
          this.logger.debug(
            `TeslaService: browser close failed (non-fatal): ${closeErr?.message ?? closeErr}`,
          );
        }
      }
    }
  }

  /**
   * Lazy-load `playwright`. Returns `null` (sentinel logged) when the dep
   * is not installed — the Function-wrapped import keeps module load
   * clean in workspaces without it.
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
        `TeslaService: ${TESLA_ERR_BROWSER_UNAVAILABLE} — \`playwright\` not installed (${err?.message ?? err}). Run \`npm install playwright\` and \`npx playwright install chromium\` to enable the browser fallback.`,
      );
      return null;
    }
  }

  /**
   * Navigate to the careers-search landing page and settle long enough
   * for the site's protection JS to resolve its cookies. `true` on success.
   */
  private async openCareersPage(page: any): Promise<boolean> {
    try {
      await page.goto(TESLA_CAREERS_PAGE, {
        // 'domcontentloaded', not 'networkidle' — the careers SPA keeps
        // telemetry/asset connections open and networkidle never settles
        // inside the timeout on a real (headed) page.
        waitUntil: 'domcontentloaded',
        timeout: TESLA_GOTO_TIMEOUT_MS,
      });
      await this.sleep(TESLA_SETTLE_MS);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `TeslaService: ${TESLA_ERR_BROWSER_NAV} — careers-page navigation failed: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  /**
   * Issue an in-page `fetch()` through the established browser session
   * (browser-native cookies/TLS) and parse the response as JSON.
   * Errors return `null`; the caller decides how to surface them.
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
          `TeslaService: in-page fetch ${url} → HTTP ${(json as any).__status}`,
        );
        return null;
      }
      if (json && typeof json === 'object' && '__nonJson' in json) {
        this.logger.debug(
          `TeslaService: in-page fetch ${url} → non-JSON body (truncated): ${(json as any).__nonJson}`,
        );
        return null;
      }
      return json as T;
    } catch (err: any) {
      this.logger.debug(
        `TeslaService: in-page fetch ${url} threw: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Fetch one detail envelope in-page and compose its description.
   * Failures swallow — the listing keeps `description: null`.
   */
  private async fetchDetailInPage(
    page: any,
    jobId: string,
  ): Promise<string | null> {
    const url = `${TESLA_BASE_URL}${TESLA_DETAIL_PATH_TEMPLATE.replace('{id}', jobId)}`;
    const detail = await this.fetchInPage<TeslaJobDetail>(page, url);
    if (!detail) return null;
    return this.composeDescription(detail);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build the canonical `description` string by concatenating the four
   * documented detail fields with `\n\n` separators (matches upstream
   * Python's join pattern). Returns `null` when none of the fields
   * are populated — distinguishes "we tried but no description"
   * from "we never tried".
   */
  private composeDescription(detail: TeslaJobDetail): string | null {
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

  /**
   * Heuristic Akamai-challenge detector. Tesla's gateway sometimes
   * returns HTTP 200 with an HTML body when its bot manager flags a
   * client — we treat any non-object payload OR any payload whose
   * top-level shape lacks `listings` AND `lookup` as "not the
   * expected JSON envelope".
   */
  private looksLikeAkamaiHtml(data: any): boolean {
    if (typeof data === 'string') return true;
    if (data == null) return false;
    if (typeof data !== 'object') return true;
    const hasListings = 'listings' in data;
    const hasLookup = 'lookup' in data;
    return !hasListings && !hasLookup;
  }

  /** Map a single board listing into the canonical `JobPostDto`. */
  private toJobPost(
    listing: TeslaBoardListing,
    lookup: TeslaBoardLookup,
    description: string | null,
  ): JobPostDto {
    const locationStr = lookup.locations?.[listing.l ?? ''] ?? null;
    const departmentStr = lookup.departments?.[listing.d ?? ''] ?? null;

    const locationParsed = parseLocationList([locationStr]);
    const location = locationStr ? locationParsed.location : null;
    const isRemote =
      locationStr?.toLowerCase().includes('remote') ?? false;

    return new JobPostDto({
      id: `tesla-${listing.id}`,
      title: listing.t,
      companyName: 'Tesla',
      jobUrl: this.buildJobUrl(listing.id, listing.t),
      location,
      ...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {}),
      isRemote,
      site: Site.TESLA,
      atsId: listing.id,
      atsType: 'tesla',
      department: departmentStr,
      description,
    });
  }

  /**
   * Build the public-facing careers URL:
   * `https://www.tesla.com/careers/search/job/<title-slug>-<id>`.
   * Matches upstream Python's `create_job_url_slug()`.
   */
  private buildJobUrl(jobId: string, title: string): string {
    const slug = this.slugify(title);
    return `${TESLA_PUBLIC_JOB_BASE}/${slug}-${jobId}`;
  }

  /** Convert a title to a kebab-case slug (alphanumerics + hyphens). */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
