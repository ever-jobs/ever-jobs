import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
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
  BEETWEEN_PORTAL_HOST,
  BEETWEEN_PORTAL_PATH_TEMPLATE,
  BEETWEEN_OFFER_LINK_REGEX,
  BEETWEEN_INLINE_STATE_REGEX,
  BEETWEEN_DEFAULT_RESULTS,
  BEETWEEN_DEFAULT_TIMEOUT_SECONDS,
  BEETWEEN_HEADERS,
} from './beetween.constants';
import {
  BeetweenJob,
  BeetweenStatePayload,
  BeetweenScrapedOffer,
} from './beetween.types';

/**
 * Beetween ATS careers scraper — generic, multi-tenant.
 *
 * Beetween (beetween.com, France) serves every customer's open roles through a
 * public, unauthenticated career portal — either the Beetween-hosted page at
 * `https://emploi.beetween.com/WeaselWeb/p/{tenant}` or a tenant vanity career
 * domain. Each open role is addressed by a Beetween "public id" (a 10–20 char
 * lower-case alphanumeric token), exposed publicly at `/poste/{publicId}-{slug}/`.
 *
 * The caller addresses a tenant by `companySlug` (the portal path segment) or by
 * `companyUrl` (a vanity career domain). The adapter fetches the tenant career
 * page ONCE and harvests the open-role references: any inlined JSON hydration
 * blob is parsed first; otherwise the server-rendered `/poste/{publicId}-{slug}/`
 * offer links are scraped from the HTML. The list is sliced client-side to
 * honour `resultsWanted` and de-duplicated by public id.
 *
 * A single fetch error, an unknown tenant (HTTP 4xx), or a malformed payload
 * degrades to an empty result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.BEETWEEN,
  name: 'Beetween',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BeetweenService implements IScraper {
  private readonly logger = new Logger(BeetweenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Beetween scraper');
      return new JobResponseDto([]);
    }

    const { tenant, careerUrl } = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant && !careerUrl) {
      this.logger.warn('Could not resolve a Beetween tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      // Bound the per-request timeout so an unresponsive Beetween portal host
      // (emploi.beetween.com can connect-then-hang) degrades gracefully fast
      // rather than hanging on the shared client's 60s default. NOTE: the
      // createHttpClient factory keys off `requestTimeout` (in seconds) — passing
      // `timeout` here is silently ignored whenever proxies/requestTimeout select
      // the factory's first branch, so we must set `requestTimeout` explicitly.
      // NOTE: ScraperInputDto defaults requestTimeout to 60s, so a plain
      // `?? fallback` never triggers — we must CAP it. The Beetween portal host
      // (emploi.beetween.com) can connect-then-hang; capping at 15s keeps the
      // graceful-degradation path well inside callers' budgets (a healthy tenant
      // responds in well under a second). A caller may still request a SHORTER
      // timeout; we only bound the upper end.
      requestTimeout: Math.min(
        input.requestTimeout ?? BEETWEEN_DEFAULT_TIMEOUT_SECONDS,
        BEETWEEN_DEFAULT_TIMEOUT_SECONDS,
      ),
    });
    client.setHeaders(BEETWEEN_HEADERS);

    const resultsWanted = input.resultsWanted ?? BEETWEEN_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      const pageUrl = careerUrl ?? this.buildPortalUrl(tenant);
      this.logger.log(`Fetching Beetween career page: ${pageUrl}`);

      const html = await this.fetchCareerPage(client, pageUrl);
      if (html == null) {
        this.logger.warn(`Beetween tenant "${tenant || careerUrl}" returned no page`);
        return new JobResponseDto([]);
      }

      const baseUrl = this.originOf(pageUrl);
      const companyName = this.deriveCompanyName(this.parseStateCompany(html), tenant, baseUrl);

      // Prefer an inlined JSON hydration blob; fall back to HTML link-scraping.
      const jobs = this.parseInlineJobs(html);
      if (jobs.length > 0) {
        this.collectJobs(jobs, companyName, baseUrl, input.descriptionFormat, seen, jobPosts);
      } else {
        const offers = this.scrapeOfferLinks(html, baseUrl);
        this.collectOffers(offers, companyName, seen, jobPosts);
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Beetween total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Beetween scrape error for ${tenant || careerUrl}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch the tenant career page HTML; map 4xx to "no jobs" rather than throwing. */
  private async fetchCareerPage(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Beetween career page not found (HTTP ${status}): ${url}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse an inlined JSON hydration blob (if any) into a flat list of jobs.
   * Tolerates several plausible container keys and never throws on bad JSON.
   */
  private parseInlineJobs(html: string): BeetweenJob[] {
    const match = html.match(BEETWEEN_INLINE_STATE_REGEX);
    if (!match || !match[1]) return [];
    let state: BeetweenStatePayload;
    try {
      state = JSON.parse(match[1]) as BeetweenStatePayload;
    } catch {
      return [];
    }
    const containers = [
      state.jobs,
      state.offers,
      state.positions,
      state.results,
      state.items,
    ];
    for (const c of containers) {
      if (Array.isArray(c) && c.length > 0) return c;
    }
    return [];
  }

  /** Read the company name from an inlined hydration blob, if present. */
  private parseStateCompany(html: string): string | null {
    const match = html.match(BEETWEEN_INLINE_STATE_REGEX);
    if (!match || !match[1]) return null;
    try {
      const state = JSON.parse(match[1]) as BeetweenStatePayload;
      return state.company ?? state.companyName ?? state.company_name ?? state.tenant ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Scrape server-rendered `/poste/{publicId}-{slug}/` offer links from the HTML.
   * De-duplicates by public id within the scrape itself.
   */
  private scrapeOfferLinks(html: string, baseUrl: string): BeetweenScrapedOffer[] {
    const offers: BeetweenScrapedOffer[] = [];
    const seen = new Set<string>();
    const regex = new RegExp(BEETWEEN_OFFER_LINK_REGEX.source, BEETWEEN_OFFER_LINK_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      const publicId = (m[1] || '').toLowerCase();
      const slug = m[2] || '';
      if (!publicId || seen.has(publicId)) continue;
      seen.add(publicId);
      offers.push({
        publicId,
        slug,
        url: `${baseUrl}/poste/${publicId}-${slug}/`,
        title: this.titleFromSlug(slug),
      });
    }
    return offers;
  }

  /** Map inlined-JSON jobs → JobPostDto, de-duplicating by public id. */
  private collectJobs(
    jobs: BeetweenJob[],
    companyName: string,
    baseUrl: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, companyName, baseUrl, format);
        if (!post) continue;
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Beetween job ${job?.publicId ?? job?.id}: ${err.message}`);
      }
    }
  }

  /** Map HTML-scraped offers → JobPostDto, de-duplicating by public id. */
  private collectOffers(
    offers: BeetweenScrapedOffer[],
    companyName: string,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const offer of offers) {
      try {
        if (seen.has(offer.publicId)) continue;
        const title = offer.title;
        if (!title) continue;
        seen.add(offer.publicId);
        out.push(
          new JobPostDto({
            id: `beetween-${offer.publicId}`,
            title,
            companyName,
            jobUrl: offer.url,
            location: null,
            description: null,
            datePosted: null,
            isRemote: /remote|t[ée]l[ée]travail/i.test(title),
            emails: null,
            site: Site.BEETWEEN,
            atsId: offer.publicId,
            atsType: 'beetween',
            department: null,
            employmentType: null,
            applyUrl: offer.url,
          }),
        );
      } catch (err: any) {
        this.logger.warn(`Error processing Beetween offer ${offer?.publicId}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: BeetweenJob,
    companyName: string,
    baseUrl: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title ?? job.name ?? job.label;
    if (!title) return null;

    const atsId = String(
      job.publicId ?? job.public_id ?? job.id ?? job.reference ?? '',
    ).toLowerCase();
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, atsId, baseUrl);
    if (!jobUrl) return null;

    const rawHtml = job.descriptionHtml ?? job.description_html ?? job.description ?? job.content ?? null;
    const rawText = job.descriptionText ?? job.description_text ?? null;
    const description = this.formatDescription(rawHtml, rawText, format);

    return new JobPostDto({
      id: `beetween-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(
        job.publishedAt ?? job.published_at ?? job.datePosted ?? job.date ?? job.updatedAt ?? job.updated_at,
      ),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.BEETWEEN,
      atsId,
      atsType: 'beetween',
      department: this.extractDepartment(job),
      employmentType:
        job.contractType ?? job.contract_type ?? job.employmentType ?? job.employment_type ?? job.contract ?? null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. Prefer the HTML body so
   * markdown / plain conversion is consistent, falling back to a pre-stripped
   * plain-text body when HTML is absent.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html);
    }
    if (text) {
      return text;
    }
    return null;
  }

  /**
   * Resolve the Beetween tenant from an explicit `companySlug` or from a
   * `companyUrl`. A `companySlug` maps to the Beetween-hosted portal path
   * (`/WeaselWeb/p/{slug}`). A `companyUrl` is treated as a vanity career domain
   * and used verbatim as the page to fetch.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { tenant: string; careerUrl: string | null } {
    const slug = companySlug && companySlug.trim() ? companySlug.trim() : '';

    if (companyUrl && companyUrl.trim()) {
      try {
        const u = new URL(companyUrl.trim());
        // A vanity career domain: fetch it directly. Derive a tenant label from
        // the first meaningful host segment for company-name / logging purposes.
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        const first = labels.find((l) => l && l !== 'www' && l !== 'recrutement' && l !== 'emploi') ?? labels[0] ?? '';
        return { tenant: slug || first || '', careerUrl: u.toString() };
      } catch {
        // Malformed URL — fall back to the slug path below.
      }
    }

    if (slug) {
      return { tenant: slug, careerUrl: null };
    }
    return { tenant: '', careerUrl: null };
  }

  /** Build the canonical Beetween-hosted career-portal URL for a tenant slug. */
  private buildPortalUrl(tenant: string): string {
    const path = BEETWEEN_PORTAL_PATH_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    return `${BEETWEEN_PORTAL_HOST}${path}`;
  }

  /** Build the public job-detail / apply URL for a single role. */
  private buildJobUrl(job: BeetweenJob, atsId: string, baseUrl: string): string | null {
    const explicit = job.url ?? job.link ?? job.applyUrl ?? job.apply_url;
    if (typeof explicit === 'string' && explicit.trim()) {
      const trimmed = explicit.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${baseUrl}${path}`;
    }
    const slug = typeof job.slug === 'string' && job.slug.trim() ? job.slug.trim() : 'offre';
    return `${baseUrl}/poste/${atsId}-${slug}/`;
  }

  /** Origin (scheme + host) of a URL, used to anchor relative offer links. */
  private originOf(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return BEETWEEN_PORTAL_HOST;
    }
  }

  private deriveCompanyName(
    company: string | null | undefined,
    tenant: string,
    baseUrl: string,
  ): string {
    let base = typeof company === 'string' && company.trim() ? company.trim() : tenant;
    if (!base) {
      try {
        base = new URL(baseUrl).host.split('.').filter(Boolean)[0] ?? '';
      } catch {
        base = '';
      }
    }
    base = base || tenant || 'Beetween';
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Extract a LocationDto from a job's free-text / structured location fields. */
  private extractLocation(job: BeetweenJob): LocationDto | null {
    const city = typeof job.city === 'string' && job.city.trim() ? job.city.trim() : null;
    const state =
      (typeof job.region === 'string' && job.region.trim() ? job.region.trim() : null) ??
      (typeof job.state === 'string' && job.state.trim() ? job.state.trim() : null);
    const country = typeof job.country === 'string' && job.country.trim() ? job.country.trim() : null;
    if (!city && !state && !country) {
      const loc = typeof job.location === 'string' ? job.location.trim() : '';
      if (loc) return new LocationDto({ city: loc });
      return null;
    }
    return new LocationDto({ city, state, country });
  }

  /** Use the team / department / first category as the department. */
  private extractDepartment(job: BeetweenJob): string | null {
    const direct = job.department ?? job.team ?? job.category;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (Array.isArray(job.categories)) {
      const cat = job.categories.find((c) => typeof c === 'string' && c.trim());
      if (cat) return cat.trim();
    }
    return null;
  }

  /** Detect remote / télétravail roles from explicit flags or free-text fields. */
  private detectRemote(job: BeetweenJob): boolean {
    if (job.remote === true || job.isRemote === true || job.teleworking === true) return true;
    const haystacks: Array<string | null | undefined> = [
      job.location,
      job.city,
      job.region,
      job.title ?? job.name ?? job.label,
      job.contractType ?? job.contract_type ?? job.employmentType ?? job.employment_type,
    ];
    if (Array.isArray(job.tags)) haystacks.push(...job.tags);
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('télétravail') ||
        v.includes('teletravail') ||
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Humanise a URL slug into a provisional title (Title Case, dashes → spaces). */
  private titleFromSlug(slug: string): string | null {
    const cleaned = slug.replace(/[-_]+/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Parse an ISO-8601 (or other Date-parsable) string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
