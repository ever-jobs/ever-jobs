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
  WEBCRUITER_HOST,
  WEBCRUITER_ADVERT_SEARCH_PATH_TEMPLATE,
  WEBCRUITER_COMPANY_META_PATH_TEMPLATE,
  WEBCRUITER_DEFAULT_LANGUAGE,
  WEBCRUITER_PUBLIC_ADVERT_BASE_TEMPLATE,
  WEBCRUITER_DEFAULT_RESULTS,
  WEBCRUITER_HEADERS,
} from './webcruiter.constants';
import {
  WebcruiterAdvert,
  WebcruiterAdvertSearchResponse,
  WebcruiterCompanyMeta,
} from './webcruiter.types';

/**
 * Webcruiter ATS careers scraper — generic, multi-tenant.
 *
 * Webcruiter (a Norwegian / Nordic ATS operated by Talentech) serves every
 * customer's open roles through one shared public candidate portal at
 * `candidate.webcruiter.com`. A tenant is addressed by its numeric "company
 * lock" id (the `companyLock` value on the public portal). Two public,
 * unauthenticated JSON endpoints on that host back the portal:
 *
 *   - `POST /api/odvert/companysearch/{companyLock}` — the open-roles list
 *     (body `{ take, skip }`; paging only). Returns `{ Total, Data[] }`.
 *   - `GET  /api/company/companymeta/{companyLock}`  — tenant display name/logo.
 *
 * The company lock is taken from `companySlug` or derived from a `companyUrl`
 * (its `companyLock` query param, else the first numeric path/sub-domain token).
 * A single fetch error, an unknown company lock (which the search endpoint
 * answers with `{ Total: 0, Data: [] }`), or a malformed payload degrades to an
 * empty result rather than throwing — one bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.WEBCRUITER,
  name: 'Webcruiter',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WebcruiterService implements IScraper {
  private readonly logger = new Logger(WebcruiterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Webcruiter scraper');
      return new JobResponseDto([]);
    }

    const companyLock = this.resolveCompanyLock(companySlug, input.companyUrl);
    if (!companyLock) {
      this.logger.warn('Could not resolve a Webcruiter company lock from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(WEBCRUITER_HEADERS);

    const language = WEBCRUITER_DEFAULT_LANGUAGE;
    const resultsWanted = input.resultsWanted ?? WEBCRUITER_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Webcruiter jobs for company lock: ${companyLock}`);

      // Prefer the tenant's clean display name from company metadata; fall back
      // to the advert payload / a derived name when it is unavailable.
      const meta = await this.fetchCompanyMeta(client, companyLock, language);
      const metaName =
        typeof meta?.CompanyName === 'string' && meta.CompanyName.trim()
          ? meta.CompanyName.trim()
          : null;

      // The search endpoint returns the full open-roles list in one page when we
      // request `take = resultsWanted`; there is no incremental cursor.
      const envelope = await this.fetchAdverts(client, companyLock, language, resultsWanted);
      const adverts = Array.isArray(envelope?.Data) ? envelope!.Data! : [];

      const fallbackName = metaName ?? this.deriveCompanyName(adverts, companyLock);
      this.collect(adverts, companyLock, fallbackName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Webcruiter total: ${trimmed.length} jobs for ${fallbackName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Webcruiter scrape error for ${companyLock}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the tenant's open-roles page from the public advert-search endpoint. */
  private async fetchAdverts(
    client: ReturnType<typeof createHttpClient>,
    companyLock: string,
    language: string,
    take: number,
  ): Promise<WebcruiterAdvertSearchResponse | null> {
    const path = WEBCRUITER_ADVERT_SEARCH_PATH_TEMPLATE.replace(
      '{companyLock}',
      encodeURIComponent(companyLock),
    );
    const url = `${WEBCRUITER_HOST}${path}?language=${encodeURIComponent(language)}`;
    // The endpoint is POST-only; the body carries paging only (`take`/`skip`).
    const body = { take: Math.max(1, take), skip: 0 };
    try {
      const response = await client.post<WebcruiterAdvertSearchResponse>(url, body);
      const data = response.data;
      if (!data || !Array.isArray(data.Data)) {
        this.logger.warn(`Webcruiter advert search for "${companyLock}" returned no Data array`);
        return null;
      }
      return data;
    } catch (err: any) {
      // An unknown / dead company lock normally answers HTTP 200 with
      // { Total: 0, Data: [] }; a 4xx is still treated as "no jobs" here.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Webcruiter company lock "${companyLock}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Fetch tenant metadata (display name) — best-effort; never fatal. */
  private async fetchCompanyMeta(
    client: ReturnType<typeof createHttpClient>,
    companyLock: string,
    language: string,
  ): Promise<WebcruiterCompanyMeta | null> {
    const path = WEBCRUITER_COMPANY_META_PATH_TEMPLATE.replace(
      '{companyLock}',
      encodeURIComponent(companyLock),
    );
    const url = `${WEBCRUITER_HOST}${path}?language=${encodeURIComponent(language)}`;
    try {
      const response = await client.get<WebcruiterCompanyMeta>(url);
      return response.data ?? null;
    } catch (err: any) {
      // Metadata is optional polish; a failure must not break the job list.
      this.logger.warn(`Webcruiter company meta unavailable for "${companyLock}": ${err.message}`);
      return null;
    }
  }

  /** Map raw adverts → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    adverts: WebcruiterAdvert[],
    companyLock: string,
    fallbackName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const advert of adverts) {
      try {
        const post = this.processAdvert(advert, companyLock, fallbackName, format);
        if (!post) continue;
        // processAdvert guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Webcruiter advert ${advert?.Id}: ${err.message}`);
      }
    }
  }

  private processAdvert(
    advert: WebcruiterAdvert,
    companyLock: string,
    fallbackName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = this.cleanString(advert.Heading);
    if (!title) return null;

    const atsId = String(advert.Id ?? advert.id ?? '').trim();
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(advert, companyLock, atsId);
    const applyUrl = this.buildApplyUrl(advert);

    const companyName = this.cleanString(advert.CompanyName) ?? fallbackName;

    const rawDescription = this.cleanString(advert.Presentation);
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    return new JobPostDto({
      id: `webcruiter-${atsId}`,
      title,
      companyName,
      jobUrl,
      jobUrlDirect: jobUrl,
      location: this.extractLocation(advert),
      description,
      datePosted: this.parseDate(advert.PublishedDate ?? advert.PublishedIntranetDate),
      isRemote: this.detectRemote(advert),
      emails: extractEmails(description),
      site: Site.WEBCRUITER,
      atsId,
      atsType: 'webcruiter',
      department: this.extractDepartment(advert),
      employmentType: this.cleanString(advert.JobType),
      applyUrl,
    });
  }

  /**
   * Resolve the Webcruiter company lock from an explicit `companySlug` or from a
   * `companyUrl` (its `companyLock`/`companylock` query param, else the first
   * numeric path segment, else the first numeric sub-domain label).
   */
  private resolveCompanyLock(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Preferred: the explicit `companyLock` query parameter (case-insensitive).
        for (const [key, value] of u.searchParams.entries()) {
          if (key.toLowerCase() === 'companylock' && value && value.trim()) {
            return value.trim();
          }
        }
        // Else the first numeric path segment (a bare lock id in the path).
        const segments = u.pathname.split('/').filter(Boolean);
        const numericSegment = segments.find((s) => /^\d+$/.test(s));
        if (numericSegment) return numericSegment;
        // Else a numeric leading sub-domain label (e.g. `23109900.webcruiter.no`).
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (/^\d+$/.test(label)) return label;
      } catch {
        // Malformed URL — no company lock recoverable.
      }
    }
    return '';
  }

  /** Use the feed's absolute `OpenAdvertUrl`; build a fallback when it is absent. */
  private buildJobUrl(advert: WebcruiterAdvert, companyLock: string, atsId: string): string {
    const open = this.cleanString(advert.OpenAdvertUrl);
    if (open && /^https?:\/\//i.test(open)) return open;
    return WEBCRUITER_PUBLIC_ADVERT_BASE_TEMPLATE.replace(
      '{companyLock}',
      encodeURIComponent(companyLock),
    ).replace('{advertId}', encodeURIComponent(atsId));
  }

  /** Resolve the apply URL — the feed's `ApplyUrl` is relative to the portal host. */
  private buildApplyUrl(advert: WebcruiterAdvert): string | null {
    const apply = this.cleanString(advert.ApplyUrl);
    if (!apply) return this.cleanString(advert.OpenAdvertUrl);
    if (/^https?:\/\//i.test(apply)) return apply;
    const path = apply.startsWith('/') ? apply : `/${apply}`;
    return `${WEBCRUITER_HOST}${path}`;
  }

  /** Derive a display name from the first advert's `CompanyName`, else the lock. */
  private deriveCompanyName(adverts: WebcruiterAdvert[], companyLock: string): string {
    for (const advert of adverts) {
      const name = this.cleanString(advert.CompanyName);
      if (name) return name;
    }
    return companyLock;
  }

  /**
   * Webcruiter exposes workplace as increasingly specific free-text fields
   * (`Workplace3` most specific) plus a country-less facet. We surface the most
   * specific non-empty value as the city; state/country are not provided.
   */
  private extractLocation(advert: WebcruiterAdvert): LocationDto | null {
    const city =
      this.cleanString(advert.Workplace3) ??
      this.cleanString(advert.Workplace2) ??
      this.cleanString(advert.Workplace);
    if (!city) return null;
    return new LocationDto({ city });
  }

  /** Department best-effort: the workplace facet (organisational unit). */
  private extractDepartment(advert: WebcruiterAdvert): string | null {
    return (
      this.cleanString(advert.WorkPlaceFacet) ?? this.cleanString(advert.JobCategory)
    );
  }

  /** Detect remote roles from the workplace / title text (best-effort). */
  private detectRemote(advert: WebcruiterAdvert): boolean {
    const haystacks = [
      advert.Workplace,
      advert.Workplace2,
      advert.Workplace3,
      advert.Heading,
      advert.JobType,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('hjemmekontor') || // Norwegian: "home office"
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse Webcruiter's `DD.MM.YYYY` display dates (and ISO strings, defensively)
   * into a `YYYY-MM-DD` string.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    // Primary: `DD.MM.YYYY`.
    const dmy = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    // Fallback: any Date-parseable string (e.g. ISO-8601).
    try {
      const parsed = new Date(trimmed);
      if (!isNaN(parsed.getTime())) return toDateOnly(trimmed);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a value to a non-empty string, else null. */
  private cleanString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }
}
