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
  FLATCHR_CAREERS_HOST,
  FLATCHR_COMPANY_JSON_TEMPLATE,
  FLATCHR_VACANCY_PAGE_TEMPLATE,
  FLATCHR_DEFAULT_RESULTS,
  FLATCHR_REMOTE_NONE,
  FLATCHR_HEADERS,
} from './flatchr.constants';
import {
  FlatchrListResponse,
  FlatchrListItem,
  FlatchrVacancy,
  FlatchrAddress,
} from './flatchr.types';

/**
 * Flatchr hosted career-site scraper — generic, multi-tenant.
 *
 * Flatchr is a French SaaS recruitment / applicant-tracking platform. Every
 * customer tenant gets a public, branded career site under a per-tenant
 * company slug on the shared host `careers.flatchr.io`. The scraper fetches the
 * tenant's public, anonymous JSON vacancy listing:
 *
 *   GET https://careers.flatchr.io/company/{slug}.json
 *     → `{ items: FlatchrListItem[] }` for a known tenant
 *     → HTTP 404 `{ message: "Not available for slug …" }` for unknown slug
 *
 * No authentication is required. The listing already embeds the FULL vacancy
 * record for each role — including the multi-part HTML description
 * (`description` + `mission` + `profile`), structured `address`, contract type,
 * `metier` (department), the `remote` flag, salary range and the company name —
 * so NO per-vacancy detail fan-out is needed: one request returns everything.
 *
 * The company slug is resolved from `input.companySlug` or derived from
 * `input.companyUrl`. A missing tenant, an HTTP error, or a malformed payload
 * degrades to an empty/partial result rather than throwing, so a single tenant
 * never aborts a batch run.
 */
@SourcePlugin({
  site: Site.FLATCHR,
  name: 'Flatchr',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class FlatchrService implements IScraper {
  private readonly logger = new Logger(FlatchrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Flatchr scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(input.companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Flatchr company slug from input');
      return new JobResponseDto([]);
    }

    const fallbackCompanyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FLATCHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? FLATCHR_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Flatchr vacancies for slug: ${slug}`);

      const items = await this.fetchListing(client, slug);
      if (items === null) {
        this.logger.warn(`Flatchr tenant not found or no listing for slug: ${slug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Flatchr listing returned ${items.length} items for ${slug}`);

      for (const item of items) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, slug, fallbackCompanyName, input.descriptionFormat);
          if (!post) continue;
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Flatchr vacancy ${item?.vacancy?.id ?? '?'}: ${err.message}`,
          );
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Flatchr total: ${trimmed.length} jobs for ${fallbackCompanyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Flatchr scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch the public JSON listing for a tenant slug.
   * Returns the array of items, or null when the tenant is unknown (HTTP 404 /
   * a `{ message }` error body / a non-array payload).
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<FlatchrListItem[] | null> {
    const url = `${FLATCHR_CAREERS_HOST}${FLATCHR_COMPANY_JSON_TEMPLATE.replace(
      '{slug}',
      encodeURIComponent(slug),
    )}`;
    try {
      const response = await client.get<FlatchrListResponse>(url);
      const body = response.data ?? {};
      if (!Array.isArray(body.items)) {
        // Unknown tenant returns `{ message: "Not available for slug …" }`.
        this.logger.warn(
          `Flatchr: no items array for slug "${slug}"${
            body.message ? ` (${body.message})` : ''
          }`,
        );
        return null;
      }
      return body.items;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        this.logger.warn(`Flatchr tenant not found (HTTP ${status}) for "${slug}"`);
        return null;
      }
      throw err;
    }
  }

  /** Map one listing item to a `JobPostDto`; returns null for invalid items. */
  private processItem(
    item: FlatchrListItem,
    slug: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const vacancy = item.vacancy;
    if (!vacancy) return null;

    const title = vacancy.title?.trim();
    if (!title) return null;

    const atsId = this.resolveAtsId(item, vacancy);
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(slug, vacancy);
    const rawDescription = this.mergeDescription(vacancy);
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

    const companyName = vacancy.company?.name?.trim() || fallbackCompanyName;
    const department = vacancy.metier?.trim() || vacancy.activity?.trim() || null;
    const applyUrl = vacancy.apply_url?.trim() || jobUrl;

    return new JobPostDto({
      id: `flatchr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(vacancy.address),
      description,
      datePosted: this.parseDate(vacancy.created_at ?? item.created_at),
      isRemote: this.detectRemote(vacancy),
      emails: extractEmails(description),
      site: Site.FLATCHR,
      atsId,
      atsType: 'flatchr',
      department,
      applyUrl,
    });
  }

  /**
   * Resolve the tenant company slug from an explicit slug or a career-site URL.
   * For a `careers.flatchr.io/.../company/{slug}/...` URL the slug is the path
   * segment after `company`; otherwise we fall back to the first sub-domain
   * label of a tenant custom domain.
   */
  private resolveSlug(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        const companyIdx = segments.findIndex((s) => s === 'company');
        if (companyIdx >= 0 && segments[companyIdx + 1]) {
          return decodeURIComponent(segments[companyIdx + 1]);
        }
        // Custom domain — use the first non-"www"/"careers" sub-domain label.
        const labels = u.hostname.split('.').filter(Boolean);
        const label = labels.find((l) => l !== 'www' && l !== 'careers');
        if (label) return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL for a vacancy. */
  private buildJobUrl(slug: string, vacancy: FlatchrVacancy): string {
    const vacancySlug = vacancy.slug?.trim();
    if (!vacancySlug) {
      return `${FLATCHR_CAREERS_HOST}/company/${encodeURIComponent(slug)}/`;
    }
    const path = FLATCHR_VACANCY_PAGE_TEMPLATE.replace(
      '{slug}',
      encodeURIComponent(slug),
    ).replace('{vacancySlug}', encodeURIComponent(vacancySlug));
    return `${FLATCHR_CAREERS_HOST}${path}`;
  }

  /**
   * Resolve a stable ATS id for a vacancy, preferring the opaque alphanumeric
   * `vacancy.id`, then the numeric `vacancy_id`, then the leading token of the
   * vacancy slug.
   */
  private resolveAtsId(item: FlatchrListItem, vacancy: FlatchrVacancy): string {
    if (vacancy.id) return String(vacancy.id);
    if (vacancy.vacancy_id != null) return String(vacancy.vacancy_id);
    if (item.vacancy_id != null) return String(item.vacancy_id);
    const slugToken = vacancy.slug?.split('-')[0]?.trim();
    return slugToken || '';
  }

  /**
   * Merge the multi-part vacancy HTML (`description`, `mission`, `profile`)
   * into a single HTML blob. Returns null when all parts are empty.
   */
  private mergeDescription(vacancy: FlatchrVacancy): string | null {
    const parts: string[] = [];
    for (const part of [vacancy.description, vacancy.mission, vacancy.profile]) {
      if (part && part.trim()) parts.push(part.trim());
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Map a structured Flatchr address to a `LocationDto`. */
  private extractLocation(address: FlatchrAddress | null | undefined): LocationDto | null {
    if (!address) return null;
    const city = address.locality?.trim() || null;
    const state = address.administrative_area_level_1?.trim() || null;
    const country = address.country?.trim() || null;
    if (!city && !state && !country) {
      // Fall back to parsing the formatted single-line address.
      const formatted = address.formatted_address?.trim();
      if (formatted) {
        return new LocationDto({ city: formatted, state: null, country: null });
      }
      return null;
    }
    return new LocationDto({ city, state, country });
  }

  /**
   * Detect remote roles. The `remote` enum string `"notime"` means on-site
   * only; any other non-empty value, the `partial` flag, or a "remote" /
   * "télétravail" keyword in the title indicates remote capability.
   */
  private detectRemote(vacancy: FlatchrVacancy): boolean {
    const remote = vacancy.remote?.trim().toLowerCase();
    if (remote && remote !== FLATCHR_REMOTE_NONE) return true;
    const title = vacancy.title?.toLowerCase() ?? '';
    if (
      title.includes('remote') ||
      title.includes('télétravail') ||
      title.includes('teletravail') ||
      title.includes('work from home')
    ) {
      return true;
    }
    return false;
  }

  /** Derive a human-readable company name from the slug (fallback only). */
  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse an ISO-8601 timestamp (e.g. `"2026-05-22T09:41:08.255Z"`) into a
   * `YYYY-MM-DD` string. Returns null for null/undefined or unparseable input.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
