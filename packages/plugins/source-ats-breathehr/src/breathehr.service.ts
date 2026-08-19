import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  BREATHEHR_ROOT_DOMAIN,
  BREATHEHR_VACANCY_HOST,
  BREATHEHR_VACANCY_PATH_PREFIX,
  BREATHEHR_VACANCY_LINK_REGEX,
  BREATHEHR_VACANCY_TOKEN_REGEX,
  BREATHEHR_VACANCY_ID_REGEX,
  BREATHEHR_DEFAULT_RESULTS,
  BREATHEHR_MAX_PAGES,
  BREATHEHR_DEFAULT_TIMEOUT_SECONDS,
  BREATHEHR_HEADERS,
  BREATHEHR_REMOTE_REGEX,
  breathehrVacancyUrl,
} from './breathehr.constants';
import { BreatheHrJob, BreatheHrVacancyPage, BreatheHrVacancyRef } from './breathehr.types';

/**
 * Breathe HR ATS careers scraper — generic, multi-tenant.
 *
 * Breathe (breathehr.com — a UK SMB people-management / HR suite with a built-in recruitment
 * module) lets each customer publish public, unauthenticated, candidate-facing vacancies on the
 * shared, Breathe-owned host `https://hr.breathehr.com/v/{slug}-{id}`, where `{slug}` is the
 * de-slugified role title and the trailing `{id}` is the tenant's stable numeric recruitment
 * vacancy id (the ATS id). Each `/v/{slug}-{id}` page is a server-rendered HTML document carrying
 * the role's structured fields in stable, class-named markup (`.job-title`, `.vacancy-company`,
 * `.salary`, `.location`, the two `.vacancy-date` blocks, and the `.trix-content` body).
 *
 * Breathe does not host a public, anonymous per-tenant vacancy INDEX (the tenant sub-domain and
 * the recruitment management board both redirect to login), so tenants surface their open roles
 * by embedding the `/v/{slug}-{id}` share links on their OWN public careers page. The adapter
 * therefore addresses a tenant by `companyUrl` (the tenant's own careers / vacancies page) and
 * harvests every `hr.breathehr.com/v/{slug}-{id}` link from it, then fetches and parses each
 * vacancy detail page. A `companySlug` that is itself a `/v/{slug}-{id}` share URL (or a bare
 * `{slug}-{id}` vacancy token) is fetched directly as a single vacancy.
 *
 * An unknown tenant, a careers page with no embedded Breathe links, or an empty / removed
 * vacancy degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a single bad
 * tenant never nukes a batch run. A transport-level failure on the careers page (host
 * unreachable) aborts the harvest; an HTTP error / malformed page degrades to an empty list.
 */
@SourcePlugin({
  site: Site.BREATHEHR,
  name: 'Breathe HR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BreatheHrService implements IScraper {
  private readonly logger = new Logger(BreatheHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Breathe HR scraper');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive host degrades gracefully fast rather than
    // hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys off
    // `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter timeout; we
    // only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? BREATHEHR_DEFAULT_TIMEOUT_SECONDS,
      BREATHEHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(BREATHEHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? BREATHEHR_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      // Step 1: resolve the set of vacancy references the caller is asking for.
      //  - A direct `/v/{slug}-{id}` URL or bare `{slug}-{id}` token in `companySlug` resolves to
      //    a single vacancy.
      //  - Otherwise a `companyUrl` (or a `companySlug` URL) is the tenant's own careers page; we
      //    harvest every embedded `hr.breathehr.com/v/{slug}-{id}` share link from it.
      const refs = await this.resolveVacancyRefs(client, companySlug, input.companyUrl);
      if (refs.length === 0) {
        this.logger.warn('No Breathe HR vacancies resolved from input');
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      const wanted = refs
        .filter((ref) => !seen.has(ref.vacancyId) && seen.add(ref.vacancyId))
        .slice(0, Math.min(resultsWanted, BREATHEHR_MAX_PAGES));

      this.logger.log(`Fetching ${wanted.length} Breathe HR vacancy page(s)`);

      // Step 2: fetch + parse each per-role detail page and map it.
      for (const ref of wanted) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const result = await this.fetchVacancy(client, ref);
          if (!result.hostReachable) break; // host down → stop draining
          const page = result.page;
          if (!page) continue; // HTTP error / unparseable → skip this role
          const post = this.processPage(ref, page, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Breathe HR vacancy ${ref.vacancyId}: ${err.message}`);
        }
      }

      this.logger.log(`Breathe HR total: ${jobPosts.length} jobs`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Breathe HR scrape error: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Resolve the vacancy references to fetch. A direct vacancy URL / token in `companySlug` yields
   * one ref; otherwise the careers page (`companyUrl`, or a `companySlug` that is a URL) is
   * fetched and every embedded Breathe share link is harvested. Never throws.
   */
  private async resolveVacancyRefs(
    client: ReturnType<typeof createHttpClient>,
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): Promise<BreatheHrVacancyRef[]> {
    // A directly-supplied vacancy URL or bare token resolves to a single role.
    const direct = this.directVacancyRef(companySlug) ?? this.directVacancyRef(companyUrl);
    if (direct) return [direct];

    // Otherwise treat the input as the tenant's own careers / vacancies page and harvest links.
    const careersUrl = this.careersUrl(companySlug, companyUrl);
    if (!careersUrl) return [];

    const result = await this.fetchCareersPage(client, careersUrl);
    if (!result.hostReachable || !result.html) return [];
    return this.harvestVacancyLinks(result.html);
  }

  /**
   * Recognise a direct per-role vacancy reference in a value: either a full
   * `hr.breathehr.com/v/{slug}-{id}` URL or a bare `{slug}-{id}` token. Returns null when the
   * value is not a single-vacancy reference.
   */
  private directVacancyRef(value: string | undefined): BreatheHrVacancyRef | null {
    const raw = this.cleanText(value);
    if (!raw) return null;

    // Full vacancy URL.
    if (/^https?:\/\//i.test(raw) || raw.includes(`${BREATHEHR_VACANCY_HOST}/v/`)) {
      const token = this.tokenFromVacancyUrl(raw);
      if (token) return this.refFromToken(token);
      return null;
    }

    // Bare `{slug}-{id}` token.
    if (BREATHEHR_VACANCY_TOKEN_REGEX.test(raw)) {
      return this.refFromToken(raw);
    }
    return null;
  }

  /** Build a vacancy ref from a `{slug}-{id}` token, or null when no trailing id is present. */
  private refFromToken(token: string): BreatheHrVacancyRef | null {
    const idMatch = BREATHEHR_VACANCY_ID_REGEX.exec(token);
    if (!idMatch) return null;
    return {
      url: breathehrVacancyUrl(token),
      token,
      vacancyId: idMatch[1],
    };
  }

  /**
   * Extract the `{slug}-{id}` token from a `hr.breathehr.com/v/{slug}-{id}` URL. Returns null for
   * a non-vacancy URL or a path without a trailing numeric id.
   */
  private tokenFromVacancyUrl(value: string): string | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(BREATHEHR_ROOT_DOMAIN)) return null;
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const vIdx = segments.findIndex((s) => s.toLowerCase() === 'v');
      if (vIdx >= 0 && segments[vIdx + 1]) {
        const token = decodeURIComponent(segments[vIdx + 1]);
        if (BREATHEHR_VACANCY_TOKEN_REGEX.test(token)) return token;
      }
    } catch {
      // Malformed URL — no token.
    }
    return null;
  }

  /**
   * Resolve the tenant's careers-page URL to harvest. Prefers an explicit `companyUrl`; a
   * `companySlug` that is a URL is used as the careers page too. A bare non-URL `companySlug` is
   * not a careers page (we cannot synthesise a tenant's own site), so it yields no URL.
   */
  private careersUrl(companySlug: string | undefined, companyUrl: string | undefined): string {
    const url = this.cleanText(companyUrl);
    if (url) return this.normaliseUrl(url);
    const slug = this.cleanText(companySlug);
    if (slug && /^https?:\/\//i.test(slug)) return this.normaliseUrl(slug);
    if (slug && slug.includes('.') && slug.includes('/')) return this.normaliseUrl(slug);
    return '';
  }

  /** Ensure a URL has an explicit scheme. */
  private normaliseUrl(value: string): string {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  /**
   * GET the tenant's careers page as HTML. Returns `{ html, hostReachable }`:
   *  - `html` is the page body, or null when the host answered an HTTP error status (4xx / 5xx —
   *    a real, reachable host) or sent no usable body.
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout). Never throws.
   */
  private async fetchCareersPage(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<{ html: string | null; hostReachable: boolean }> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return { html: html || null, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Breathe HR careers page returned HTTP ${status} for ${url}`);
        return { html: null, hostReachable: true };
      }
      this.logger.warn(`Breathe HR careers page fetch failed for ${url}: ${err?.message ?? err}`);
      return { html: null, hostReachable: false };
    }
  }

  /**
   * Harvest every `hr.breathehr.com/v/{slug}-{id}` share link from a careers page, deduped by
   * vacancy id, preserving first-seen order.
   */
  private harvestVacancyLinks(html: string): BreatheHrVacancyRef[] {
    const refs: BreatheHrVacancyRef[] = [];
    const seen = new Set<string>();
    const regex = new RegExp(BREATHEHR_VACANCY_LINK_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const token = match[1];
      const ref = this.refFromToken(token);
      if (!ref) continue;
      if (seen.has(ref.vacancyId)) continue;
      seen.add(ref.vacancyId);
      refs.push(ref);
    }
    return refs;
  }

  /**
   * GET one per-role vacancy detail page as HTML and parse it. Returns `{ page, hostReachable }`:
   *  - `page` is the parsed page fields, or null when the host answered an HTTP error status
   *    (e.g. a closed / removed role 404s) or sent no usable body.
   *  - `hostReachable` is false ONLY for a transport-level failure. Never throws.
   */
  private async fetchVacancy(
    client: ReturnType<typeof createHttpClient>,
    ref: BreatheHrVacancyRef,
  ): Promise<{ page: BreatheHrVacancyPage | null; hostReachable: boolean }> {
    try {
      const response = await client.get<string>(ref.url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) return { page: null, hostReachable: true };
      return { page: this.parseVacancy(html), hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Breathe HR vacancy ${ref.vacancyId} returned HTTP ${status}`);
        return { page: null, hostReachable: true };
      }
      this.logger.warn(`Breathe HR vacancy ${ref.vacancyId} fetch failed: ${err?.message ?? err}`);
      return { page: null, hostReachable: false };
    }
  }

  /** Parse a `/v/{slug}-{id}` detail page's HTML into raw page fields. Never throws. */
  private parseVacancy(html: string): BreatheHrVacancyPage {
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(html);
    } catch {
      return {};
    }

    const title = this.cleanText($('.job-title').first().text());
    const companyRaw = this.cleanText($('.vacancy-company').first().text());
    const company = this.stripVacancyAtPrefix(companyRaw);
    const pageTitle = this.cleanText($('title').first().text());
    const salary = this.parseSalary($('.salary').first().text());
    const location = this.cleanText($('.location').first().text());
    const canonicalUrl = this.cleanText($('meta[property="og:url"]').attr('content'));

    // The two `.vacancy-date` blocks are labelled by a leading <strong> ("Vacancy listed" /
    // "Application deadline"); read the value text after stripping the label.
    let listedDate: string | null = null;
    let deadlineDate: string | null = null;
    $('.vacancy-date').each((_i, el) => {
      const block = $(el);
      const label = this.cleanText(block.find('strong').first().text());
      const value = this.cleanText(block.clone().children('strong').remove().end().text());
      if (!label) return;
      const lower = label.toLowerCase();
      if (lower.includes('listed') && !listedDate) listedDate = value;
      else if (lower.includes('deadline') && !deadlineDate) deadlineDate = value;
    });

    // The description body is the `.trix-content` block; fall back to the detail subsections.
    const trix = $('.trix-content').first();
    let descriptionHtml: string | null = null;
    if (trix.length > 0) {
      descriptionHtml = this.trimText(trix.html());
    }
    if (!descriptionHtml) {
      const details = $('.vacancy-subsection-details').first();
      if (details.length > 0) descriptionHtml = this.trimText(details.html());
    }

    return {
      title,
      company,
      pageTitle,
      salary,
      location,
      listedDate,
      deadlineDate,
      descriptionHtml,
      canonicalUrl,
    };
  }

  /** Map a parsed vacancy page → JobPostDto, anchored on the ref's stable vacancy id. */
  private processPage(
    ref: BreatheHrVacancyRef,
    page: BreatheHrVacancyPage,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normalisePage(ref, page);
    return this.processJob(job, format);
  }

  /** Build a normalised BreatheHrJob from a parsed page. */
  private normalisePage(ref: BreatheHrVacancyRef, page: BreatheHrVacancyPage): BreatheHrJob {
    const url = this.cleanText(page.canonicalUrl) ?? ref.url;
    const title = this.cleanText(page.title);
    const locationText = this.cleanText(page.location);
    const descriptionHtml = this.trimText(page.descriptionHtml);
    const salary = this.cleanText(page.salary);

    return {
      atsId: ref.vacancyId,
      url,
      // The detail page hosts the apply flow inline; the canonical apply URL is the detail URL.
      applyUrl: url,
      title,
      companyName: this.cleanText(page.company) ?? this.deriveCompanyName(page.pageTitle),
      locationText,
      descriptionHtml,
      salary,
      datePosted: this.parseUkDate(page.listedDate),
      isRemote: this.detectRemote(title, locationText, descriptionHtml),
    };
  }

  /** Map a normalised BreatheHrJob → JobPostDto. */
  private processJob(job: BreatheHrJob, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? null;
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `breathehr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.BREATHEHR,
      atsId,
      atsType: 'breathehr',
      department: null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Breathe exposes the body as HTML,
   * so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Surface the role's free-text location as a LocationDto. Breathe carries a single free-text
   * location line (e.g. "Glasgow/ Hybrid", "Edinburgh"); the leading comma-or-slash-separated
   * segment is treated as the city, with the remainder kept as the region. Returns null when no
   * usable location text is present.
   */
  private extractLocation(job: BreatheHrJob): LocationDto | null {
    const text = this.cleanText(job.locationText);
    if (!text) return null;
    const parts = text
      .split(/[,/]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length === 0) return null;
    const city = parts[0] ?? null;
    const region = parts.length > 1 ? parts.slice(1).join(', ') : null;
    return new LocationDto({ city, state: region, country: null });
  }

  /** Detect remote / home-working roles from the title, location, or description text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    description: string | null,
  ): boolean {
    const haystacks: Array<string | null> = [title, location, description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (BREATHEHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Strip the leading "Vacancy at " label Breathe prepends to the `.vacancy-company` text,
   * leaving the bare employer name.
   */
  private stripVacancyAtPrefix(value: string | null): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return this.cleanText(cleaned.replace(/^vacancy\s+at\s+/i, '')) ?? cleaned;
  }

  /** Strip the leading "Salary" label from the salary block text. */
  private parseSalary(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return this.cleanText(cleaned.replace(/^salary\s*/i, '')) ?? null;
  }

  /**
   * De-slugify + title-case a page-title token into a display company name (a fallback when the
   * `.vacancy-company` label is absent). Returns null for empty input.
   */
  private deriveCompanyName(value: string | null | undefined): string | null {
    const base = this.cleanText(value);
    if (!base) return null;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Parse a Breathe UK-format date (`DD/MM/YYYY`) into a YYYY-MM-DD string. A non-matching /
   * unparseable value yields null.
   */
  private parseUkDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(cleaned);
    if (m) {
      const day = m[1].padStart(2, '0');
      const month = m[2].padStart(2, '0');
      const year = m[3];
      const iso = `${year}-${month}-${day}`;
      const parsed = new Date(iso);
      if (!isNaN(parsed.getTime())) return iso;
    }
    // Fall back to a permissive parse for any other absolute date shape.
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    return null;
  }

  /**
   * Trim a string and collapse internal whitespace runs (for short single-line fields like the
   * title, company, location). Returns null for empty / non-string values.
   */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }

  /**
   * Trim a string WITHOUT collapsing internal whitespace (for the HTML description body, where
   * collapsing would flatten the markup). Returns null for empty / non-string values.
   */
  private trimText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
