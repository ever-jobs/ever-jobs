import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
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
  REACHMEE_FEED_HOST_TEMPLATE,
  REACHMEE_ROOT_DOMAIN,
  REACHMEE_RSS_PATH,
  REACHMEE_DEFAULT_SITE_HOST,
  REACHMEE_DEFAULT_INSTALLATION_ID,
  REACHMEE_DEFAULT_SITE_ID,
  REACHMEE_DEFAULT_LANG,
  REACHMEE_DEFAULT_RESULTS,
  REACHMEE_HEADERS,
  REACHMEE_ITEM_REGEX,
  REACHMEE_TAG_REGEX_TEMPLATE,
  REACHMEE_LINK_JOB_ID_REGEX,
  REACHMEE_SLUG_REGEX,
  REACHMEE_REMOTE_REGEX,
} from './reachmee.constants';
import { ReachMeeFeed, ReachMeeTarget, ReachMeeVacancy } from './reachmee.types';

/**
 * ReachMee (Talentech) ATS careers scraper — generic, multi-tenant.
 *
 * ReachMee (reachmee.com, Nordic ATS — part of Talentech) hosts each customer
 * "installation" on numbered ReachMee hosts: the public career page lives on
 * `web{NNN}.reachmee.com` and the structured, unauthenticated open-roles surface
 * is the per-installation RSS export handler on `site{NNN}.reachmee.com`
 * (`GET /Public/rssfeed/external.ashx?id={siteId}&InstallationID={installationId}&CustomerName={customer}&lang={lang}`),
 * which returns every published vacancy in one envelope — there is no server-side
 * pagination, so we fetch once and slice client-side to honour `resultsWanted`.
 *
 * The caller addresses an installation by a full `companyUrl` (any ReachMee feed
 * / career URL on a `*.reachmee.com` host — its `CustomerName`, `InstallationID`,
 * site `id` and `site{NNN}` host are read verbatim from the query string / host)
 * or by a structured `companySlug` of the form `{customer}@{installationId}:{siteId}`
 * with an optional `#site{NNN}` host hint (e.g. `oru@I003:12#site106`). A single
 * fetch error, an unknown installation (HTTP 4xx), or a malformed / non-XML
 * payload degrades to an empty result rather than throwing, so a single tenant
 * never nukes a batch run.
 */
@SourcePlugin({
  site: Site.REACHMEE,
  name: 'ReachMee',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ReachMeeService implements IScraper {
  private readonly logger = new Logger(ReachMeeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for ReachMee scraper');
      return new JobResponseDto([]);
    }

    const target = this.resolveTarget(companySlug, input.companyUrl);
    if (!target) {
      this.logger.warn('Could not resolve a ReachMee installation from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(REACHMEE_HEADERS);

    const resultsWanted = input.resultsWanted ?? REACHMEE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      const url = this.buildFeedUrl(target);
      this.logger.log(`Fetching ReachMee jobs from: ${url}`);

      // The RSS export returns every published vacancy for the installation at once.
      const feed = await this.fetchFeed(client, url);
      if (!feed) {
        this.logger.warn(`ReachMee feed for "${target.customerName || target.installationId}" returned no vacancies`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveCompanyName(target);
      this.collect(feed.vacancies, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`ReachMee total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`ReachMee scrape error for ${target.installationId}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Build the public RSS export URL from the resolved target coordinates. */
  private buildFeedUrl(target: ReachMeeTarget): string {
    const host = REACHMEE_FEED_HOST_TEMPLATE.replace('{site}', encodeURIComponent(target.siteHost));
    const params = new URLSearchParams({
      id: target.siteId,
      InstallationID: target.installationId,
      lang: target.lang,
    });
    // Some public sites omit CustomerName; only include it when present.
    if (target.customerName) params.set('CustomerName', target.customerName);
    return `${host}${REACHMEE_RSS_PATH}?${params.toString()}`;
  }

  /** Fetch and parse the installation's RSS vacancy export. */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<ReachMeeFeed | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const xml = typeof response.data === 'string' ? response.data : '';
      if (!xml || !/<item\b/i.test(xml)) {
        this.logger.warn(`ReachMee feed "${url}" returned no parseable items`);
        return null;
      }
      return this.parseFeed(xml);
    } catch (err: any) {
      // An unknown installation / disabled feed returns HTTP 404 (or other 4xx);
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`ReachMee feed "${url}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Parse RSS XML into a normalised feed (vacancies with decoded fields). */
  private parseFeed(xml: string): ReachMeeFeed {
    const vacancies: ReachMeeVacancy[] = [];
    REACHMEE_ITEM_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REACHMEE_ITEM_REGEX.exec(xml)) !== null) {
      const block = match[1] ?? '';
      vacancies.push({
        title: this.extractTag(block, 'title'),
        commAdSeqNo: this.extractTag(block, 'CommAdSeqNo'),
        link: this.extractTag(block, 'link'),
        description: this.extractTag(block, 'description'),
        area1: this.extractTag(block, 'Area1'),
        area2: this.extractTag(block, 'Area2'),
        country: this.extractTag(block, 'country'),
        occupationArea: this.extractTag(block, 'occupationArea'),
        position: this.extractTag(block, 'Position'),
        org1: this.extractTag(block, 'Org1'),
        org2: this.extractTag(block, 'Org2'),
        org3: this.extractTag(block, 'Org3'),
        workingHours: this.extractTag(block, 'workingHours'),
        employmentLevel: this.extractTag(block, 'employmentLevel'),
        pubDate: this.extractTag(block, 'pubDate'),
        pubDateTo: this.extractTag(block, 'pubDateTo'),
      });
    }
    return {
      title: this.extractTag(xml, 'title'),
      vacancies,
    };
  }

  /** Map raw vacancies → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    vacancies: ReachMeeVacancy[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const vacancy of vacancies) {
      try {
        const post = this.processVacancy(vacancy, companyName, format);
        if (!post) continue;
        // processVacancy guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing ReachMee vacancy "${vacancy?.title}": ${err.message}`);
      }
    }
  }

  private processVacancy(
    vacancy: ReachMeeVacancy,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = vacancy.title;
    if (!title) return null;

    const atsId = String(vacancy.commAdSeqNo ?? this.extractJobIdFromLink(vacancy.link) ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(vacancy);
    if (!jobUrl) return null;

    const rawHtml = vacancy.description ?? null;
    const description = this.formatDescription(rawHtml, format);

    return new JobPostDto({
      id: `reachmee-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(vacancy),
      description,
      datePosted: this.parseDate(vacancy.pubDate ?? vacancy.pubdate),
      isRemote: this.detectRemote(vacancy),
      emails: extractEmails(description),
      site: Site.REACHMEE,
      atsId,
      atsType: 'reachmee',
      department: this.extractDepartment(vacancy),
      employmentType: this.extractEmploymentType(vacancy),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The RSS `<description>` is
   * an HTML-encoded body (entities decoded during parse); we surface it as HTML,
   * Markdown, or plain text on request, defaulting to plain text.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the installation target. A `companyUrl` on a `*.reachmee.com` host
   * has its `CustomerName`, `InstallationID`, site `id`, `lang` and `site{NNN}`
   * host read from the query string / host (a `web{NNN}` career host falls back
   * to the default `site{NNN}` export host). A structured `companySlug`
   * (`{customer}@{installationId}:{siteId}#site{NNN}`) supplies the same
   * coordinates, defaulting any omitted part. Returns null when neither yields a
   * usable installation id.
   */
  private resolveTarget(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): ReachMeeTarget | null {
    if (companyUrl) {
      const fromUrl = this.targetFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    if (companySlug && companySlug.trim()) {
      return this.targetFromSlug(companySlug.trim());
    }
    return null;
  }

  /** Parse a `*.reachmee.com` feed / career URL into a target. */
  private targetFromUrl(companyUrl: string): ReachMeeTarget | null {
    try {
      const u = new URL(companyUrl);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(REACHMEE_ROOT_DOMAIN)) return null;

      const params = u.searchParams;
      const customerName = params.get('CustomerName') ?? '';
      // The feed uses `id`; the career `web{NNN}` URLs use `site` for the same value.
      const siteId = params.get('id') ?? params.get('site') ?? REACHMEE_DEFAULT_SITE_ID;
      const installationId =
        params.get('InstallationID') ??
        this.extractInstallationFromPath(u.pathname) ??
        REACHMEE_DEFAULT_INSTALLATION_ID;
      const lang = params.get('lang') ?? REACHMEE_DEFAULT_LANG;

      // Use the `site{NNN}` export host directly when given one; a `web{NNN}`
      // career host cannot serve the feed, so fall back to the default export host.
      const siteHostMatch = hostname.match(/^site([0-9]+)\.reachmee\.com$/i);
      const siteHost = siteHostMatch ? siteHostMatch[1] : REACHMEE_DEFAULT_SITE_HOST;

      if (!installationId) return null;
      return { siteHost, customerName, installationId, siteId, lang };
    } catch {
      // Malformed URL — fall through to the slug.
      return null;
    }
  }

  /** Parse a structured `{customer}@{installationId}:{siteId}#site{NNN}` slug. */
  private targetFromSlug(slug: string): ReachMeeTarget | null {
    const m = slug.match(REACHMEE_SLUG_REGEX);
    if (!m) return null;
    const customerName = (m[1] ?? '').trim();
    const installationId = (m[2] ?? '').trim() || REACHMEE_DEFAULT_INSTALLATION_ID;
    const siteId = (m[3] ?? '').trim() || REACHMEE_DEFAULT_SITE_ID;
    const siteHost = (m[4] ?? '').trim() || REACHMEE_DEFAULT_SITE_HOST;
    if (!customerName && !installationId) return null;
    return {
      siteHost,
      customerName,
      installationId,
      siteId,
      lang: REACHMEE_DEFAULT_LANG,
    };
  }

  /** Mine the installation id (`I003`) from a career URL path (`/ext/I003/354/main`). */
  private extractInstallationFromPath(pathname: string): string | null {
    const m = pathname.match(/\/ext\/(I[0-9]+)\b/i);
    return m ? m[1] : null;
  }

  /** Build the public apply / vacancy-detail URL from the item's `<link>`. */
  private buildJobUrl(vacancy: ReachMeeVacancy): string | null {
    const link = vacancy.link ?? vacancy.url;
    if (typeof link === 'string' && link.trim()) {
      const trimmed = link.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
    }
    return null;
  }

  /** Extract the `rmjob=` id from a canonical `<link>`, used as a fallback ATS id. */
  private extractJobIdFromLink(link: string | null | undefined): string | null {
    if (!link) return null;
    const m = link.match(REACHMEE_LINK_JOB_ID_REGEX);
    return m ? m[1] : null;
  }

  private deriveCompanyName(target: ReachMeeTarget): string {
    const base =
      target.customerName && target.customerName.trim()
        ? target.customerName.trim()
        : target.installationId;
    return (base || target.installationId)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * ReachMee items expose a structured location across `<Area1>` (city / primary
   * area), `<Area2>` (region) and `<country>`. We surface the most specific area
   * as the city, the secondary area as the state/region, and the country, leaving
   * fields null when nothing usable is present (never fabricated).
   */
  private extractLocation(vacancy: ReachMeeVacancy): LocationDto | null {
    const city = this.cleanText(vacancy.area1);
    const region = this.cleanText(vacancy.area2);
    const country = this.cleanText(vacancy.country);
    if (!city && !region && !country) return null;
    return new LocationDto({
      city: city ?? region,
      state: city ? region : null,
      country,
    });
  }

  /**
   * Use the organisation-unit hierarchy (`<Org1>` → `<Org2>` → `<Org3>`) as the
   * department, falling back to the `<occupationArea>` role family when no org
   * unit is published.
   */
  private extractDepartment(vacancy: ReachMeeVacancy): string | null {
    return (
      this.cleanText(vacancy.org1) ??
      this.cleanText(vacancy.org2) ??
      this.cleanText(vacancy.org3) ??
      this.cleanText(vacancy.occupationArea)
    );
  }

  /**
   * Use the `<employmentLevel>` label (e.g. "Fixed-term position", "Permanent")
   * as the employment type, falling back to the `<workingHours>` label
   * (e.g. "Day", "Full-time") when no level is published.
   */
  private extractEmploymentType(vacancy: ReachMeeVacancy): string | null {
    return this.cleanText(vacancy.employmentLevel) ?? this.cleanText(vacancy.workingHours);
  }

  /** Detect remote roles from the title, areas, org units, or description body. */
  private detectRemote(vacancy: ReachMeeVacancy): boolean {
    const haystacks: Array<string | null | undefined> = [
      vacancy.title,
      vacancy.area1,
      vacancy.area2,
      vacancy.position,
      vacancy.occupationArea,
      vacancy.org1,
      vacancy.description,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (REACHMEE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse an RFC-822 / ISO-8601 string into a YYYY-MM-DD string. */
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

  /** Extract and decode the inner text of the first matching child element. */
  private extractTag(block: string, tag: string): string | null {
    const re = new RegExp(REACHMEE_TAG_REGEX_TEMPLATE.replace(/\{tag\}/g, tag), 'i');
    const m = block.match(re);
    if (!m) return null;
    return this.cleanValue(m[1]);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Strip CDATA wrappers and decode the common XML/HTML entities. */
  private cleanValue(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    let v = raw.trim();
    const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) v = cdata[1];
    v = this.decodeEntities(v).trim();
    return v || null;
  }

  /**
   * Decode the XML/HTML entities the feed emits. The body is double-encoded
   * (e.g. `&lt;p&gt;` for a paragraph), so a single pass yields the inner HTML
   * which we then hand to the description formatter.
   */
  private decodeEntities(input: string): string {
    return input
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&amp;/g, '&');
  }
}
