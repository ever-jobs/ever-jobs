import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Country,
  JobType,
  ScrapeDiagnostics,
  Site,
  DescriptionFormat,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  parseLocationList,
  postedFromTimestamp,
  postedTimeFields,
} from '@ever-jobs/common';
import {
  SOLIDJOBS_API_URL,
  SOLIDJOBS_CAMPAIGN,
  SOLIDJOBS_COUNTRY_CODE,
  SOLIDJOBS_DEFAULT_RESULTS,
  SOLIDJOBS_DIVISION_CONCURRENCY,
  SOLIDJOBS_DIVISIONS_ALL,
  SOLIDJOBS_DIVISIONS_ENV,
  SOLIDJOBS_HEADERS,
  SOLIDJOBS_INPUT_FILTERS_ENV,
  SOLIDJOBS_MAX_PAGE_SIZE,
  SOLIDJOBS_MAX_PAGES_PER_DIVISION,
  SOLIDJOBS_PAGINATE_ENV,
  SOLIDJOBS_SEARCH_MODE_ENV,
  SOLIDJOBS_TIME_BUDGET_ENV,
  SOLIDJOBS_TIME_BUDGET_MS,
  SOLIDJOBS_USER_AGENT,
} from './solidjobs.constants';
import {
  SolidJobsFilter,
  SolidJobsSearchMode,
  buildSolidJobsFilter,
  contractTimeJobTypes,
  humaniseCode,
  isCountryLevelLabel,
  isMappable,
  isWithinCutoff,
  orderDivisionsByHints,
} from './solidjobs.filters';
import { SolidJobsOffer, SolidJobsResponse, SolidJobsSalary } from './solidjobs.types';

type HttpClient = ReturnType<typeof createHttpClient>;

/** What one scrape is after and how it may fetch it. */
interface ScanPlan {
  /** `offset + resultsWanted`: matching offers to collect before stopping. */
  need: number;
  /** Fixed page size for the whole scrape; `null` = the un-paged Spec 718 request. */
  pageSize: number | null;
  /** Epoch ms after which no new page is started. */
  deadline: number;
  filter: SolidJobsFilter | null;
}

/** Progress of one division during a scan. */
interface DivisionState {
  division: string;
  /** Matching offers, in feed order. */
  matches: SolidJobsOffer[];
  done: boolean;
  /**
   * Unfiltered scans only: how many offers this division will yield in total
   * (the server's `totalCount`, capped by the page limit), once a page said so.
   */
  expected: number | null;
}

interface DivisionFailure {
  division: string;
  pageIndex: number;
  diagnostics: ScrapeDiagnostics;
}

interface ScanOutcome {
  states: DivisionState[];
  failures: DivisionFailure[];
  budgetHit: boolean;
}

const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

@SourcePlugin({
  site: Site.SOLIDJOBS,
  name: 'Solid.Jobs',
  category: 'regional',
})
@Injectable()
export class SolidJobsService implements IScraper {
  private readonly logger = new Logger(SolidJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = this.nonNegativeInt(input.resultsWanted, SOLIDJOBS_DEFAULT_RESULTS);
    const offset = this.nonNegativeInt(input.offset, 0);
    if (resultsWanted === 0) return new JobResponseDto([]);

    try {
      const need = offset + resultsWanted;
      const filter = buildSolidJobsFilter(input, {
        searchMode: this.searchMode(),
        inputFilters: this.envFlag(SOLIDJOBS_INPUT_FILTERS_ENV, true),
      });
      const paginate = this.envFlag(SOLIDJOBS_PAGINATE_ENV, true);
      // Unfiltered, every mappable offer counts, so a page no bigger than the
      // request is enough; filtered, the largest page keeps the request count low.
      const pageSize = !paginate
        ? null
        : filter
          ? SOLIDJOBS_MAX_PAGE_SIZE
          : Math.min(SOLIDJOBS_MAX_PAGE_SIZE, Math.max(1, need));
      const divisions = this.resolveDivisions(input.searchTerm);
      const budgetMs = this.timeBudgetMs();
      const plan: ScanPlan = { need, pageSize, deadline: Date.now() + budgetMs, filter };

      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
        userAgent: input.userAgent || SOLIDJOBS_USER_AGENT,
        retries: input.retries,
        retryDelay: input.retryDelay,
        retryBackoff: input.retryBackoff,
        retryMaxDelay: input.retryMaxDelay,
        rateDelayMin: input.rateDelayMin,
        rateDelayMax: input.rateDelayMax,
      });
      client.setHeaders(SOLIDJOBS_HEADERS);

      this.logger.log(
        `Fetching Solid.Jobs divisions [${divisions.join(', ')}] (resultsWanted=${resultsWanted}, offset=${offset}, ` +
          `pageSize=${pageSize ?? 'server default'}, filters=[${filter?.active.join(', ') ?? ''}])`,
      );

      const outcome = await this.scanDivisions(client, divisions, plan);

      // Deterministic merge: division order, not completion order.
      const seen = new Set<string>();
      const ordered = outcome.states
        .flatMap((state) => state.matches)
        .filter((offer) => !seen.has(offer.jobOfferKey) && !!seen.add(offer.jobOfferKey));

      const jobs: JobPostDto[] = [];
      for (const offer of ordered.slice(offset, need)) {
        const job = this.safeMap(offer, input.descriptionFormat);
        if (job) jobs.push(job);
      }

      this.logger.log(`Solid.Jobs returned ${jobs.length} jobs`);
      return new JobResponseDto(
        jobs,
        this.diagnose(jobs.length, resultsWanted, outcome, budgetMs),
      );
    } catch (err: any) {
      this.logger.error(`Solid.Jobs scrape error: ${err?.message ?? err}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Resolve the division list. `SOLIDJOBS_DIVISIONS` (comma-separated) wins
   * and keeps the operator's order; otherwise every public division, with
   * the ones the search term hints at moved to the front.
   */
  private resolveDivisions(searchTerm?: string | null): string[] {
    const raw = process.env[SOLIDJOBS_DIVISIONS_ENV];
    if (raw) {
      const divisions = raw
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0);
      if (divisions.length > 0) return [...new Set(divisions)];
    }
    return orderDivisionsByHints(SOLIDJOBS_DIVISIONS_ALL, searchTerm);
  }

  /**
   * Build the per-division offers URL. The `campaign` query parameter is
   * mandatory — the server rejects requests without it (HTTP 400). Paging
   * parameters follow in a fixed order; a `null` page size builds the
   * un-paged Spec 718 URL.
   */
  private buildDivisionUrl(division: string, pageSize: number | null, pageIndex: number): string {
    const params = new URLSearchParams({ campaign: SOLIDJOBS_CAMPAIGN });
    if (pageSize !== null) {
      params.set('pageSize', String(pageSize));
      params.set('pageIndex', String(pageIndex));
    }
    return `${SOLIDJOBS_API_URL}/${encodeURIComponent(division)}?${params.toString()}`;
  }

  /**
   * Scan divisions with at most {@link SOLIDJOBS_DIVISION_CONCURRENCY}
   * in flight. A new division starts only while the divisions before it
   * cannot already fill the request. Unfiltered, that is known from the
   * server's `totalCount`, so the next division waits for the first page of
   * the ones in flight; filtered, a division's yield is unknown until it is
   * read, so divisions overlap.
   */
  private async scanDivisions(
    client: HttpClient,
    divisions: string[],
    plan: ScanPlan,
  ): Promise<ScanOutcome> {
    const outcome: ScanOutcome = {
      states: divisions.map((division) => ({ division, matches: [], done: false, expected: null })),
      failures: [],
      budgetHit: false,
    };
    const { states } = outcome;
    let next = 0;
    const inFlight = new Set<Promise<void>>();
    let wake: () => void = () => undefined;

    const shouldStart = (): boolean => {
      if (next >= states.length || this.satisfiedThrough(states, next - 1, plan.need)) return false;
      if (plan.filter) return true;
      let expected = 0;
      for (let i = 0; i < next; i++) {
        const state = states[i];
        if (state.done) expected += state.matches.length;
        else if (state.expected === null) return false;
        else expected += Math.max(state.matches.length, state.expected);
      }
      return expected < plan.need;
    };

    for (;;) {
      const progressed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      while (inFlight.size < SOLIDJOBS_DIVISION_CONCURRENCY && shouldStart()) {
        if (Date.now() >= plan.deadline) {
          outcome.budgetHit = true;
          break;
        }
        const index = next++;
        const task: Promise<void> = this.fetchDivision(client, index, plan, outcome, () => wake())
          .catch((err) => {
            // fetchDivision records its own failures; this is a last resort.
            outcome.failures.push({
              division: states[index].division,
              pageIndex: -1,
              diagnostics: classifyScrapeError(err),
            });
          })
          .finally(() => {
            states[index].done = true;
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
      if (inFlight.size === 0) break;
      await Promise.race([...inFlight, progressed]);
    }

    return outcome;
  }

  /**
   * True when the divisions up to `index` already hold `need` matches. Counts
   * only grow, so the offers a later division would add are past the request.
   */
  private satisfiedThrough(states: DivisionState[], index: number, need: number): boolean {
    let total = 0;
    for (let i = 0; i <= index && i < states.length; i++) {
      total += states[i].matches.length;
      if (total >= need) return true;
    }
    return false;
  }

  /**
   * Page through one division, sequentially. Stops when the divisions up to
   * this one hold enough matches, on an empty page, on a page with no new
   * offers (a server that ignores `pageIndex`), on a page wholly older than
   * `hoursOld` (the feed is newest-first), after the last page, at the page
   * cap, or at the time budget. A failed page keeps the pages before it.
   */
  private async fetchDivision(
    client: HttpClient,
    index: number,
    plan: ScanPlan,
    outcome: ScanOutcome,
    onProgress: () => void,
  ): Promise<void> {
    const state = outcome.states[index];
    const { division } = state;
    const keys = new Set<string>();
    const pageLimit = plan.pageSize === null ? 1 : SOLIDJOBS_MAX_PAGES_PER_DIVISION;
    const cutoffMs = plan.filter?.cutoffMs ?? null;

    for (let pageIndex = 0; pageIndex < pageLimit; pageIndex++) {
      if (pageIndex > 0 && Date.now() >= plan.deadline) {
        outcome.budgetHit = true;
        break;
      }

      let data: SolidJobsResponse | undefined;
      try {
        const response = await client.get(this.buildDivisionUrl(division, plan.pageSize, pageIndex));
        data = response?.data;
      } catch (err: any) {
        outcome.failures.push({ division, pageIndex, diagnostics: classifyScrapeError(err) });
        this.logger.error(
          `Solid.Jobs division "${division}" page ${pageIndex} request failed: ${err?.message ?? err}`,
        );
        break;
      }

      if (!data || typeof data !== 'object' || !Array.isArray(data.jobs)) {
        outcome.failures.push({
          division,
          pageIndex,
          diagnostics: new ScrapeDiagnostics(
            'unknown',
            `Solid.Jobs division "${division}" page ${pageIndex} returned an invalid payload (no jobs array)`,
          ),
        });
        this.logger.warn(
          `Solid.Jobs division "${division}" returned an empty or invalid payload (page ${pageIndex})`,
        );
        break;
      }

      let fresh = 0;
      let inWindow = 0;
      for (const offer of data.jobs) {
        if (!isMappable(offer)) {
          this.logger.warn(
            `Skipping malformed Solid.Jobs offer ${
              offer?.jobOfferKey ?? '(no jobOfferKey)'
            }: missing jobOfferKey, title or url`,
          );
          continue;
        }
        // Page drift while paging a newest-first feed repeats an offer.
        if (keys.has(offer.jobOfferKey)) continue;
        keys.add(offer.jobOfferKey);
        fresh++;
        if (isWithinCutoff(offer, cutoffMs)) inWindow++;
        if (!plan.filter || plan.filter.matches(offer)) state.matches.push(offer);
      }

      const totalCount = Number(data.totalCount);
      const totalPages = Number(data.totalPages);
      if (!plan.filter && plan.pageSize !== null && data.totalCount != null && Number.isFinite(totalCount)) {
        state.expected = Math.min(totalCount, pageLimit * plan.pageSize);
      }
      this.logger.log(
        `Solid.Jobs division "${division}" page ${pageIndex} returned ${data.jobs.length} offers` +
          (Number.isFinite(totalCount) && data.totalCount != null ? ` (total ${totalCount})` : ''),
      );
      onProgress();

      if (this.satisfiedThrough(outcome.states, index, plan.need)) break;
      if (plan.pageSize === null) break;
      if (data.jobs.length === 0 || fresh === 0) break;
      if (cutoffMs !== null && inWindow === 0) break;
      const lastPage =
        data.totalPages != null && Number.isFinite(totalPages)
          ? pageIndex + 1 >= totalPages
          : data.jobs.length < plan.pageSize;
      if (lastPage) break;
    }
  }

  /**
   * Turn failures and an exhausted time budget into a diagnostic. A caller
   * that got every job it asked for gets none; failures are logged instead.
   */
  private diagnose(
    count: number,
    resultsWanted: number,
    outcome: ScanOutcome,
    budgetMs: number,
  ): ScrapeDiagnostics | undefined {
    const failed = [...new Set(outcome.failures.map((f) => f.division))];
    if (count >= resultsWanted) {
      if (failed.length > 0) {
        this.logger.warn(
          `Solid.Jobs divisions [${failed.join(', ')}] failed, but ${count} jobs were still collected`,
        );
      }
      return undefined;
    }
    if (outcome.failures.length > 0) {
      const first = outcome.failures[0].diagnostics;
      const detail = [
        first.detail,
        `failed divisions: ${failed.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ');
      return new ScrapeDiagnostics(first.reason, detail);
    }
    if (outcome.budgetHit) {
      const scanned = outcome.states.filter((s) => s.done).length;
      return new ScrapeDiagnostics(
        count === 0 ? 'timeout' : 'partial',
        `time budget ${budgetMs} ms reached; scanned ${scanned}/${outcome.states.length} divisions`,
      );
    }
    return undefined;
  }

  /** Map one offer; a mapping error is logged and skips only that offer. */
  private safeMap(offer: SolidJobsOffer, format?: DescriptionFormat): JobPostDto | null {
    try {
      const job = this.mapJob(offer, format);
      if (!job) {
        this.logger.warn(
          `Skipping malformed Solid.Jobs offer ${
            offer?.jobOfferKey ?? '(no jobOfferKey)'
          }: missing jobOfferKey, title or url`,
        );
      }
      return job;
    } catch (err: any) {
      this.logger.warn(`Error mapping Solid.Jobs offer ${offer?.jobOfferKey}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Map a solid.jobs offer to a JobPostDto.
   */
  private mapJob(
    offer: SolidJobsOffer,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!isMappable(offer)) return null;

    const description = this.buildDescription(offer, format);
    const compensation = this.parseCompensation(offer);
    const jobType = this.parseJobType(offer.contractTime);

    const labels = (Array.isArray(offer.locations) ? offer.locations : []).filter(
      (label): label is string =>
        typeof label === 'string' && label.trim().length > 0 && !isCountryLevelLabel(label),
    );
    const parsedLocations = parseLocationList(labels);
    // Board-level fallback: every offer on the board is in Poland.
    const location = parsedLocations.location
      ? this.withBoardCountry(parsedLocations.location)
      : new LocationDto({ country: Country.POLAND });
    const locations = parsedLocations.locations.map((entry) => this.withBoardCountry(entry));

    const posted = postedTimeFields(postedFromTimestamp(offer.validFrom || offer.updatedAt));

    return new JobPostDto({
      id: `solidjobs-${offer.jobOfferKey}`,
      title: offer.title,
      companyName: offer.company ?? null,
      jobUrl: offer.url,
      location,
      ...(locations.length > 0 ? { locations } : {}),
      countryCode: SOLIDJOBS_COUNTRY_CODE,
      description,
      compensation: compensation ?? undefined,
      jobType: jobType ?? undefined,
      ...posted,
      isRemote: offer.isRemote === true,
      workFromHomeType: this.workFromHomeType(offer, parsedLocations.workFromHomeType),
      employmentType: this.employmentType(offer),
      jobLevel: this.nonEmpty(offer.experienceLevel),
      jobFunction: humaniseCode(offer.category),
      companyLogo: this.companyLogo(offer.companyLogoUrl),
      skills: this.skills(offer),
      emails: extractEmails(description),
      site: Site.SOLIDJOBS,
    });
  }

  /**
   * Render the HTML description according to the requested format:
   * HTML passes the raw markup through, MARKDOWN converts via the
   * shared markdown converter, anything else converts to plain text.
   */
  private buildDescription(
    offer: SolidJobsOffer,
    format?: DescriptionFormat,
  ): string | null {
    const html = offer.description;
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) {
      return markdownConverter(html) ?? html;
    }
    return htmlToPlainText(html);
  }

  /**
   * Parse the salary into a CompensationDto, falling back to the secondary
   * salary when the primary one is absent. Observed wire values: PLN amounts
   * with a "Month" period.
   */
  private parseCompensation(offer: SolidJobsOffer): CompensationDto | null {
    const salary = [offer.salary, offer.secondarySalary].find(
      (candidate): candidate is SolidJobsSalary =>
        !!candidate && (candidate.from != null || candidate.to != null),
    );
    if (!salary) return null;

    const interval = getCompensationInterval(
      (salary.period ?? '').toLowerCase(),
    );

    return new CompensationDto({
      interval: interval ?? undefined,
      minAmount: salary.from ?? null,
      maxAmount: salary.to ?? null,
      currency: salary.currency ?? 'PLN',
    });
  }

  /**
   * Resolve contractTime ("full_time" | "part_time") to a JobType.
   * Underscores are normalised to spaces here; since Spec 1697 the shared
   * alias normaliser also strips underscores, so this is belt and braces.
   */
  private parseJobType(contractTime?: string | null): JobType[] | null {
    return contractTimeJobTypes(contractTime);
  }

  /** Raw board contract codes of both salaries, distinct, e.g. `UZ, B2B`. */
  private employmentType(offer: SolidJobsOffer): string | null {
    const codes: string[] = [];
    for (const salary of [offer.salary, offer.secondarySalary]) {
      const code = typeof salary?.employmentType === 'string' ? salary.employmentType.trim() : '';
      if (code && !codes.some((c) => c.toLowerCase() === code.toLowerCase())) codes.push(code);
    }
    return codes.length > 0 ? codes.join(', ') : null;
  }

  /** Board flags first; neither flag set falls back to the location parser. */
  private workFromHomeType(offer: SolidJobsOffer, parsed: string | null): string | null {
    const remote = offer.isRemote === true;
    const hybrid = offer.isHybrid === true;
    if (remote && hybrid) return 'Hybrid or Remote';
    if (remote) return 'Remote';
    if (hybrid) return 'Hybrid';
    return parsed ?? null;
  }

  /** Skill names, trimmed and de-duplicated case-insensitively, in wire order. */
  private skills(offer: SolidJobsOffer): string[] | undefined {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const skill of Array.isArray(offer.skills) ? offer.skills : []) {
      const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
    }
    return names.length > 0 ? names : undefined;
  }

  private companyLogo(url: string | null | undefined): string | null {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
  }

  private withBoardCountry(location: LocationDto): LocationDto {
    if (location.country == null || location.country === '') location.country = Country.POLAND;
    return location;
  }

  private nonEmpty(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = Number(value);
    return value != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  /** Env flag read on every call: `false` / `0` / `no` / `off` → false. */
  private envFlag(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    return !FALSE_VALUES.has(raw.trim().toLowerCase());
  }

  private searchMode(): SolidJobsSearchMode {
    const raw = (process.env[SOLIDJOBS_SEARCH_MODE_ENV] ?? '').trim().toLowerCase();
    return raw === 'phrase' || raw === 'legacy' ? 'phrase' : 'tokens';
  }

  private timeBudgetMs(): number {
    const raw = Number(process.env[SOLIDJOBS_TIME_BUDGET_ENV]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SOLIDJOBS_TIME_BUDGET_MS;
  }
}
