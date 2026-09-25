import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  Country,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { BrowserPool, createHttpClient, describeUrlForLog, pinUrlToHosts } from '@ever-jobs/common';
import type { Page } from 'playwright';
import {
  PULSESPACE_ALLOWED_HOSTS,
  PULSESPACE_BUNDLE_MARKERS,
  PULSESPACE_CAREERS_URL,
  PULSESPACE_COMPANY_NAME,
  PULSESPACE_DEFAULT_RESULTS,
  PULSESPACE_DEFAULT_STRATEGY,
  PULSESPACE_DEFAULT_TIMEOUT_SECONDS,
  PULSESPACE_DETAIL_SELECTOR,
  PULSESPACE_LIST_SELECTOR,
  PULSESPACE_MAX_BUNDLE_LITERAL_CHARS,
  PULSESPACE_ORIGIN,
  PULSESPACE_READY_TIMEOUT_SECONDS,
  PULSESPACE_STRATEGY_ENV,
  PulsespaceStrategy,
  readPulsespaceStrategy,
} from './pulsespace.constants';

interface PulsespaceDetail {
  title: string;
  subtitle: string;
  locationText: string;
  jobTypeText: string;
  departmentText: string;
  description: string;
}

/** One role in the bundle's `wve` job map (the `bundle` strategy). */
interface PulsespaceJobRecord {
  title: string;
  location: string;
  jobType: string;
  department: string;
  summary?: string | string[];
  responsibilities?: string | string[];
  basicQualifications?: string | string[];
  preferredQualifications?: string | string[];
  competencies?: string | string[];
  closing?: string | string[];
}

@SourcePlugin({
  site: Site.PULSESPACE,
  name: 'Pulse Space',
  category: 'company',
  companyDomains: ['pulsespace.com'],
})
@Injectable()
export class PulsespaceService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(PulsespaceService.name);

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input, this.strategy());
      const out = this.applyInput(jobs, input);
      this.logger.log(`Pulsespace: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Pulsespace scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  /** The strategy from {@link PULSESPACE_STRATEGY_ENV}, read per scrape. */
  private strategy(): PulsespaceStrategy {
    const strategy = readPulsespaceStrategy();
    if (strategy) return strategy;
    this.logger.warn(
      `Pulsespace: unknown ${PULSESPACE_STRATEGY_ENV}=\`${String(process.env[PULSESPACE_STRATEGY_ENV]).slice(0, 40)}\` - using ${PULSESPACE_DEFAULT_STRATEGY}`,
    );
    return PULSESPACE_DEFAULT_STRATEGY;
  }

  /**
   * Run the chosen strategy. `auto` tries the cheap HTTP bundle path first and
   * falls back to the rendered browser path when the bundle yields no jobs or
   * fails; if the fallback fails too, its error is what the caller sees.
   */
  private async fetchJobs(
    input: ScraperInputDto,
    strategy: PulsespaceStrategy,
  ): Promise<JobPostDto[]> {
    if (strategy === 'bundle') return this.fetchBundleJobs(input);
    if (strategy === 'rendered') return this.fetchRenderedJobs(input);

    let bundleOutcome: string;
    try {
      const jobs = await this.fetchBundleJobs(input);
      if (jobs.length > 0) return jobs;
      bundleOutcome = 'returned no jobs';
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      bundleOutcome = `failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`;
    }
    this.logger.log(
      `Pulsespace: bundle strategy ${bundleOutcome}; falling back to the rendered page`,
    );
    return this.fetchRenderedJobs(input);
  }

  /**
   * The caller's `companyUrl` when it is an https URL on pulsespace.com (or a
   * subdomain), otherwise `null`.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does. This matters most
   * for the rendered strategy: the URL is opened in a real Chromium, which runs
   * the page's JavaScript from inside our network. An off-domain, internal or
   * malformed value is ignored and the default board is used.
   */
  private pinnedCompanyUrl(input: ScraperInputDto): string | null {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return null;
    const pinned = pinUrlToHosts(requested, PULSESPACE_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Pulsespace: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${PULSESPACE_ALLOWED_HOSTS.join(', ')}`,
      );
    }
    return pinned;
  }

  // ─── rendered strategy (Spec 5134) ─────────────────────────────────────────

  private async fetchRenderedJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? PULSESPACE_DEFAULT_TIMEOUT_SECONDS) * 1000;
    const startUrl = this.pinnedCompanyUrl(input) ?? PULSESPACE_CAREERS_URL;
    const origin = new URL(startUrl).origin;
    const companyUrl = origin;

    const page = await BrowserPool.getPage({
      proxy,
      stealth: true,
      headful: true,
    });

    try {
      const listHtml = await this.fetchHtml(
        startUrl,
        page,
        timeoutMs,
        PULSESPACE_LIST_SELECTOR,
      );
      const detailUrls = this.parseListLinks(listHtml, origin);
      if (detailUrls.length === 0) {
        this.logger.warn('Pulsespace: no /careers/<slug> links rendered');
        return [];
      }

      // With no filter active, `applyInput` keeps only `offset + wanted`
      // jobs, so rendering more detail pages than that is wasted browser time.
      const budget = this.unfilteredBudget(input);
      const jobs: JobPostDto[] = [];
      for (const detailUrl of detailUrls) {
        if (budget !== null && jobs.length >= budget) break;
        const detailHtml = await this.fetchHtml(
          detailUrl,
          page,
          timeoutMs,
          PULSESPACE_DETAIL_SELECTOR,
        );
        const job = this.buildRenderedJob(detailUrl, detailHtml, companyUrl);
        if (job) {
          jobs.push(job);
        }
      }
      return jobs;
    } finally {
      await this.closeOwnPage(page);
    }
  }

  protected async fetchHtml(
    url: string,
    page?: Page,
    timeoutMs?: number,
    waitSelector?: string,
  ): Promise<string> {
    const timeout = timeoutMs ?? PULSESPACE_DEFAULT_TIMEOUT_SECONDS * 1000;
    const ready = waitSelector ?? 'main';

    if (page) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page
        .waitForSelector(ready, {
          timeout: PULSESPACE_READY_TIMEOUT_SECONDS * 1000,
        })
        .catch(() => undefined);
      return page.content();
    }

    const p = await BrowserPool.getPage({ stealth: true, headful: true });
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await p
        .waitForSelector(ready, {
          timeout: PULSESPACE_READY_TIMEOUT_SECONDS * 1000,
        })
        .catch(() => undefined);
      return p.content();
    } finally {
      await this.closeOwnPage(p);
    }
  }

  /**
   * Close a page this plugin opened, and its context when that context is the
   * page's own: a non-persistent context (`browser()` non-null, e.g. with
   * `EVER_JOBS_BROWSER_HEADFUL=false`) leaked on every scrape before. A
   * persistent (headful) context is shared by every plugin with the same
   * launch identity, so it is left to `BrowserPool`.
   */
  private async closeOwnPage(page: Page): Promise<void> {
    const context = page.context();
    await page.close().catch(() => undefined);
    if (context.browser() !== null) {
      await context.close().catch(() => undefined);
    }
  }

  /**
   * `/careers/<slug>` links on the rendered list, resolved and kept only when
   * they are on the list page's own origin (Spec 1689) — the browser navigates
   * to each one, so a link to another host is never followed.
   */
  private parseListLinks(html: string, origin: string): string[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const urls: string[] = [];

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href')?.trim() ?? '';
      if (!/^\/careers\/[^/?#]+/.test(href) && !/^https?:\/\/[^/]+\/careers\/[^/?#]+/.test(href)) {
        return;
      }
      const url = this.resolveUrl(href, origin);
      if (!url || !this.isSameOrigin(url, origin)) {
        return;
      }
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    });

    return urls;
  }

  private isSameOrigin(url: string, origin: string): boolean {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  }

  /**
   * How many jobs the crawl may stop at, or `null` when a filter is active.
   *
   * `applyInput` runs after every detail page has been rendered, so with no
   * filter in play the crawl can stop as soon as it holds `offset + wanted`
   * jobs. With a filter, a job that survives it may be on any later page.
   */
  private unfilteredBudget(input: ScraperInputDto): number | null {
    const filtered =
      !!this.normalize(input.searchTerm) ||
      !!this.normalize(input.location) ||
      input.isRemote === true ||
      !!input.jobType;
    if (filtered) {
      return null;
    }
    return (
      this.nonNegativeInt(input.offset, 0) +
      this.nonNegativeInt(input.resultsWanted, PULSESPACE_DEFAULT_RESULTS)
    );
  }

  private parseDetail(html: string): PulsespaceDetail | null {
    const $ = cheerio.load(html);
    const found = $('main').first();
    const main = (found.length ? found : $('html').first()) as cheerio.Cheerio<any>;

    const title = this.normalize(main.find('h1').first().text());
    if (!title) {
      return null;
    }

    const subtitle = this.normalize(
      main.find('h1').first().nextAll('p').first().text(),
    );

    // Icon badges: each span pairs a lucide svg with its text. Order on the
    // page is location, employment type, department — the svg class names are
    // the stable signal.
    let locationText = '';
    let jobTypeText = '';
    let departmentText = '';
    const fallback: string[] = [];
    main.find('span').each((_i, el) => {
      const span = $(el);
      const svgClass = span.find('svg').first().attr('class') ?? '';
      const text = this.normalize(span.clone().children().remove().end().text())
        || this.normalize(span.text());
      if (!text || !svgClass) {
        return;
      }
      fallback.push(text);
      if (/map-pin/i.test(svgClass)) {
        locationText = locationText || text;
      } else if (/briefcase/i.test(svgClass)) {
        jobTypeText = jobTypeText || text;
      } else if (/building2|building/i.test(svgClass)) {
        departmentText = departmentText || text;
      }
    });
    if (!locationText && fallback.length > 0) {
      locationText = fallback[0];
    }
    if (!jobTypeText && fallback.length > 1) {
      jobTypeText = fallback[1];
    }
    if (!departmentText && fallback.length > 2) {
      departmentText = fallback[2];
    }

    // Body: each h2 heads a section whose container holds paragraphs or a ul.
    const sections: string[] = [];
    if (subtitle) {
      sections.push(subtitle);
    }
    main.find('h2').each((_i, el) => {
      const heading = this.normalize($(el).text());
      if (!heading) {
        return;
      }
      const container = $(el).next();
      const items: string[] = [];
      container.find('li').each((_j, li) => {
        const text = this.normalize($(li).text());
        if (text) {
          items.push(`- ${text}`);
        }
      });
      if (items.length === 0) {
        container.find('p').each((_j, p) => {
          const text = this.normalize($(p).text());
          if (text) {
            items.push(text);
          }
        });
      }
      if (items.length > 0) {
        sections.push(`## ${heading}\n\n${items.join('\n\n')}`);
      }
    });

    return {
      title,
      subtitle,
      locationText,
      jobTypeText,
      departmentText,
      description: sections.join('\n\n'),
    };
  }

  private buildRenderedJob(
    detailUrl: string,
    html: string,
    companyUrl: string,
  ): JobPostDto | null {
    const detail = this.parseDetail(html);
    if (!detail) {
      return null;
    }

    const slugMatch = detailUrl.match(/\/careers\/([^/?#]+)/);
    const slug = slugMatch ? slugMatch[1] : this.slugify(detail.title);
    if (!slug) {
      return null;
    }

    const jobTypes = this.buildJobTypes(detail.jobTypeText, detail.title);
    const employmentType = this.buildEmploymentType(jobTypes);
    const { isRemote, workFromHomeType } = this.parseWorkFromHomeType(
      [detail.locationText, detail.jobTypeText, detail.description].filter(
        (t): t is string => Boolean(t),
      ),
    );
    const location = this.parseLocation(detail.locationText);

    return new JobPostDto({
      id: `pulsespace-${slug}`,
      site: Site.PULSESPACE,
      title: detail.title,
      companyName: PULSESPACE_COMPANY_NAME,
      companyUrl,
      jobUrl: detailUrl,
      jobUrlDirect: detailUrl,
      location,
      isRemote,
      workFromHomeType: workFromHomeType ?? undefined,
      jobType: jobTypes,
      employmentType,
      department: detail.departmentText || undefined,
      description: detail.description,
    });
  }

  private slugify(text: string): string {
    return this.normalize(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ─── bundle strategy (pre-Spec-5134, restored by Spec 1689) ───────────────

  /**
   * Plain HTTP: fetch the careers shell, find the main Vite bundle, and parse
   * its `wve` job map. Two requests and no browser; stopped matching live
   * after the site rebuild (Spec 5134) but kept so it can be chosen again.
   */
  private async fetchBundleJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? PULSESPACE_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: PULSESPACE_ALLOWED_HOSTS,
    });

    const requested = this.pinnedCompanyUrl(input);
    const fetchUrl = requested ?? PULSESPACE_CAREERS_URL;
    const companyUrl = requested ?? PULSESPACE_ORIGIN;
    const origin = new URL(fetchUrl).origin;

    const listingRes = await client.get<string>(fetchUrl);
    const $ = cheerio.load(String(listingRes.data ?? ''));
    const bundleUrl = this.resolveBundleUrl($, origin);
    if (!bundleUrl) {
      this.logger.warn('Pulsespace: no main JS bundle found in careers page');
      return [];
    }

    const bundleRes = await client.get<string>(bundleUrl);
    const wve = this.parseWveObject(String(bundleRes.data ?? ''));
    if (!wve || typeof wve !== 'object' || Array.isArray(wve)) {
      this.logger.warn('Pulsespace: could not parse careers data from bundle');
      return [];
    }

    const records = Object.entries(wve).sort(([a], [b]) => a.localeCompare(b));
    return records
      .map(([slug, record]) => this.buildBundleJob(slug, record, origin, companyUrl))
      .filter((job): job is JobPostDto => Boolean(job));
  }

  /**
   * The main bundle's URL, resolved against the shell's origin and kept only
   * when it is https on pulsespace.com (Spec 1689) — the shell is third-party
   * HTML, so an absolute `src` elsewhere is not fetched.
   */
  private resolveBundleUrl($: cheerio.CheerioAPI, origin: string): string | null {
    const src = $('script[src*="/assets/index-"][src$=".js"]')
      .first()
      .attr('src');
    if (!src) {
      return null;
    }
    const resolved = this.resolveUrl(src, origin);
    const pinned = pinUrlToHosts(resolved, PULSESPACE_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.warn(
        `Pulsespace: ignoring bundle \`${src.slice(0, 200)}\` - not on ${PULSESPACE_ALLOWED_HOSTS.join(', ')}`,
      );
    }
    return pinned;
  }

  private parseWveObject(source: string): unknown {
    for (const marker of PULSESPACE_BUNDLE_MARKERS) {
      const parsed = this.parseJsObjectLiteral(source, marker);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  private parseJsObjectLiteral(source: string, marker: string): unknown {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }
    const start = source.indexOf('{', markerIndex);
    if (start === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    const limit = Math.min(source.length, start + PULSESPACE_MAX_BUNDLE_LITERAL_CHARS);
    for (let i = start; i < limit; i++) {
      const c = source[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
      } else {
        if (c === '"') {
          inString = true;
        } else if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
    }
    if (end === -1) {
      return null;
    }

    const objectString = source.slice(start, end + 1);
    try {
      const json = this.quoteUnquotedKeys(objectString);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private quoteUnquotedKeys(jsObject: string): string {
    let out = '';
    let inString = false;
    let escape = false;
    let i = 0;
    while (i < jsObject.length) {
      const c = jsObject[i];
      if (inString) {
        out += c;
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
        i++;
        continue;
      }
      if (c === '"') {
        inString = true;
        out += c;
        i++;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < jsObject.length && /[A-Za-z0-9_$]/.test(jsObject[j])) {
          j++;
        }
        const ident = jsObject.slice(i, j);
        let k = j;
        while (k < jsObject.length && /\s/.test(jsObject[k])) {
          k++;
        }
        if (jsObject[k] === ':') {
          out += `"${ident}":`;
          i = k + 1;
          continue;
        }
        out += ident;
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  private buildBundleJob(
    slug: string,
    record: unknown,
    origin: string,
    companyUrl: string,
  ): JobPostDto | null {
    if (!this.isJobRecord(record)) {
      return null;
    }

    const title = this.normalize(record.title);
    if (!title) {
      return null;
    }

    const jobUrl = this.resolveUrl(`/careers/${slug}`, origin);
    if (!jobUrl) {
      return null;
    }

    const jobTypes = this.buildJobTypes(record.jobType, title);
    const employmentType = this.buildEmploymentType(jobTypes);
    const description = this.buildBundleDescription(record);
    const { isRemote, workFromHomeType } = this.parseWorkFromHomeType(
      [record.location, record.jobType, description].filter((t): t is string => Boolean(t)),
    );
    const location = this.parseLocation(record.location);

    return new JobPostDto({
      id: `pulsespace-${slug}`,
      site: Site.PULSESPACE,
      title,
      companyName: PULSESPACE_COMPANY_NAME,
      companyUrl,
      jobUrl,
      jobUrlDirect: jobUrl,
      location,
      isRemote,
      workFromHomeType: workFromHomeType ?? undefined,
      jobType: jobTypes,
      employmentType,
      department: this.normalize(record.department) || undefined,
      description,
    });
  }

  private isJobRecord(value: unknown): value is PulsespaceJobRecord {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as PulsespaceJobRecord).title === 'string' &&
      typeof (value as PulsespaceJobRecord).location === 'string'
    );
  }

  private buildBundleDescription(record: PulsespaceJobRecord): string {
    const sections: string[] = [];
    const add = (heading: string, body?: string | string[]) => {
      if (body === undefined || body === null) {
        return;
      }
      const parts = Array.isArray(body) ? body : [body];
      const lines = parts.map((p) => `- ${this.normalize(p)}`).filter(Boolean);
      if (lines.length === 0) {
        return;
      }
      sections.push(`## ${heading}\n\n${lines.join('\n\n')}`);
    };

    add('Position Summary', record.summary);
    add('Key Responsibilities', record.responsibilities);
    add('Basic Qualifications', record.basicQualifications);
    add('Preferred Qualifications', record.preferredQualifications);
    add('Competencies', record.competencies);
    if (typeof record.closing === 'string' && record.closing.trim()) {
      sections.push(`## Closing\n\n${this.normalize(record.closing)}`);
    }

    return this.normalize(sections.join('\n\n'));
  }

  // ─── shared helpers ────────────────────────────────────────────────────────

  private parseWorkFromHomeType(texts: string[]): {
    isRemote: boolean;
    workFromHomeType: string | null;
  } {
    const source = texts.join(' ').toLowerCase();
    if (source.includes('hybrid')) {
      return { isRemote: false, workFromHomeType: 'Hybrid' };
    }
    if (/\bremote\b/.test(source)) {
      return { isRemote: true, workFromHomeType: 'Remote' };
    }
    if (/\b(?:on[- ]?site|in[- ]?person|in[- ]?office)\b/.test(source)) {
      return { isRemote: false, workFromHomeType: 'On Site' };
    }
    return { isRemote: false, workFromHomeType: null };
  }

  private buildJobTypes(text: string | null, title: string): JobType[] {
    const out: JobType[] = [];
    const source = `${text ?? ''} ${title}`;
    const tokens = this.extractJobTypeTokens(source);
    for (const token of tokens) {
      const normalized = token.toLowerCase().replace(/[\s/-]/g, '');
      const jobType = getJobTypeFromString(
        normalized === 'intern' ? 'internship' : normalized,
      );
      if (jobType && !out.includes(jobType)) {
        out.push(jobType);
      }
    }
    if (out.length === 0) {
      out.push(JobType.FULL_TIME);
    }
    return out;
  }

  private extractJobTypeTokens(text: string): string[] {
    const matches = text.match(
      /\b(?:full[- ]?time|part[- ]?time|contract(?:or)?|temporary|intern(?:ship)?|freelance|per[- ]?diem)\b/gi,
    );
    return matches ?? [];
  }

  private buildEmploymentType(jobTypes: JobType[]): string {
    if (jobTypes.length === 1) {
      switch (jobTypes[0]) {
        case JobType.FULL_TIME:
          return 'Full time';
        case JobType.PART_TIME:
          return 'Part time';
        case JobType.CONTRACT:
          return 'Contract';
        case JobType.TEMPORARY:
          return 'Temporary';
        case JobType.INTERNSHIP:
          return 'Internship';
        default:
          return 'Full time';
      }
    }
    return jobTypes.map((jobType) => this.jobTypeLabel(jobType)).join(' | ');
  }

  private jobTypeLabel(jobType: JobType): string {
    switch (jobType) {
      case JobType.FULL_TIME:
        return 'Full time';
      case JobType.PART_TIME:
        return 'Part time';
      case JobType.CONTRACT:
        return 'Contract';
      case JobType.TEMPORARY:
        return 'Temporary';
      case JobType.INTERNSHIP:
        return 'Internship';
      case JobType.PER_DIEM:
        return 'Per diem';
      case JobType.NIGHTS:
        return 'Nights';
      case JobType.OTHER:
        return 'Other';
      case JobType.SUMMER:
        return 'Summer';
      case JobType.VOLUNTEER:
        return 'Volunteer';
      default:
        return String(jobType);
    }
  }

  private parseLocation(text: string | null): LocationDto | null {
    if (!text) {
      return null;
    }
    const normalized = this.normalize(text);
    const match = normalized.match(/^([^,]+?)\s*,\s*([A-Za-z]{2})\b/);
    if (match) {
      return new LocationDto({
        city: this.toTitleCase(this.normalize(match[1])),
        state: match[2].toUpperCase(),
        country: Country.USA,
      });
    }
    return new LocationDto({ city: normalized, country: Country.USA });
  }

  private resolveUrl(href: string, origin: string): string | null {
    const trimmed = this.normalize(href);
    if (!trimmed) {
      return null;
    }
    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
      return trimmed;
    }
    const base = origin.replace(/\/$/, '');
    if (trimmed.startsWith('/')) {
      return `${base}${trimmed}`;
    }
    return `${base}/${trimmed}`;
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.description].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
      );
    }

    const locationTerm = this.normalize(input.location).toLowerCase();
    if (locationTerm) {
      filtered = filtered.filter((job) =>
        this.normalize(job.location?.displayLocation())
          .toLowerCase()
          .includes(locationTerm),
      );
    }

    if (input.isRemote === true) {
      filtered = filtered.filter((job) => job.isRemote === true);
    }

    if (input.jobType) {
      filtered = filtered.filter((job) =>
        job.jobType?.includes(input.jobType as JobType),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(
      input.resultsWanted,
      PULSESPACE_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private toTitleCase(value: string): string {
    return value
      .toLowerCase()
      .split(/([\s\-]+)/)
      .map((part) => (part.match(/^[\s\-]+$/) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('');
  }

  private normalize(value: unknown): string {
    return typeof value === 'string'
      ? value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
      : '';
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private errorLabel(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return 'unknown error';
    }
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') {
      return `HTTP ${status}`;
    }
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
